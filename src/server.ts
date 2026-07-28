/**
 * Receptor de webhooks TradingView → cTrader Open API (Multi-tenant)
 * ──────────────────────────────────────────────────────────────────
 * Motor de señales: Scalper (papá) + Smart Trail (hijos) + Exit
 * Cada alerta se autentica contra un usuario (webhookToken) y ejecuta
 * únicamente en la cuenta cTrader de ESE usuario (BrokerAccount es 1:1
 * con User — ya no hay fan-out a "todas las cuentas").
 *
 * Capas de seguridad:
 *   1. Filtro de IP de origen (TradingView)
 *   2. Token por usuario (webhookToken, único e indexado en DB)
 *   3. Esquema estricto (zod) + frescura temporal
 *   4. Anti-duplicados (idempotencia, por usuario+alert_id)
 *   5. Límites de riesgo por usuario (UserConfig) + kill switch superadmin
 */

import express, { type Request, type Response } from 'express'
import { timingSafeEqual, createHash } from 'node:crypto'
import { appendFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { prisma } from './lib/prisma.js'
import { initAllAccounts, getAccountForUser, allPoolStatus } from './accountPool.js'
import { onDailyLimitClearState, isDailyLimitTriggered } from './dailyPnlGuard.js'
import { replicateToFollowers } from './mirrorTrading.js'
import type { CTraderAccount } from './ctrader.js'

// ── Configuración ────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 3000)

// Protege /admin/* (logs, kill switch superadmin). Ya no autentica alertas de
// TradingView — eso ahora es el webhookToken por usuario, ver capa 2 abajo.
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? ''
if (ADMIN_SECRET.length < 32) {
  console.error('FATAL: ADMIN_SECRET ausente o < 32 caracteres')
  process.exit(1)
}

const TRADINGVIEW_IPS = new Set(
  (process.env.TRADINGVIEW_IPS ?? '').split(',').map(s => s.trim()).filter(Boolean)
)
if (TRADINGVIEW_IPS.size === 0) {
  console.error('FATAL: TRADINGVIEW_IPS no definida en .env')
  process.exit(1)
}

const MAX_AGE_MS = 60_000

// Kill switch de emergencia, global, en memoria — distinto del killSwitch por
// usuario (UserConfig.killSwitch, gestionado desde el dashboard). Cuando está
// activo ignora alertas de TODOS los usuarios. Vive en memoria del proceso:
// si algún día se corre más de una réplica, hay que moverlo a DB.
let superadminKillSwitch = false

// ── Estado del motor de señales (por usuario + ticker) ───────

interface ScalperState {
  direction: 'buy' | 'sell'
  smartTrailCount: number
}

const scalperState = new Map<string, ScalperState>()
export function stateKey(userId: string, ticker: string): string {
  return `${userId}:${ticker.toUpperCase()}`
}

// Si dailyPnlGuard cierra todo por límite diario, el motor de señales en
// memoria no debe seguir pensando que hay un scalper/smart trail abierto para
// ese usuario — si no, al reactivar killSwitch más tarde podría ignorar una
// nueva señal "scalper" creyendo que ya hay una posición cuando en realidad
// se cerró por este mecanismo.
onDailyLimitClearState((userId) => {
  const prefix = `${userId}:`
  for (const key of scalperState.keys()) {
    if (key.startsWith(prefix)) scalperState.delete(key)
  }
})

// ── Esquema del payload ──────────────────────────────────────

export const AlertSchema = z.object({
  secret:   z.string().min(10).max(100), // webhookToken (cuid, ~25 chars), no un secreto de largo fijo
  alert_id: z.string().min(8).max(200),
  action:   z.enum(['buy', 'sell', 'close']),
  signal:   z.enum(['scalper', 'smart_trail', 'exit', 'close_all']),
  ticker:   z.string().min(1).max(30),
  price:    z.number().positive(),
  time:     z.string(),  // ISO format: "2026-07-22T02:06:00Z"
  lots:     z.number().positive().optional(),
  sl_pips:  z.number().positive().optional(),
  tp_pips:  z.number().positive().optional(),
})
export type Alert = z.infer<typeof AlertSchema>

// ── Capa 5: riesgo — función pura, testeada sin DB ni Express ─

export interface UserRiskConfig {
  allowedSymbols: string[]
  maxLots: number
  killSwitch: boolean
  // true si UserConfig.dailyProfitTarget/dailyLossLimit se cruzó hoy (DailyPnlState.triggered,
  // ver dailyPnlGuard.ts). Distinto de killSwitch: este se resetea solo al día siguiente.
  dailyLimitTriggered: boolean
}

export type RiskDenyReason =
  | 'superadmin-kill-switch'
  | 'user-kill-switch'
  | 'daily-limit-triggered'
  | 'symbol-not-allowed'
  | 'max-lots-exceeded'

export function checkRisk(
  alert: { ticker: string; lots?: number },
  config: UserRiskConfig,
  superadminKillSwitch: boolean
): { allowed: true } | { allowed: false; reason: RiskDenyReason } {
  if (superadminKillSwitch) return { allowed: false, reason: 'superadmin-kill-switch' }
  if (config.killSwitch) return { allowed: false, reason: 'user-kill-switch' }
  if (config.dailyLimitTriggered) return { allowed: false, reason: 'daily-limit-triggered' }
  if (config.allowedSymbols.length > 0 && !config.allowedSymbols.includes(alert.ticker.toUpperCase())) {
    return { allowed: false, reason: 'symbol-not-allowed' }
  }
  if ((alert.lots ?? 0) > config.maxLots) return { allowed: false, reason: 'max-lots-exceeded' }
  return { allowed: true }
}

// ── Utilidades de seguridad ──────────────────────────────────

export function resolveUserFromSecret(secret: string) {
  return prisma.user.findUnique({
    where: { webhookToken: secret },
    include: { brokerAccount: true, config: true },
  })
}

function adminSecretMatches(received: string): boolean {
  const a = createHash('sha256').update(received).digest()
  const b = createHash('sha256').update(ADMIN_SECRET).digest()
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

// ── Reconstrucción de estado al conectar una cuenta ───────────

async function rebuildStateForAccount(account: CTraderAccount): Promise<void> {
  const positions = await account.getOpenPositions()
  for (const pos of positions) {
    if (!pos.label.startsWith('scalper-')) continue
    const direction = pos.tradeSide === 1 ? 'buy' : 'sell' as const
    const key = stateKey(account.userId, pos.symbolName)
    if (scalperState.has(key)) continue
    const smartTrails = positions.filter(
      p => p.symbolId === pos.symbolId && p.label.startsWith('smarttrail-')
    ).length
    scalperState.set(key, { direction, smartTrailCount: smartTrails })
    log('info', `[estado] ${account.name}: reconstruido ${pos.symbolName} scalper ${direction}, ${smartTrails} smart trails activos`)
  }
}

// ── Motor de reglas Scalper / Smart Trail / Exit ─────────────

export async function processSignal(alert: Alert, userId: string, symbolMap: Record<string, string>): Promise<void> {
  const account = await getAccountForUser(userId, rebuildStateForAccount)
  if (!account) throw new Error('No se pudo conectar la cuenta cTrader del usuario')
  account.setSymbolMap(symbolMap)

  const ticker = alert.ticker
  const key = stateKey(userId, ticker)
  const state = scalperState.get(key)

  switch (alert.signal) {
    case 'scalper': {
      const side = alert.action as 'buy' | 'sell'
      const lots = alert.lots ?? 5

      if (!state) {
        await account.marketOrder({
          ticker, side, lots,
          slPips: alert.sl_pips, tpPips: alert.tp_pips,
          label: `scalper-${side}`,
        })
        scalperState.set(key, { direction: side, smartTrailCount: 0 })
        log('info', `[scalper] ${account.name}: NUEVO ${side} ${lots} lotes ${ticker} (${alert.alert_id})`)

      } else if (state.direction === side) {
        log('info', `[scalper] ${account.name}: IGNORADO ya hay scalper ${side} en ${ticker} (${alert.alert_id})`)

      } else {
        const closedScalper = await account.closeByLabel(ticker, 'scalper-')
        const closedSmart = await account.closeByLabel(ticker, 'smarttrail-')
        log('info', `[scalper] ${account.name}: REVERSA cerradas ${closedScalper} scalper + ${closedSmart} smart trail en ${ticker}`)

        await account.marketOrder({
          ticker, side, lots,
          slPips: alert.sl_pips, tpPips: alert.tp_pips,
          label: `scalper-${side}`,
        })
        scalperState.set(key, { direction: side, smartTrailCount: 0 })
        log('info', `[scalper] ${account.name}: NUEVO ${side} ${lots} lotes ${ticker} (${alert.alert_id})`)
      }
      break
    }

    case 'smart_trail': {
      const side = alert.action as 'buy' | 'sell'
      const lots = alert.lots ?? 3

      if (!state) {
        log('info', `[smart_trail] ${account.name}: IGNORADO no hay scalper activo en ${ticker} (${alert.alert_id})`)
        break
      }
      if (side !== state.direction) {
        log('info', `[smart_trail] ${account.name}: IGNORADO ${side} contra scalper ${state.direction} en ${ticker} (${alert.alert_id})`)
        break
      }

      state.smartTrailCount += 1
      const label = `smarttrail-${side}-${state.smartTrailCount}`

      await account.marketOrder({
        ticker, side, lots,
        slPips: alert.sl_pips, tpPips: alert.tp_pips,
        label,
      })
      log('info', `[smart_trail] ${account.name}: ${side} ${lots} lotes ${ticker} label=${label} (${alert.alert_id})`)
      break
    }

    case 'exit': {
      const closedSmart = await account.closeByLabel(ticker, 'smarttrail-')
      if (closedSmart > 0) {
        log('info', `[exit] ${account.name}: ${closedSmart} smart trail cerradas en ${ticker} (${alert.alert_id})`)
      } else {
        log('info', `[exit] ${account.name}: no hay smart trail abiertos en ${ticker} (${alert.alert_id})`)
      }
      break
    }

    case 'close_all': {
      const closedScalper = await account.closeByLabel(ticker, 'scalper-')
      const closedSmart = await account.closeByLabel(ticker, 'smarttrail-')
      scalperState.delete(key)
      log('info', `[close_all] ${account.name}: ${closedScalper} scalper + ${closedSmart} smart trail cerradas en ${ticker} (${alert.alert_id})`)
      break
    }
  }
}

// ── Cola asíncrona con reintentos ────────────────────────────

type Job = { alert: Alert; userId: string; tradeId: string; symbolMap: Record<string, string>; attempts: number }
const queue: Job[] = []
let processing = false

async function processQueue(): Promise<void> {
  if (processing) return
  processing = true
  while (queue.length > 0) {
    const job = queue.shift() as Job
    try {
      await processSignal(job.alert, job.userId, job.symbolMap)
      await prisma.trade.update({ where: { id: job.tradeId }, data: { status: 'executed' } })
        .catch((err) => log('error', `No se pudo actualizar Trade ${job.tradeId}: ${(err as Error).message}`))
    } catch (err) {
      const message = (err as Error).message
      job.attempts += 1
      if (job.attempts < 3) {
        log('warn', `Reintento ${job.attempts} para ${job.alert.alert_id}: ${message}`)
        await prisma.trade.update({ where: { id: job.tradeId }, data: { status: 'retrying', error: message } }).catch(() => {})
        queue.push(job)
        await new Promise(r => setTimeout(r, 1500 * job.attempts))
      } else {
        log('error', `DESCARTADA tras 3 intentos: ${job.alert.alert_id} — ${message}`)
        await prisma.trade.update({ where: { id: job.tradeId }, data: { status: 'failed', error: message } }).catch(() => {})
      }
    }
  }
  processing = false
}

// ── Servidor HTTP ────────────────────────────────────────────

const app = express()
app.set('trust proxy', true)
app.disable('x-powered-by')

// Debug: loguear toda petición (quitar después de diagnosticar)
app.use((req, _res, next) => {
  log('info', `[incoming] ${req.method} ${req.path} from ${req.ip} Content-Type: ${req.get('content-type') ?? 'none'} User-Agent: ${req.get('user-agent') ?? 'none'}`)
  next()
})

app.use(express.text({ type: '*/*', limit: '8kb' }))

app.post('/webhook/tradingview', async (req: Request, res: Response) => {
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

  // Capa 2: usuario por webhookToken
  const user = await resolveUserFromSecret(alert.secret)
  if (!user) {
    log('warn', `Token inválido desde ${ip}`)
    return res.status(404).send('Not found')
  }
  if (!user.brokerAccount || !user.config) {
    log('warn', `Usuario ${user.id} sin cuenta/configuración vinculada — alerta ignorada (${alert.alert_id})`)
    return res.status(200).send('OK')
  }

  // Capa 3: frescura
  const alertTime = new Date(alert.time).getTime()
  if (isNaN(alertTime)) {
    log('warn', `Fecha inválida: ${alert.time} (${alert.alert_id})`)
    return res.status(200).send('OK')
  }
  const age = Date.now() - alertTime
  if (age > MAX_AGE_MS || age < -10_000) {
    log('warn', `Fuera de ventana (${age} ms): ${alert.alert_id}`)
    return res.status(200).send('OK')
  }

  // Capa 4: duplicados (por usuario, no globalmente)
  if (isDuplicate(`${user.id}:${alert.alert_id}`)) return res.status(200).send('OK')

  // Capa 5: riesgo
  const dailyLimitTriggered = await isDailyLimitTriggered(user.id)
  const risk = checkRisk(alert, {
    allowedSymbols: user.config.allowedSymbols,
    maxLots: user.config.maxLots,
    killSwitch: user.config.killSwitch,
    dailyLimitTriggered,
  }, superadminKillSwitch)
  if (!risk.allowed) {
    log('warn', `Riesgo (${risk.reason}) usuario ${user.id}: ${alert.alert_id} ignorada`)
    return res.status(200).send('OK')
  }

  // Aceptada → loguear desfase, auditar y ejecutar en segundo plano
  const desfase = (age / 1000).toFixed(1)
  log('info', `[alerta] ${alert.ticker} ${alert.signal} ${alert.action} — desfase: ${desfase}s (usuario ${user.id})`)

  const trade = await prisma.trade.create({
    data: {
      userId: user.id,
      alertId: alert.alert_id,
      action: alert.action,
      ticker: alert.ticker,
      lots: alert.lots ?? null,
      price: alert.price,
      slPips: alert.sl_pips ?? null,
      tpPips: alert.tp_pips ?? null,
      status: 'queued',
      sourceIp: ip,
    },
  })

  res.status(200).send('OK')
  queue.push({ alert, userId: user.id, tradeId: trade.id, symbolMap: user.config.symbolMap as Record<string, string>, attempts: 0 })
  setImmediate(processQueue)

  // Copy trading: replicar en cuentas vinculadas (AccountLink status "accepted").
  // No bloquea la respuesta ni la ejecución del maestro — ver mirrorTrading.ts.
  replicateToFollowers(alert, user.id, { checkRisk, processSignal, isDuplicate, isDailyLimitTriggered, superadminKillSwitch, log })
    .catch((err) => log('error', `[mirror] Error inesperado replicando alerta de ${user.id}: ${(err as Error).message}`))
})

// Estado de todas las cuentas conectadas
app.get('/health', (_req, res) => {
  const states: Record<string, ScalperState> = {}
  for (const [key, state] of scalperState) states[key] = state
  return res.status(200).json({ accounts: allPoolStatus(), scalperState: states, superadminKillSwitch })
})

// Kill switch de EMERGENCIA global — ver nota en la declaración de superadminKillSwitch.
// El kill switch por usuario se gestiona desde el dashboard (UserConfig.killSwitch).
//
// El middleware global `express.text({ type: '*/*' })` de arriba matchea TODO
// content-type y ya consumió el body como string — un `express.json()` acá no
// vuelve a parsearlo (body-parser lo detecta ya parseado y no-opea), así que
// parseamos el string manualmente en vez de agregar un segundo parser.
app.post('/admin/kill-switch', (req: Request, res: Response) => {
  const token = req.get('authorization')?.replace('Bearer ', '') ?? ''
  if (!adminSecretMatches(token)) return res.status(404).send('Not found')

  let body: { enabled?: boolean } = {}
  try { body = JSON.parse(typeof req.body === 'string' ? req.body : '{}') }
  catch { return res.status(400).send('Bad request') }

  superadminKillSwitch = Boolean(body.enabled)
  log('warn', `Kill switch SUPERADMIN = ${superadminKillSwitch}`)
  return res.status(200).json({ superadminKillSwitch })
})

// Consultar logs por fecha: GET /admin/logs/2026-07-23
app.get('/admin/logs/:date?', (req: Request, res: Response) => {
  const token = req.get('authorization')?.replace('Bearer ', '') ?? ''
  if (!adminSecretMatches(token)) return res.status(404).send('Not found')

  const date = req.params.date ?? new Date().toISOString().slice(0, 10)
  const filepath = join(LOG_DIR, `${date}.log`)

  if (!existsSync(filepath)) {
    return res.status(200).send(`No hay logs para ${date}`)
  }

  const content = readFileSync(filepath, 'utf-8')
  res.set('Content-Type', 'text/plain')
  return res.status(200).send(content)
})

// Listar archivos de log disponibles
app.get('/admin/logs-list', (req: Request, res: Response) => {
  const token = req.get('authorization')?.replace('Bearer ', '') ?? ''
  if (!adminSecretMatches(token)) return res.status(404).send('Not found')

  const files = existsSync(LOG_DIR)
    ? readdirSync(LOG_DIR).filter(f => f.endsWith('.log')).sort().reverse()
    : []
  return res.status(200).json({ files })
})

// Catch-all
app.all('*', (req: Request, res: Response) => {
  log('warn', `[catch-all] ${req.method} ${req.path} — ruta no encontrada`)
  return res.status(404).send('Not found')
})

// ── Utilidades ───────────────────────────────────────────────

const LOG_DIR = process.env.LOG_DIR ?? '/app/logs'
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })

function log(level: 'info' | 'warn' | 'error', msg: string): void {
  const now = new Date()
  const line = `[${now.toISOString()}] [${level}] ${msg}\n`

  // Consola
  console[level === 'info' ? 'log' : level](line.trimEnd())

  // Archivo diario (ej: 2026-07-23.log)
  const filename = `${now.toISOString().slice(0, 10)}.log`
  try {
    appendFileSync(join(LOG_DIR, filename), line)
  } catch { /* no romper el servidor si falla la escritura */ }
}

// ── Arranque ─────────────────────────────────────────────────

async function start(): Promise<void> {
  await prisma.$connect()
  await initAllAccounts(rebuildStateForAccount)
  app.listen(PORT, () => log('info', `HTTP escuchando en :${PORT}`))
}

// process.env.VITEST lo setea vitest automáticamente — evita conectar a la DB
// real / cTrader / abrir el puerto HTTP cuando este módulo se importa en tests.
if (!process.env.VITEST) {
  start().catch((err) => { console.error('FATAL:', err); process.exit(1) })
}
