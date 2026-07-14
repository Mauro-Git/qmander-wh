/**
 * Cliente ligero cTrader Open API — WebSocket + JSON
 * ---------------------------------------------------
 * Usa el puerto 5036 (JSON) en vez del 5035 (Protobuf),
 * eliminando la dependencia de protobufjs y sus vulnerabilidades.
 *
 * Referencia oficial:
 *   https://help.ctrader.com/open-api/sending-receiving-json/
 *   https://help.ctrader.com/open-api/proxies-endpoints/
 *
 * Endpoints:
 *   demo:  wss://demo.ctraderapi.com:5036
 *   live:  wss://live.ctraderapi.com:5036
 */

import WebSocket from 'ws'
import { EventEmitter } from 'node:events'

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

// ── Enums de trading ─────────────────────────────────────────
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

// ── Configuración ────────────────────────────────────────────
const cfg = {
  host:         required('CTRADER_HOST'),           // demo.ctraderapi.com
  clientId:     required('CTRADER_CLIENT_ID'),
  clientSecret: required('CTRADER_CLIENT_SECRET'),
  accessToken:  required('CTRADER_ACCESS_TOKEN'),
  accountId:    Number(required('CTRADER_ACCOUNT_ID')),
  maxDailyRequests: Number(process.env.MAX_DAILY_REQUESTS ?? 1500),
}

function required(name: string): string {
  const v = process.env[name]
  if (!v) { console.error(`FATAL: falta variable de entorno ${name}`); process.exit(1) }
  return v
}

// ── Estado interno ───────────────────────────────────────────
let ws: WebSocket | null = null
let connected = false
let msgCounter = 0
const pending = new Map<string, PendingRequest>()
const emitter = new EventEmitter()

const symbolIdByName = new Map<string, number>()
type SymbolDetails = { symbolId: number; lotSize: number; pipPosition: number }
const symbolDetailsCache = new Map<number, SymbolDetails>()

// Contador diario de peticiones (prop-firm friendly)
let dayKey = utcDay()
let requestCount = 0

function utcDay(): string { return new Date().toISOString().slice(0, 10) }

function countRequest(): void {
  const today = utcDay()
  if (today !== dayKey) { dayKey = today; requestCount = 0 }
  requestCount += 1
  if (requestCount > cfg.maxDailyRequests) {
    throw new Error(`Límite diario de peticiones alcanzado (${cfg.maxDailyRequests})`)
  }
}

// ── Envío y recepción de mensajes ────────────────────────────

function nextMsgId(): string {
  msgCounter += 1
  return `msg_${Date.now()}_${msgCounter}`
}

function send(payloadType: number, payload: Record<string, unknown>, timeout = 15_000): Promise<CTraderMessage> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return reject(new Error('WebSocket no conectado'))
    }
    countRequest()

    const clientMsgId = nextMsgId()
    const msg: CTraderMessage = { clientMsgId, payloadType, payload }

    const timer = setTimeout(() => {
      pending.delete(clientMsgId)
      reject(new Error(`Timeout esperando respuesta a payloadType ${payloadType}`))
    }, timeout)

    pending.set(clientMsgId, { resolve, reject, timer })
    ws.send(JSON.stringify(msg))
  })
}

function handleMessage(raw: string): void {
  let msg: CTraderMessage
  try { msg = JSON.parse(raw) } catch { return }

  // Heartbeat: responder inmediatamente
  if (msg.payloadType === PT.HEARTBEAT) {
    ws?.send(JSON.stringify({ payloadType: PT.HEARTBEAT, payload: {} }))
    return
  }

  // Eventos asíncronos (sin clientMsgId de petición)
  if (msg.payloadType === PT.EXECUTION_EVENT) {
    emitter.emit('execution', msg.payload)
    // No retornar: si tiene clientMsgId, también resuelve la promesa
  }

  if (msg.payloadType === PT.ORDER_ERROR_EVENT) {
    emitter.emit('orderError', msg.payload)
  }

  if (msg.payloadType === PT.ACCOUNT_DISCONNECT) {
    connected = false
    emitter.emit('disconnect', msg.payload)
    console.error('[ctrader] Cuenta desconectada por el servidor')
  }

  // Resolver promesa pendiente
  if (msg.clientMsgId && pending.has(msg.clientMsgId)) {
    const p = pending.get(msg.clientMsgId)!
    pending.delete(msg.clientMsgId)
    clearTimeout(p.timer)

    // Si el payload contiene errorCode, rechazar
    if (msg.payload?.errorCode) {
      p.reject(new Error(`cTrader error ${msg.payload.errorCode}: ${msg.payload.description ?? ''}`))
    } else {
      p.resolve(msg)
    }
  }
}

