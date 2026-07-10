/**
 * Receptor de webhooks TradingView → cTrader Open API
 * ────────────────────────────────────────────────────
 * Capas de seguridad:
 *   1. Filtro de IP de origen (TradingView)
 *   2. Token secreto con comparación timing-safe
 *   3. Esquema estricto (zod) + frescura temporal
 *   4. Anti-duplicados (idempotencia)
 *   5. Límites de riesgo + kill switch
 *
 * Luego: respuesta 200 inmediata → cola asíncrona → cTrader.
 */

import express, { type Request, type Response } from 'express'
import { timingSafeEqual, createHash } from 'node:crypto'
import { z } from 'zod'
import { initCTrader, marketOrder, closeAll, ctraderStatus } from './ctrader.js'

// ── Configuración ────────────────────────────────────────────

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? ''
if (WEBHOOK_SECRET.length < 32) {
  console.error('FATAL: WEBHOOK_SECRET ausente o < 32 caracteres')
  process.exit(1)
}

const PORT        = Number(process.env.PORT ?? 3000)
const MAX_LOTS    = Number(process.env.MAX_LOTS ?? 0.01)
const DEFAULT_SL  = Number(process.env.DEFAULT_SL_PIPS ?? 0) // 0 = exigir en payload
const ALLOWED_SYMBOLS = new Set(
  (process.env.ALLOWED_SYMBOLS ?? '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
)

// IPs oficiales de TradingView (verificar lista vigente antes de producción)
const TRADINGVIEW_IPS = new Set([
  '52.89.214.238', '34.212.75.30', '54.218.53.128', '52.32.178.7',
])

const MAX_AGE_MS = 60_000
let killSwitch = false

// ── Esquema del payload ──────────────────────────────────────

const AlertSchema = z.object({
  secret:   z.string().min(32),
  alert_id: z.string().min(8).max(200),
  action:   z.enum(['buy', 'sell', 'close']),
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

// ── Cola asíncrona con reintentos ────────────────────────────

type Job = { alert: Alert; attempts: number }
const queue: Job[] = []
let processing = false

async function processQueue(): Promise<void> {
  if (processing) return
  processing = true
  while (queue.length > 0) {
    const job = queue.shift() as Job
    const a = job.alert
    try {
      if (a.action === 'close') {
        const n = await closeAll(a.ticker)
        log('info', `close ${a.ticker}: ${n} posiciones cerradas (${a.alert_id})`)
      } else {
        await marketOrder({
          ticker:  a.ticker,
          side:    a.action,
          lots:    a.lots ?? MAX_LOTS,
          slPips:  a.sl_pips ?? DEFAULT_SL,
          tpPips:  a.tp_pips,
          label:   a.alert_id.slice(0, 90),
        })
        log('info', `${a.action} ${a.lots ?? MAX_LOTS} lotes ${a.ticker} OK (${a.alert_id})`)
      }
    } catch (err) {
      job.attempts += 1
      if (job.attempts < 3) {
        log('warn', `Reintento ${job.attempts} para ${a.alert_id}: ${(err as Error).message}`)
        queue.push(job)
        await new Promise(r => setTimeout(r, 1500 * job.attempts))
      } else {
        log('error', `DESCARTADA tras 3 intentos: ${a.alert_id} — ${(err as Error).message}`)
        // TODO: notifyHuman(a, err) — email / Telegram
      }
    }
  }
  processing = false
}

// ── Servidor HTTP ────────────────────────────────────────────

const app = express()
app.set('trust proxy', true) // detrás de Traefik (EasyPanel)
app.disable('x-powered-by')
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
  try { body = JSON.parse(typeof req.body === 'string' ? req.body : '') }
  catch { return res.status(400).send('Bad request') }

  // Capa 3: esquema
  const parsed = AlertSchema.safeParse(body)
  if (!parsed.success) {
    log('warn', 'Payload inválido')
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
  if (alert.action !== 'close' && !(alert.sl_pips || DEFAULT_SL > 0)) {
    log('warn', `Sin stop loss: ${alert.alert_id} rechazada`)
    return res.status(200).send('OK')
  }

  // Aceptada → responder YA, ejecutar en segundo plano
  res.status(200).send('OK')
  queue.push({ alert, attempts: 0 })
  setImmediate(processQueue)
})

app.get('/health', (_req, res) => res.status(200).json(ctraderStatus()))

app.post('/admin/kill-switch', express.json(), (req: Request, res: Response) => {
  const token = req.get('authorization')?.replace('Bearer ', '') ?? ''
  if (!secretMatches(token)) return res.status(404).send('Not found')
  killSwitch = Boolean((req.body as { enabled?: boolean }).enabled)
  log('warn', `Kill switch = ${killSwitch}`)
  return res.status(200).json({ killSwitch })
})

// ── Utilidades ───────────────────────────────────────────────

function log(level: 'info' | 'warn' | 'error', msg: string): void {
  console[level === 'info' ? 'log' : level](`[${new Date().toISOString()}] [${level}] ${msg}`)
}

// ── Arranque: primero cTrader, luego HTTP ────────────────────

initCTrader()
  .then(() => app.listen(PORT, () => log('info', `HTTP escuchando en :${PORT}`)))
  .catch((err) => { console.error('FATAL al conectar con cTrader:', err); process.exit(1) })
