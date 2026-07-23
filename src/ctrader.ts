/**
 * Cliente ligero cTrader Open API — WebSocket + JSON — Multi-cuenta
 * ------------------------------------------------------------------
 * Cada cuenta tiene su propia conexión WebSocket al puerto 5036.
 * Todas comparten el mismo clientId/clientSecret (app de Spotware).
 *
 * Configuración en .env:
 *   CTRADER_HOST=demo.ctraderapi.com
 *   CTRADER_CLIENT_ID=xxx
 *   CTRADER_CLIENT_SECRET=yyy
 *   CTRADER_ACCOUNTS=[{"name":"Demo 1","accessToken":"...","accountId":47603328},{"name":"Demo 2","accessToken":"...","accountId":48123456}]
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

type SymbolDetails = { symbolId: number; lotSize: number; pipPosition: number }

interface AccountConfig {
  name: string
  accessToken: string
  accountId: number
}

// ── Configuración global (compartida por todas las cuentas) ──
const globalCfg = {
  host:         required('CTRADER_HOST'),
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

// ── Clase CTraderAccount — una instancia por cuenta ──────────

class CTraderAccount {
  name: string
  accountId: number
  accessToken: string
  connected = false

  private ws: WebSocket | null = null
  private msgCounter = 0
  private pending = new Map<string, PendingRequest>()
  private symbolIdByName = new Map<string, number>()
  private symbolDetailsCache = new Map<number, SymbolDetails>()
  private dayKey = utcDay()
  private requestCount = 0

  constructor(config: AccountConfig) {
    this.name = config.name
    this.accountId = config.accountId
    this.accessToken = config.accessToken
  }

  private tag(msg: string): string {
    return `[${this.name}] ${msg}`
  }

  private countRequest(): void {
    const today = utcDay()
    if (today !== this.dayKey) { this.dayKey = today; this.requestCount = 0 }
    this.requestCount += 1
    if (this.requestCount > globalCfg.maxDailyRequests) {
      throw new Error(this.tag(`Límite diario de peticiones alcanzado (${globalCfg.maxDailyRequests})`))
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
      this.countRequest()

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
    const url = `wss://${globalCfg.host}:5036`

    await new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url)
      this.ws.on('open', () => resolve())
      this.ws.on('error', (err) => reject(new Error(this.tag(`WebSocket error: ${err.message}`))))
      this.ws.on('close', () => {
        this.connected = false
        console.error(this.tag('WebSocket cerrado'))
      })
      this.ws.on('message', (data) => this.handleMessage(data.toString()))
    })

    setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ payloadType: PT.HEARTBEAT, payload: {} }))
      }
    }, 10_000)

    await this.send(PT.APP_AUTH_REQ, {
      clientId: globalCfg.clientId,
      clientSecret: globalCfg.clientSecret,
    })

    await this.send(PT.ACCOUNT_AUTH_REQ, {
      accessToken: this.accessToken,
      ctidTraderAccountId: this.accountId,
    })

    this.connected = true
    await this.loadSymbols()

    console.log(this.tag(`Conectado a ${url} cuenta ${this.accountId} (${this.symbolIdByName.size} símbolos)`))
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
    const map: Record<string, string> = JSON.parse(process.env.SYMBOL_MAP ?? '{}')
    const name = (map[ticker.toUpperCase()] ?? ticker).toUpperCase()
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
    const volume = Math.round(params.lots * det.lotSize)
    const pipFactor = Math.pow(10, 5 - det.pipPosition)
    const relativeStopLoss = params.slPips && params.slPips > 0
      ? Math.round(params.slPips * pipFactor) : undefined
    const relativeTakeProfit = params.tpPips && params.tpPips > 0
      ? Math.round(params.tpPips * pipFactor) : undefined

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
      name: this.name, accountId: this.accountId, connected: this.connected,
      symbols: this.symbolIdByName.size, requestsToday: this.requestCount, dayKey: this.dayKey,
    }
  }
}

// ── Pool de cuentas ──────────────────────────────────────────

const accounts: CTraderAccount[] = []

export async function initAllAccounts(): Promise<void> {
  const raw = process.env.CTRADER_ACCOUNTS
  if (!raw) {
    console.error('FATAL: CTRADER_ACCOUNTS no definida en .env')
    process.exit(1)
  }
  let configs: AccountConfig[]
  try { configs = JSON.parse(raw) } catch {
    console.error('FATAL: CTRADER_ACCOUNTS no es JSON válido')
    process.exit(1)
  }
  if (configs.length === 0) {
    console.error('FATAL: CTRADER_ACCOUNTS está vacío')
    process.exit(1)
  }

  for (const cfg of configs) {
    const account = new CTraderAccount(cfg)
    try {
      await account.connect()
      accounts.push(account)
    } catch (err) {
      console.error(`[${cfg.name}] Error al conectar: ${(err as Error).message}`)
    }
  }

  if (accounts.length === 0) {
    console.error('FATAL: ninguna cuenta se pudo conectar')
    process.exit(1)
  }

  console.log(`[pool] ${accounts.length} de ${configs.length} cuentas conectadas`)
}

// ── Funciones que ejecutan en TODAS las cuentas ──────────────

export async function marketOrderAll(params: {
  ticker: string; side: 'buy' | 'sell'; lots: number;
  slPips?: number; tpPips?: number; label?: string
}): Promise<void> {
  const results = await Promise.allSettled(
    accounts.map(a => a.marketOrder(params))
  )
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'rejected') {
      console.error(`[${accounts[i].name}] Error en marketOrder: ${(results[i] as PromiseRejectedResult).reason}`)
    }
  }
}

export async function closeByLabelAll(ticker: string, labelPrefix: string): Promise<number> {
  let total = 0
  for (const account of accounts) {
    try {
      const closed = await account.closeByLabel(ticker, labelPrefix)
      total += closed
      if (closed > 0) console.log(`[${account.name}] ${closed} posiciones cerradas (${labelPrefix})`)
    } catch (err) {
      console.error(`[${account.name}] Error en closeByLabel: ${(err as Error).message}`)
    }
  }
  return total
}

export async function closeAllAll(ticker: string): Promise<number> {
  let total = 0
  for (const account of accounts) {
    try {
      const closed = await account.closeAll(ticker)
      total += closed
    } catch (err) {
      console.error(`[${account.name}] Error en closeAll: ${(err as Error).message}`)
    }
  }
  return total
}

export async function getOpenPositionsAll(): Promise<Array<{
  accountName: string; positionId: number; symbolId: number;
  symbolName: string; label: string; volume: number; tradeSide: number
}>> {
  const all: Array<{
    accountName: string; positionId: number; symbolId: number;
    symbolName: string; label: string; volume: number; tradeSide: number
  }> = []
  for (const account of accounts) {
    try {
      const positions = await account.getOpenPositions()
      for (const p of positions) {
        all.push({ accountName: account.name, ...p })
      }
    } catch (err) {
      console.error(`[${account.name}] Error al leer posiciones: ${(err as Error).message}`)
    }
  }
  return all
}

export function allAccountsStatus() {
  return accounts.map(a => a.status())
}
