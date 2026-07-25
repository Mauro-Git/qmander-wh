/**
 * Cliente ligero cTrader Open API — WebSocket + JSON — Multi-tenant
 * ------------------------------------------------------------------
 * Una instancia de CTraderAccount por usuario (BrokerAccount es 1:1 con User).
 * Esta clase es agnóstica de la base de datos: recibe su configuración por
 * constructor. La lectura de BrokerAccount/UserConfig, el desencriptado de
 * tokens y la renovación OAuth viven en accountPool.ts.
 *
 * clientId/clientSecret de la app Spotware son globales (misma app para
 * todos los usuarios). host, accessToken, accountId y symbolMap son por
 * usuario (vienen de BrokerAccount.ctraderHost / UserConfig.symbolMap).
 */

import WebSocket from 'ws'

// ── Payload types (Open API proto enum) ──────────────────────
const PT = {
  HEARTBEAT:             51,
  APP_AUTH_REQ:        2100,
  APP_AUTH_RES:        2101,
  ACCOUNT_AUTH_REQ:    2102,
  ACCOUNT_AUTH_RES:    2103,
  NEW_ORDER_REQ:       2106,
  CLOSE_POSITION_REQ:  2111,
  SYMBOL_LIST_REQ:     2114,
  SYMBOL_LIST_RES:     2115,
  SYMBOL_BY_ID_REQ:    2116,
  SYMBOL_BY_ID_RES:    2117,
  RECONCILE_REQ:       2124,
  RECONCILE_RES:       2125,
  EXECUTION_EVENT:     2126,
  ORDER_ERROR_EVENT:   2132,
  ACCOUNT_DISCONNECT:  2163,
} as const

const ORDER_TYPE_MARKET = 1
const TRADE_SIDE = { buy: 1, sell: 2 } as const

// ProtoOAExecutionType — solo el valor que nos interesa para detectar cierres reales.
const EXECUTION_TYPE_ORDER_FILLED = 3

// ── Tipos ────────────────────────────────────────────────────
interface CTraderMessage {
  clientMsgId?: string
  payloadType: number
  payload: Record<string, unknown>
}

interface PendingRequest {
  resolve: (data: CTraderMessage) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export type SymbolDetails = { symbolId: number; lotSize: number; pipPosition: number }

export interface AccountConfig {
  userId: string
  name: string
  host: string
  accessToken: string
  accountId: number
  symbolMap?: Record<string, string>
  /** Notifica desconexiones inesperadas del WebSocket (no llamadas a close()). */
  onDisconnect?: () => void
  /** Se dispara con el P&L neto real de cada cierre de posición (ExecutionEvent + closePositionDetail). */
  onPositionClosed?: (info: { netPnl: number; balanceAfterClose: number }) => void
}

// ── Configuración global (app Spotware, compartida por todos) ──
const appCfg = {
  clientId:     required('CTRADER_CLIENT_ID'),
  clientSecret: required('CTRADER_CLIENT_SECRET'),
  maxDailyRequests: Number(process.env.MAX_DAILY_REQUESTS ?? 1500),
}

function required(name: string): string {
  const v = process.env[name]
  if (!v) { console.error(`FATAL: falta variable de entorno ${name}`); process.exit(1) }
  return v
}

function utcDay(): string { return new Date().toISOString().slice(0, 10) }

// ── Conversiones numéricas puras (testeadas sin WebSocket) ───

export function volumeFromLots(lots: number, lotSize: number): number {
  return Math.round(lots * lotSize)
}

/**
 * Los montos monetarios de cTrader (grossProfit, swap, commission, balance)
 * vienen como int64 escalados — dividir por 10^moneyDigits para el valor real.
 * Verificado contra ProtoOAClosePositionDetail en el .proto fuente de Spotware.
 */
export function scaleMoney(raw: number, moneyDigits: number): number {
  return raw / Math.pow(10, moneyDigits)
}

/**
 * P&L neto de un cierre de posición. `commission` ya viene con signo negativo
 * (es un costo) en la API, así que sumar (no restar) da el neto correcto.
 */
export function computeNetPnl(cpd: { grossProfit: number; swap: number; commission: number; moneyDigits: number }): number {
  return scaleMoney(cpd.grossProfit, cpd.moneyDigits) + scaleMoney(cpd.swap, cpd.moneyDigits) + scaleMoney(cpd.commission, cpd.moneyDigits)
}

export function relativeFromPips(pips: number, pipPosition: number): number {
  const pipFactor = Math.pow(10, 5 - pipPosition)
  return Math.round(pips * pipFactor)
}

// ── Clase CTraderAccount — una instancia por usuario ─────────

export class CTraderAccount {
  userId: string
  name: string
  host: string
  accountId: number
  accessToken: string
  connected = false