// ── Conexión y autenticación ─────────────────────────────────

export async function initCTrader(): Promise<void> {
  const url = `wss://${cfg.host}:5036`

  await new Promise<void>((resolve, reject) => {
    ws = new WebSocket(url)

    ws.on('open', () => resolve())
    ws.on('error', (err) => reject(new Error(`WebSocket error: ${err.message}`)))
    ws.on('close', () => {
      connected = false
      console.error('[ctrader] WebSocket cerrado')
    })
    ws.on('message', (data) => handleMessage(data.toString()))
  })

  // Heartbeat propio cada 10s (el servidor cierra conexiones inactivas)
  setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ payloadType: PT.HEARTBEAT, payload: {} }))
    }
  }, 10_000)

  // 1. Autenticar aplicación
  await send(PT.APP_AUTH_REQ, {
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
  })

  // 2. Autenticar cuenta
  await send(PT.ACCOUNT_AUTH_REQ, {
    accessToken: cfg.accessToken,
    ctidTraderAccountId: cfg.accountId,
  })

  connected = true

  // 3. Cargar catálogo de símbolos
  await loadSymbols()

  // Log de ejecuciones en tiempo real
  emitter.on('execution', (evt: Record<string, unknown>) => {
    const o = evt.order as Record<string, unknown> | undefined
    const p = evt.position as Record<string, unknown> | undefined
    console.log(`[exec] type=${evt.executionType} order=${o?.orderId ?? '-'} pos=${p?.positionId ?? '-'}`)
  })

  emitter.on('orderError', (evt: Record<string, unknown>) => {
    console.error(`[orderError] ${evt.errorCode}: ${evt.description ?? 'sin descripción'}`)
  })

  console.log(`[ctrader] Conectado a ${url} cuenta ${cfg.accountId} (${symbolIdByName.size} símbolos)`)
}

async function loadSymbols(): Promise<void> {
  const res = await send(PT.SYMBOL_LIST_REQ, {
    ctidTraderAccountId: cfg.accountId,
  })
  const symbols = (res.payload.symbol as Array<Record<string, unknown>>) ?? []
  for (const s of symbols) {
    symbolIdByName.set(String(s.symbolName).toUpperCase(), Number(s.symbolId))
  }
}

async function getSymbolDetails(symbolId: number): Promise<SymbolDetails> {
  const cached = symbolDetailsCache.get(symbolId)
  if (cached) return cached

  const res = await send(PT.SYMBOL_BY_ID_REQ, {
    ctidTraderAccountId: cfg.accountId,
    symbolId: [symbolId],
  })
  const symbols = (res.payload.symbol as Array<Record<string, unknown>>) ?? []
  const s = symbols[0]
  if (!s) throw new Error(`Símbolo ${symbolId} sin detalles`)

  const det: SymbolDetails = {
    symbolId,
    lotSize: Number(s.lotSize),
    pipPosition: Number(s.pipPosition),
  }
  symbolDetailsCache.set(symbolId, det)
  return det
}

export function resolveSymbolId(ticker: string): number {
  // Mapeo opcional TV → cTrader: SYMBOL_MAP='{"US500":"US500.cash"}'
  const map: Record<string, string> = JSON.parse(process.env.SYMBOL_MAP ?? '{}')
  const name = (map[ticker.toUpperCase()] ?? ticker).toUpperCase()
  const id = symbolIdByName.get(name)
  if (!id) throw new Error(`Símbolo no encontrado en cTrader: ${ticker}`)
  return id
}

// ── Operaciones de trading ───────────────────────────────────

/**
 * Orden de mercado con stop loss y take profit opcionales,
 * ambos relativos en pips. Volumen expresado en lotes.
 */
export async function marketOrder(params: {
  ticker: string
  side: 'buy' | 'sell'
  lots: number
  slPips?: number
  tpPips?: number
  label?: string
}): Promise<void> {
  if (!connected) throw new Error('Sin conexión con cTrader')

  const symbolId = resolveSymbolId(params.ticker)
  const det = await getSymbolDetails(symbolId)

  const volume = Math.round(params.lots * det.lotSize)

  const pipFactor = Math.pow(10, 5 - det.pipPosition)
  const relativeStopLoss = params.slPips && params.slPips > 0
    ? Math.round(params.slPips * pipFactor)
    : undefined
  const relativeTakeProfit = params.tpPips && params.tpPips > 0
    ? Math.round(params.tpPips * pipFactor)
    : undefined

  const payload: Record<string, unknown> = {
    ctidTraderAccountId: cfg.accountId,
    symbolId,
    orderType: ORDER_TYPE_MARKET,
    tradeSide: TRADE_SIDE[params.side],
    volume,
    label: params.label ?? 'tv-webhook',
    comment: params.label ?? 'tv-webhook',
  }
  if (relativeStopLoss) payload.relativeStopLoss = relativeStopLoss
  if (relativeTakeProfit) payload.relativeTakeProfit = relativeTakeProfit

  await send(PT.NEW_ORDER_REQ, payload)
}

