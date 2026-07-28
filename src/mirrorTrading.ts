/**
 * Copy trading: replica cada alerta ejecutada para el maestro en las cuentas
 * de los usuarios vinculados (AccountLink, status "accepted"). Un maestro
 * puede tener varios vinculados activos (uno-a-muchos).
 *
 * Cada vinculado respeta SIEMPRE su propio riesgo (killSwitch, allowedSymbols,
 * maxLots) — nunca hereda el del maestro. Un fallo replicando en un vinculado
 * no afecta la ejecución ya hecha para el maestro (Promise.allSettled).
 *
 * Dependencias del motor de señales (processSignal, checkRisk, etc.) se
 * inyectan por parámetro en vez de importarse directo de server.ts, para
 * evitar un import circular (server.ts es quien importa este módulo).
 */

import { prisma } from './lib/prisma.js'
import type { Alert, UserRiskConfig, RiskDenyReason } from './server.js'

export type MirrorRiskCheck = (
  alert: { ticker: string; lots?: number },
  config: UserRiskConfig,
  superadminKillSwitch: boolean
) => { allowed: true } | { allowed: false; reason: RiskDenyReason }

export interface MirrorDeps {
  checkRisk: MirrorRiskCheck
  processSignal: (alert: Alert, userId: string, symbolMap: Record<string, string>) => Promise<void>
  isDuplicate: (id: string) => boolean
  isDailyLimitTriggered: (userId: string) => Promise<boolean>
  superadminKillSwitch: boolean
  log: (level: 'info' | 'warn' | 'error', msg: string) => void
}

/** Alerta derivada para el vinculado: mismo alert_id trazable + lotes acotados a su propio maxLots. */
export function buildMirrorAlert(alert: Alert, followerId: string, followerMaxLots: number): Alert {
  return {
    ...alert,
    alert_id: `${alert.alert_id}-mirror-${followerId}`,
    lots: alert.lots !== undefined ? Math.min(alert.lots, followerMaxLots) : alert.lots,
  }
}

interface FollowerRecord {
  id: string
  brokerAccount: unknown
  config: Omit<UserRiskConfig, 'dailyLimitTriggered'> & { symbolMap: unknown } | null
}

export async function replicateToFollowers(alert: Alert, masterUserId: string, deps: MirrorDeps): Promise<void> {
  const links = await prisma.accountLink.findMany({
    where: { masterUserId, status: 'accepted' },
    include: { follower: { include: { brokerAccount: true, config: true } } },
  })
  if (links.length === 0) return

  await Promise.allSettled(
    links.map((link) => replicateToFollower(alert, masterUserId, link.follower as FollowerRecord, deps))
  )
}

async function replicateToFollower(
  alert: Alert,
  masterUserId: string,
  follower: FollowerRecord,
  deps: MirrorDeps
): Promise<void> {
  if (!follower.brokerAccount || !follower.config) return // vinculado sin cuenta/config aún — nada que replicar

  const mirrorAlertId = `${alert.alert_id}-mirror-${follower.id}`
  if (deps.isDuplicate(`${follower.id}:${mirrorAlertId}`)) return

  const dailyLimitTriggered = await deps.isDailyLimitTriggered(follower.id)
  const risk = deps.checkRisk(alert, {
    allowedSymbols: follower.config.allowedSymbols,
    maxLots: follower.config.maxLots,
    killSwitch: follower.config.killSwitch,
    dailyLimitTriggered,
  }, deps.superadminKillSwitch)
  if (!risk.allowed) {
    deps.log('info', `[mirror] Riesgo (${risk.reason}) vinculado ${follower.id}: ${mirrorAlertId} ignorada`)
    return
  }

  const mirrorAlert = buildMirrorAlert(alert, follower.id, follower.config.maxLots)

  const trade = await prisma.trade.create({
    data: {
      userId: follower.id,
      alertId: mirrorAlertId,
      action: alert.action,
      ticker: alert.ticker,
      lots: mirrorAlert.lots ?? null,
      price: alert.price,
      slPips: alert.sl_pips ?? null,
      tpPips: alert.tp_pips ?? null,
      status: 'queued',
      sourceIp: `mirror:${masterUserId}`,
    },
  })

  try {
    await deps.processSignal(mirrorAlert, follower.id, follower.config.symbolMap as Record<string, string>)
    await prisma.trade.update({ where: { id: trade.id }, data: { status: 'executed' } })
  } catch (err) {
    const message = (err as Error).message
    deps.log('error', `[mirror] Fallo replicando en vinculado ${follower.id}: ${message}`)
    await prisma.trade.update({ where: { id: trade.id }, data: { status: 'failed', error: message } })
      .catch(() => {})
  }
}
