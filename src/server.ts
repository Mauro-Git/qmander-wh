/**
 * Receptor de webhooks TradingView → cTrader Open API
 * ────────────────────────────────────────────────────
 * Motor de señales: Scalper (papá) + Smart Trail (hijos) + Exit
 *
 * Capas de seguridad:
 *   1. Filtro de IP de origen (TradingView)
 *   2. Token secreto con comparación timing-safe
 *   3. Esquema estricto (zod) + frescura temporal
 *   4. Anti-duplicados (idempotencia)
 *   5. Límites de riesgo + kill switch
 *
 * Luego: respuesta 200 inmediata → cola asíncrona → motor de reglas → cTrader.
 */

import express, { type Request, type Response } from 'express'
import { timingSafeEqual, createHash } from 'node:crypto'
import { z } from 'zod'
import { initCTrader, marketOrder, closeAll, closeByLabel, getPositionsByLabel, getOpenPositions, ctraderStatus } from './ctrader.js'

// ── Configuración ────────────────────────────────────────────

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? ''
if (WEBHOOK_SECRET.length < 32) {
  console.error('FATAL: WEBHOOK_SECRET ausente o < 32 caracteres')
  process.exit(1)
}

const PORT        = Number(process.env.PORT ?? 3000)
const MAX_LOTS    = Number(process.env.MAX_LOTS ?? 5)
const DEFAULT_SL  = Number(process.env.DEFAULT_SL_PIPS ?? 0)
const ALLOWED_SYMBOLS = new Set(
  (process.env.ALLOWED_SYMBOLS ?? '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
)

const TRADINGVIEW_IPS = new Set(
  (process.env.TRADINGVIEW_IPS ?? '').split(',').map(s => s.trim()).filter(Boolean)
)
if (TRADINGVIEW_IPS.size === 0) {
  console.error('FATAL: TRADINGVIEW_IPS no definida en .env')
  process.exit(1)
}

const MAX_AGE_MS = 60_000
let killSwitch = false

// ── Estado del motor de señales (por ticker) ─────────────────

interface ScalperState {
  direction: 'buy' | 'sell'
  smartTrailCount: number  // contador para labels únicos
}

// Mapa: ticker → estado del scalper activo
const scalperState = new Map<string, ScalperState>()

// ── Esquema del payload ──────────────────────────────────────

const AlertSchema = z.object({
  alert_id: z.string().min(8).max(200),
  action:   z.enum(['buy', 'sell', 'close']),
  signal:   z.enum(['scalper', 'smart_trail', 'exit', 'close_all']),
  ticker:   z.string().min(1).max(30),
  price:    z.number().positive(),
  time:     z.number().int().positive(),
  lots:     z.number().positive().optional(),
  sl_pips:  z.number().positive().optional(),
  tp_pips:  z.number().positive().optional(),
})
type Alert = z.infer<typeof AlertSchema>

// ── Utilidades de seguridad ──────────────────────────────────

function secretMatches(received: string): boolean {
  const a = createHash('sha256').update(received).digest()
  const b = createHash('sha256').update(WEBHOOK_SECRET).digest()
  return timingSafeEqual(a, b)
}

const seenAlerts = new Map<string, number>()
function isDuplicate(id: string): boolean {
  const now = Date.now()
  for (const [k, ts] of seenAlerts) if (now - ts > 600_000) seenAlerts.delete(k)
  if (seenAlerts.has(id)) return true
  seenAlerts.set(id, now)
  return false
}

// ── Motor de reglas Scalper / Smart Trail / Exit ─────────────

async function processSignal(alert: Alert): Promise<void> {
  const ticker = alert.ticker
  const state = scalperState.get(ticker.toUpperCase())

  switch (alert.signal) {
    // ─── SCALPER ───────────────────────────────────────────
    case 'scalper': {
      const side = alert.action as 'buy' | 'sell'
      const lots = alert.lots ?? 5

      if (!state) {
        // No hay Scalper abierto → abrir nuevo
        await marketOrder({
          ticker, side, lots,
          slPips: alert.sl_pips ?? DEFAULT_SL,
          tpPips: alert.tp_pips,
          label: `scalper-${side}`,
        })
        scalperState.set(ticker.toUpperCase(), { direction: side, smartTrailCount: 0 })
        log('info', `[scalper] NUEVO ${side} ${lots} lotes ${ticker} (${alert.alert_id})`)

      } else if (state.direction === side) {
        // Misma dirección → ignorar
        log('info', `[scalper] IGNORADO: ya hay scalper ${side} en ${ticker} (${alert.alert_id})`)

      } else {
        // Dirección contraria → cerrar todo y abrir nuevo
        const closedScalper = await closeByLabel(ticker, 'scalper-')
        const closedSmart = await closeByLabel(ticker, 'smarttrail-')
        log('info', `[scalper] REVERSA: cerradas ${closedScalper} scalper + ${closedSmart} smart trail en ${ticker}`)

        await marketOrder({
          ticker, side, lots,
          slPips: alert.sl_pips ?? DEFAULT_SL,
          tpPips: alert.tp_pips,
          label: `scalper-${side}`,
        })
        scalperState.set(ticker.toUpperCase(), { direction: side, smartTrailCount: 0 })
        log('info', `[scalper] NUEVO ${side} ${lots} lotes ${ticker} (${alert.alert_id})`)
      }
      break
    }

    // ─── SMART TRAIL ──────────────────────────────────────
    case 'smart_trail': {
      const side = alert.action as 'buy' | 'sell'
      const lots = alert.lots ?? 3

      if (!state) {
        log('info', `[smart_trail] IGNORADO: no hay scalper activo en ${ticker} (${alert.alert_id})`)
        break
      }

      if (side !== state.direction) {
        log('info', `[smart_trail] IGNORADO: ${side} contra scalper ${state.direction} en ${ticker} (${alert.alert_id})`)
        break
      }

      // Misma dirección que el scalper → abrir posición
      state.smartTrailCount += 1
      const label = `smarttrail-${side}-${state.smartTrailCount}`

      await marketOrder({
        ticker, side, lots,
        slPips: alert.sl_pips ?? DEFAULT_SL,
        tpPips: alert.tp_pips,
        label,
      })
      log('info', `[smart_trail] ${side} ${lots} lotes ${ticker} label=${label} (${alert.alert_id})`)
      break
    }

    // ─── EXIT ─────────────────────────────────────────────
    case 'exit': {
      const closedSmart = await closeByLabel(ticker, 'smarttrail-')
      if (closedSmart > 0) {
        log('info', `[exit] ${closedSmart} smart trail cerradas en ${ticker} (${alert.alert_id})`)
      } else {
        log('info', `[exit] No hay smart trail abiertos en ${ticker} (${alert.alert_id})`)
      }
      // El scalper NO se toca
      break
    }

    // ─── CLOSE ALL ────────────────────────────────────────
    case 'close_all': {
      const closedScalper = await closeByLabel(ticker, 'scalper-')
      const closedSmart = await closeByLabel(ticker, 'smarttrail-')
      scalperState.delete(ticker.toUpperCase())
      log('info', `[close_all] ${closedScalper} scalper + ${closedSmart} smart trail cerradas en ${ticker} (${alert.alert_id})`)
      break
    }
  }
}

// ── Cola asíncrona con reintentos ────────────────────────────

type Job = { alert: Alert; attempts: number }
const queue: Job[] = []
let processing = false

async function processQueue(): Promise<void> {
  if (processing) return
  processing = true
  while (queue.length > 0) {
    const job = queue.shift() as Job
    try {
      await processSignal(job.alert)
    } catch (err) {
      job.attempts += 1
      if (job.attempts < 3) {
        log('warn', `Reintento ${job.attempts} para ${job.alert.alert_id}: ${(err as Error).message}`)
        queue.push(job)
        await new Promise(r => setTimeout(r, 1500 * job.attempts))
      } else {
        log('error', `DESCARTADA tras 3 intentos: ${job.alert.alert_id} — ${(err as Error).message}`)
      }
    }
  }
  processing = false
}

// ── Servidor HTTP ────────────────────────────────────────────

const app = express()
app.set('trust proxy', true)
app.disable('x-powered-by')

// Debug: loguear TODA petición que llegue a Express (quitar después de diagnosticar)
app.use((req, _res, next) => {
  log('info', `[incoming] ${req.method} ${req.path} from ${req.ip} Content-Type: ${req.get('content-type') ?? 'none'} User-Agent: ${req.get('user-agent') ?? 'none'}`)
  next()
})

app.use(express.text({ type: '*/*', limit: '8kb' }))

app.post('/webhook/tradingview', (req: Request, res: Response) => {
  // Capa 1: IP de origen
  const ip = req.ip ?? ''
  if (!TRADINGVIEW_IPS.has(ip)) {
    log('warn', `IP no autorizada: ${ip}`)
    return res.status(404).send('Not found')
  }

  // Parseo
  let body: unknown
  const rawBody = typeof req.body === 'string' ? req.body : ''
  try { body = JSON.parse(rawBody) }
  catch (err) {
    log('warn', `JSON inválido: ${(err as Error).message}`)
    log('warn', `Body crudo (primeros 200 chars): ${rawBody.slice(0, 200)}`)
    return res.status(400).send('Bad request')
  }

  // Capa 3: esquema
  const parsed = AlertSchema.safeParse(body)
  if (!parsed.success) {
    log('warn', `Payload inválido: ${parsed.error.issues.map(i => i.message).join(', ')}`)
    return res.status(400).send('Bad request')
  }
  const alert = parsed.data

  // Capa 2: token
  if (!secretMatches(alert.secret)) {
    log('warn', `Token inválido desde ${ip}`)
    return res.status(404).send('Not found')
  }

  // Capa 3: frescura
  const age = Date.now() - alert.time
  if (age > MAX_AGE_MS || age < -10_000) {
    log('warn', `Fuera de ventana (${age} ms): ${alert.alert_id}`)
    return res.status(200).send('OK')
  }

  // Capa 4: duplicados
  if (isDuplicate(alert.alert_id)) return res.status(200).send('OK')

  // Capa 5: riesgo
  if (killSwitch) {
    log('warn', `Kill switch activo: ${alert.alert_id} ignorada`)
    return res.status(200).send('OK')
  }
  if (ALLOWED_SYMBOLS.size > 0 && !ALLOWED_SYMBOLS.has(alert.ticker.toUpperCase())) {
    log('warn', `Símbolo no permitido: ${alert.ticker}`)
    return res.status(200).send('OK')
  }
  if ((alert.lots ?? 0) > MAX_LOTS) {
    log('warn', `lots ${alert.lots} > MAX_LOTS ${MAX_LOTS}`)
    return res.status(200).send('OK')
  }

  // Aceptada → responder YA, ejecutar en segundo plano
  res.status(200).send('OK')
  queue.push({ alert, attempts: 0 })
  setImmediate(processQueue)
})

// Estado del motor de señales
app.get('/health', (_req, res) => {
  const states: Record<string, ScalperState> = {}
  for (const [ticker, state] of scalperState) {
    states[ticker] = state
  }
  return res.status(200).json({ ...ctraderStatus(), scalperState: states, killSwitch })
})

app.post('/admin/kill-switch', express.json(), (req: Request, res: Response) => {
  const token = req.get('authorization')?.replace('Bearer ', '') ?? ''
  if (!secretMatches(token)) return res.status(404).send('Not found')
  killSwitch = Boolean((req.body as { enabled?: boolean }).enabled)
  log('warn', `Kill switch = ${killSwitch}`)
  return res.status(200).json({ killSwitch })
})

// Catch-all: loguear cualquier petición que no coincida con las rutas anteriores
app.all('*', (req: Request, res: Response) => {
  log('warn', `[catch-all] ${req.method} ${req.path} — ruta no encontrada`)
  return res.status(404).send('Not found')
})

// ── Utilidades ───────────────────────────────────────────────

function log(level: 'info' | 'warn' | 'error', msg: string): void {
  console[level === 'info' ? 'log' : level](`[${new Date().toISOString()}] [${level}] ${msg}`)
}

// ── Arranque: primero cTrader, luego reconstruir estado, luego HTTP ──

async function rebuildState(): Promise<void> {
  const positions = await getOpenPositions()
  for (const pos of positions) {
    // Reconstruir estado del Scalper desde las posiciones abiertas
    if (pos.label.startsWith('scalper-')) {
      const direction = pos.tradeSide === 1 ? 'buy' : 'sell' as const
      const ticker = pos.symbolName
      // Contar Smart Trails existentes para el contador
      const smartTrails = positions.filter(
        p => p.symbolId === pos.symbolId && p.label.startsWith('smarttrail-')
      ).length
      scalperState.set(ticker, { direction, smartTrailCount: smartTrails })
      log('info', `[estado] Reconstruido: ${ticker} scalper ${direction}, ${smartTrails} smart trails activos`)
    }
  }
  if (scalperState.size === 0) {
    log('info', '[estado] Sin posiciones previas — estado limpio')
  }
}

initCTrader()
  .then(() => rebuildState())
  .then(() => app.listen(PORT, () => log('info', `HTTP escuchando en :${PORT}`)))
  .catch((err) => { console.error('FATAL al conectar con cTrader:', err); process.exit(1) })