/** Cierra todas las posiciones abiertas del símbolo indicado. */
export async function closeAll(ticker: string): Promise<number> {
  if (!connected) throw new Error('Sin conexión con cTrader')

  const symbolId = resolveSymbolId(ticker)
  const rec = await send(PT.RECONCILE_REQ, { ctidTraderAccountId: cfg.accountId })
  const positions = ((rec.payload.position as Array<Record<string, unknown>>) ?? []).filter((p) => {
    const td = p.tradeData as Record<string, unknown> | undefined
    return Number(td?.symbolId) === symbolId
  })

  let closed = 0
  for (const p of positions) {
    const td = p.tradeData as Record<string, unknown>
    try {
      await send(PT.CLOSE_POSITION_REQ, {
        ctidTraderAccountId: cfg.accountId,
        positionId: Number(p.positionId),
        volume: Number(td.volume),
      })
      closed += 1
    } catch (err) {
      const msg = (err as Error).message
      console.log(`[ctrader] Posición ${p.positionId} no se pudo cerrar: ${msg}`)
    }
  }

  return closed
}

/**
 * Cierra posiciones de un símbolo cuyo label empiece con el prefijo indicado.
 * Ej: closeByLabel('EURUSD', 'smarttrail-') cierra solo Smart Trails.
 *     closeByLabel('EURUSD', 'scalper-') cierra solo el Scalper.
 */
export async function closeByLabel(ticker: string, labelPrefix: string): Promise<number> {
  if (!connected) throw new Error('Sin conexión con cTrader')

  const symbolId = resolveSymbolId(ticker)
  const rec = await send(PT.RECONCILE_REQ, { ctidTraderAccountId: cfg.accountId })
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
      await send(PT.CLOSE_POSITION_REQ, {
        ctidTraderAccountId: cfg.accountId,
        positionId: Number(p.positionId),
        volume: Number(td.volume),
      })
      closed += 1
    } catch (err) {
      const msg = (err as Error).message
      console.log(`[ctrader] Posición ${p.positionId} no se pudo cerrar: ${msg}`)
    }
  }

  return closed
}

/**
 * Devuelve las posiciones abiertas de un símbolo filtradas por prefijo de label.
 */
export async function getPositionsByLabel(ticker: string, labelPrefix: string): Promise<number> {
  if (!connected) throw new Error('Sin conexión con cTrader')

  const symbolId = resolveSymbolId(ticker)
  const rec = await send(PT.RECONCILE_REQ, { ctidTraderAccountId: cfg.accountId })
  const allPositions = (rec.payload.position as Array<Record<string, unknown>>) ?? []

  return allPositions.filter((p) => {
    const td = p.tradeData as Record<string, unknown> | undefined
    const label = String(td?.label ?? '')
    return Number(td?.symbolId) === symbolId && label.startsWith(labelPrefix)
  }).length
}

export function ctraderStatus() {
  return { connected, symbols: symbolIdByName.size, requestsToday: requestCount, dayKey }
}

/** Devuelve todas las posiciones abiertas con su label, symbolId y volume. */
export async function getOpenPositions(): Promise<Array<{
  positionId: number
  symbolId: number
  symbolName: string
  label: string
  volume: number
  tradeSide: number
}>> {
  if (!connected) throw new Error('Sin conexión con cTrader')

  const rec = await send(PT.RECONCILE_REQ, { ctidTraderAccountId: cfg.accountId })
  const allPositions = (rec.payload.position as Array<Record<string, unknown>>) ?? []

  // Invertir el mapa de símbolos para resolver nombre desde ID
  const nameById = new Map<number, string>()
  for (const [name, id] of symbolIdByName) nameById.set(id, name)

  return allPositions.map((p) => {
    const td = p.tradeData as Record<string, unknown>
    const symId = Number(td.symbolId)
    return {
      positionId: Number(p.positionId),
      symbolId: symId,
      symbolName: nameById.get(symId) ?? String(symId),
      label: String(td.label ?? ''),
      volume: Number(td.volume),
      tradeSide: Number(td.tradeSide),
    }
  })
}