  private symbolMap: Record<string, string>
  private onDisconnect?: () => void
  private onPositionClosed?: (info: { netPnl: number; balanceAfterClose: number }) => void
  private closedByUs = false
  private ws: WebSocket | null = null
  private msgCounter = 0
  private pending = new Map<string, PendingRequest>()
  private symbolIdByName = new Map<string, number>()
  private symbolDetailsCache = new Map<number, SymbolDetails>()
  private dayKey = utcDay()
  private requestCount = 0

  constructor(config: AccountConfig) {
    this.userId = config.userId
    this.name = config.name
    this.host = config.host
    this.accountId = config.accountId
    this.accessToken = config.accessToken
    this.symbolMap = config.symbolMap ?? {}
    this.onDisconnect = config.onDisconnect
    this.onPositionClosed = config.onPositionClosed
  }

  private tag(msg: string): string {
    return `[${this.name}] ${msg}`
  }

  private countTradingRequest(): void {
    const today = utcDay()
    if (today !== this.dayKey) { this.dayKey = today; this.requestCount = 0 }
    this.requestCount += 1
    if (this.requestCount > appCfg.maxDailyRequests) {
      throw new Error(this.tag(`Límite diario de operaciones alcanzado (${appCfg.maxDailyRequests})`))
    }
  }

  private nextMsgId(): string {
    this.msgCounter += 1
    return `${this.accountId}_${Date.now()}_${this.msgCounter}`
  }

  private send(payloadType: number, payload: Record<string, unknown>, timeout = 15_000): Promise<CTraderMessage> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error(this.tag('WebSocket no conectado')))
      }

      // Solo contar operaciones de trading (abrir/cerrar), no consultas
      if (payloadType === PT.NEW_ORDER_REQ || payloadType === PT.CLOSE_POSITION_REQ) {
        this.countTradingRequest()
      }

      const clientMsgId = this.nextMsgId()
      const msg: CTraderMessage = { clientMsgId, payloadType, payload }

      const timer = setTimeout(() => {
        this.pending.delete(clientMsgId)
        reject(new Error(this.tag(`Timeout esperando respuesta a payloadType ${payloadType}`)))
      }, timeout)

      this.pending.set(clientMsgId, { resolve, reject, timer })
      this.ws.send(JSON.stringify(msg))
    })
  }

  private handleMessage(raw: string): void {
    let msg: CTraderMessage
    try { msg = JSON.parse(raw) } catch { return }

    if (msg.payloadType === PT.HEARTBEAT) {
      this.ws?.send(JSON.stringify({ payloadType: PT.HEARTBEAT, payload: {} }))
      return
    }

    if (msg.payloadType === PT.EXECUTION_EVENT) {
      const o = msg.payload.order as Record<string, unknown> | undefined
      const p = msg.payload.position as Record<string, unknown> | undefined
      console.log(this.tag(`[exec] type=${msg.payload.executionType} order=${o?.orderId ?? '-'} pos=${p?.positionId ?? '-'}`))

      const executionType = Number(msg.payload.executionType)
      const deal = msg.payload.deal as Record<string, unknown> | undefined
      const cpd = deal?.closePositionDetail as Record<string, unknown> | undefined
      if (executionType === EXECUTION_TYPE_ORDER_FILLED && cpd) {
        const moneyDigits = cpd.moneyDigits !== undefined ? Number(cpd.moneyDigits)
          : deal?.moneyDigits !== undefined ? Number(deal.moneyDigits) : undefined
        if (moneyDigits === undefined) {
          console.error(this.tag('[dailyPnl] closePositionDetail sin moneyDigits — no se puede escalar el P&L, evento descartado'))
        } else {
          const netPnl = computeNetPnl({
            grossProfit: Number(cpd.grossProfit), swap: Number(cpd.swap), commission: Number(cpd.commission), moneyDigits,
          })
          const balanceAfterClose = scaleMoney(Number(cpd.balance), moneyDigits)
          this.onPositionClosed?.({ netPnl, balanceAfterClose })
        }
      }
    }

    if (msg.payloadType === PT.ORDER_ERROR_EVENT) {
      console.error(this.tag(`[orderError] ${msg.payload.errorCode}: ${msg.payload.description ?? 'sin descripción'}`))
    }

    if (msg.payloadType === PT.ACCOUNT_DISCONNECT) {
      this.connected = false
      console.error(this.tag('Cuenta desconectada por el servidor'))
    }

    if (msg.clientMsgId && this.pending.has(msg.clientMsgId)) {
      const p = this.pending.get(msg.clientMsgId)!
      this.pending.delete(msg.clientMsgId)
      clearTimeout(p.timer)
      if (msg.payload?.errorCode) {
        p.reject(new Error(this.tag(`cTrader error ${msg.payload.errorCode}: ${msg.payload.description ?? ''}`)))
      } else {
        p.resolve(msg)
      }
    }
  }

  async connect(): Promise<void> {
    const url = `wss://${this.host}:5036`

    await new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url)
      this.ws.on('open', () => resolve())
      this.ws.on('error', (err) => reject(new Error(this.tag(`WebSocket error: ${err.message}`))))
      this.ws.on('close', () => {
        this.connected = false
        console.error(this.tag('WebSocket cerrado'))
        if (!this.closedByUs) this.onDisconnect?.()
      })
      this.ws.on('message', (data) => this.handleMessage(data.toString()))
    })

    setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ payloadType: PT.HEARTBEAT, payload: {} }))
      }
    }, 10_000)

    await this.send(PT.APP_AUTH_REQ, {
      clientId: appCfg.clientId,
      clientSecret: appCfg.clientSecret,
    })

    await this.send(PT.ACCOUNT_AUTH_REQ, {
      accessToken: this.accessToken,
      ctidTraderAccountId: this.accountId,
    })

    this.connected = true
    await this.loadSymbols()

    console.log(this.tag(`Conectado a ${url} cuenta ${this.accountId} (${this.symbolIdByName.size} símbolos)`))
  }

  close(): void {
    this.closedByUs = true
    this.ws?.close()
    this.connected = false
  }

  /**
   * UserConfig.symbolMap puede cambiar en el dashboard después de que esta
   * cuenta ya está conectada (a diferencia de allowedSymbols/maxLots/
   * killSwitch, que server.ts relee frescos de la DB en cada alerta). El
   * caller debe pasar el symbolMap vigente antes de resolver un símbolo para
   * que los cambios se reflejen sin tener que reconectar.
   */
  setSymbolMap(symbolMap: Record<string, string>): void {
    this.symbolMap = symbolMap ?? {}
  }

  private async loadSymbols(): Promise<void> {
    const res = await this.send(PT.SYMBOL_LIST_REQ, { ctidTraderAccountId: this.accountId })
    const symbols = (res.payload.symbol as Array<Record<string, unknown>>) ?? []
    for (const s of symbols) {
      this.symbolIdByName.set(String(s.symbolName).toUpperCase(), Number(s.symbolId))
    }
  }

  private async getSymbolDetails(symbolId: number): Promise<SymbolDetails> {
    const cached = this.symbolDetailsCache.get(symbolId)
    if (cached) return cached
    const res = await this.send(PT.SYMBOL_BY_ID_REQ, {
      ctidTraderAccountId: this.accountId,
      symbolId: [symbolId],
    })
    const symbols = (res.payload.symbol as Array<Record<string, unknown>>) ?? []
    const s = symbols[0]
    if (!s) throw new Error(this.tag(`Símbolo ${symbolId} sin detalles`))
    const det: SymbolDetails = {
      symbolId,
      lotSize: Number(s.lotSize),
      pipPosition: Number(s.pipPosition),
    }
    this.symbolDetailsCache.set(symbolId, det)
    return det
  }

  resolveSymbolId(ticker: string): number {
    const name = (this.symbolMap[ticker.toUpperCase()] ?? ticker).toUpperCase()
    const id = this.symbolIdByName.get(name)
    if (!id) throw new Error(this.tag(`Símbolo no encontrado: ${ticker}`))
    return id
  }

  async marketOrder(params: {
    ticker: string; side: 'buy' | 'sell'; lots: number;
    slPips?: number; tpPips?: number; label?: string
  }): Promise<void> {
    if (!this.connected) throw new Error(this.tag('Sin conexión'))

    const symbolId = this.resolveSymbolId(params.ticker)
    const det = await this.getSymbolDetails(symbolId)
    const volume = volumeFromLots(params.lots, det.lotSize)
    const relativeStopLoss = params.slPips && params.slPips > 0
      ? relativeFromPips(params.slPips, det.pipPosition) : undefined
    const relativeTakeProfit = params.tpPips && params.tpPips > 0
      ? relativeFromPips(params.tpPips, det.pipPosition) : undefined

    const payload: Record<string, unknown> = {
      ctidTraderAccountId: this.accountId, symbolId,
      orderType: ORDER_TYPE_MARKET, tradeSide: TRADE_SIDE[params.side],
      volume, label: params.label ?? 'tv-webhook', comment: params.label ?? 'tv-webhook',
    }
    if (relativeStopLoss) payload.relativeStopLoss = relativeStopLoss
    if (relativeTakeProfit) payload.relativeTakeProfit = relativeTakeProfit

    await this.send(PT.NEW_ORDER_REQ, payload)
  }

  async closeAll(ticker: string): Promise<number> {
    if (!this.connected) throw new Error(this.tag('Sin conexión'))
    const symbolId = this.resolveSymbolId(ticker)
    const rec = await this.send(PT.RECONCILE_REQ, { ctidTraderAccountId: this.accountId })
    const positions = ((rec.payload.position as Array<Record<string, unknown>>) ?? []).filter((p) => {
      const td = p.tradeData as Record<string, unknown> | undefined
      return Number(td?.symbolId) === symbolId
    })
    let closed = 0
    for (const p of positions) {
      const td = p.tradeData as Record<string, unknown>
      try {
        await this.send(PT.CLOSE_POSITION_REQ, {
          ctidTraderAccountId: this.accountId,
          positionId: Number(p.positionId), volume: Number(td.volume),
        })
        closed += 1
      } catch (err) {
        console.log(this.tag(`Posición ${p.positionId} no se pudo cerrar: ${(err as Error).message}`))
      }
    }
    return closed
  }

  /** Cierra TODAS las posiciones abiertas de la cuenta, sin filtrar por símbolo. Usado por dailyPnlGuard al cruzar el límite diario. */
  async closeAllPositions(): Promise<number> {
    if (!this.connected) throw new Error(this.tag('Sin conexión'))
    const rec = await this.send(PT.RECONCILE_REQ, { ctidTraderAccountId: this.accountId })
    const positions = (rec.payload.position as Array<Record<string, unknown>>) ?? []
    let closed = 0
    for (const p of positions) {
      const td = p.tradeData as Record<string, unknown>
      try {
        await this.send(PT.CLOSE_POSITION_REQ, {
          ctidTraderAccountId: this.accountId,
          positionId: Number(p.positionId), volume: Number(td.volume),
        })
        closed += 1
      } catch (err) {
        console.log(this.tag(`Posición ${p.positionId} no se pudo cerrar: ${(err as Error).message}`))
      }
    }
    return closed
  }

  async closeByLabel(ticker: string, labelPrefix: string): Promise<number> {
    if (!this.connected) throw new Error(this.tag('Sin conexión'))
    const symbolId = this.resolveSymbolId(ticker)
    const rec = await this.send(PT.RECONCILE_REQ, { ctidTraderAccountId: this.accountId })
    const allPositions = (rec.payload.position as Array<Record<string, unknown>>) ?? []
    const toClose = allPositions.filter((p) => {
      const td = p.tradeData as Record<string, unknown> | undefined
      const label = String(td?.label ?? '')
      return Number(td?.symbolId) === symbolId && label.startsWith(labelPrefix)
    })
    let closed = 0
    for (const p of toClose) {
      const td = p.tradeData as Record<string, unknown>
      try {
        await this.send(PT.CLOSE_POSITION_REQ, {
          ctidTraderAccountId: this.accountId,
          positionId: Number(p.positionId), volume: Number(td.volume),
        })
        closed += 1
      } catch (err) {
        console.log(this.tag(`Posición ${p.positionId} no se pudo cerrar: ${(err as Error).message}`))
      }
    }
    return closed
  }

  async getOpenPositions(): Promise<Array<{
    positionId: number; symbolId: number; symbolName: string;
    label: string; volume: number; tradeSide: number
  }>> {
    if (!this.connected) throw new Error(this.tag('Sin conexión'))
    const rec = await this.send(PT.RECONCILE_REQ, { ctidTraderAccountId: this.accountId })
    const allPositions = (rec.payload.position as Array<Record<string, unknown>>) ?? []
    const nameById = new Map<number, string>()
    for (const [name, id] of this.symbolIdByName) nameById.set(id, name)
    return allPositions.map((p) => {
      const td = p.tradeData as Record<string, unknown>
      const symId = Number(td.symbolId)
      return {
        positionId: Number(p.positionId), symbolId: symId,
        symbolName: nameById.get(symId) ?? String(symId),
        label: String(td.label ?? ''), volume: Number(td.volume),
        tradeSide: Number(td.tradeSide),
      }
    })
  }

  status() {
    return {
      userId: this.userId, name: this.name, accountId: this.accountId, connected: this.connected,
      symbols: this.symbolIdByName.size, requestsToday: this.requestCount, dayKey: this.dayKey,
    }
  }
}
