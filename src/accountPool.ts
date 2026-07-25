/**
 * Pool de conexiones cTrader por usuario — puente entre PostgreSQL (Prisma) y
 * CTraderAccount (que es agnóstico de la DB).
 *
 * Estrategia: conexión eager de todas las cuentas al arrancar
 * (initAllAccounts), más un fallback perezoso (getAccountForUser) para
 * usuarios que vinculan su cuenta de cTrader después de que el proceso ya
 * arrancó — evita tener que reiniciar el webhook en cada alta.
 */

import type { BrokerAccount, UserConfig } from '@prisma/client'
import { prisma } from './lib/prisma.js'
import { decryptField, encryptField } from './lib/crypto.js'
import { refreshAccessToken } from './lib/ctrader-oauth.js'
import { CTraderAccount } from './ctrader.js'

// Renovar si faltan menos de 48h para el vencimiento (~30 días de vida total).
const REFRESH_MARGIN_MS = 48 * 60 * 60 * 1000

const pool = new Map<string, CTraderAccount>()
const inflight = new Map<string, Promise<CTraderAccount | null>>()

type OnAccountReady = (account: CTraderAccount) => Promise<void> | void

type BrokerAccountWithConfig = BrokerAccount & { userConfig: UserConfig | null; userName: string }

async function ensureFreshAccessToken(broker: BrokerAccount): Promise<string> {
  const accessToken = decryptField(broker.accessTokenEnc)

  const needsRefresh = broker.expiresAt !== null
    && broker.expiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS

  if (!needsRefresh) return accessToken

  const refreshToken = decryptField(broker.refreshTokenEnc)
  const tokens = await refreshAccessToken(refreshToken)

  await prisma.brokerAccount.update({
    where: { id: broker.id },
    data: {
      accessTokenEnc: encryptField(tokens.accessToken),
      refreshTokenEnc: encryptField(tokens.refreshToken),
      expiresAt: new Date(Date.now() + tokens.expiresIn * 1000),
    },
  })

  return tokens.accessToken
}

async function connectAccount(broker: BrokerAccountWithConfig, onAccountReady?: OnAccountReady): Promise<CTraderAccount | null> {
  try {
    const accessToken = await ensureFreshAccessToken(broker)
    const symbolMap = (broker.userConfig?.symbolMap ?? {}) as Record<string, string>

    const account = new CTraderAccount({
      userId: broker.userId,
      name: broker.userName,
      host: broker.ctraderHost,
      accessToken,
      accountId: Number(broker.accountId),
      symbolMap,
      onDisconnect: () => {
        pool.delete(broker.userId)
        prisma.brokerAccount.update({ where: { id: broker.id }, data: { status: 'disconnected' } }).catch(() => {})
      },
    })

    await account.connect()
    pool.set(broker.userId, account)
    await prisma.brokerAccount.update({ where: { id: broker.id }, data: { status: 'connected' } })

    if (onAccountReady) await onAccountReady(account)
    return account
  } catch (err) {
    console.error(`[accountPool] Error al conectar usuario ${broker.userId}: ${(err as Error).message}`)
    await prisma.brokerAccount.update({ where: { id: broker.id }, data: { status: 'error' } }).catch(() => {})
    return null
  }
}

export async function initAllAccounts(onAccountReady?: OnAccountReady): Promise<void> {
  const brokers = await prisma.brokerAccount.findMany({
    include: { user: { include: { config: true } } },
  })

  if (brokers.length === 0) {
    console.log('[accountPool] No hay BrokerAccount vinculados en la DB')
    return
  }

  const results = await Promise.allSettled(
    brokers.map((b) => connectAccount({ ...b, userConfig: b.user.config, userName: b.user.name ?? b.user.email }, onAccountReady))
  )

  const connected = results.filter((r) => r.status === 'fulfilled' && r.value !== null).length
  console.log(`[accountPool] ${connected} de ${brokers.length} cuentas conectadas al arrancar`)
}

export async function getAccountForUser(userId: string, onAccountReady?: OnAccountReady): Promise<CTraderAccount | null> {
  const cached = pool.get(userId)
  if (cached?.connected) return cached

  const existingInflight = inflight.get(userId)
  if (existingInflight) return existingInflight

  const connectPromise = (async () => {
    const broker = await prisma.brokerAccount.findUnique({
      where: { userId },
      include: { user: { include: { config: true } } },
    })
    if (!broker) return null
    return connectAccount({ ...broker, userConfig: broker.user.config, userName: broker.user.name ?? broker.user.email }, onAccountReady)
  })()

  inflight.set(userId, connectPromise)
  try {
    return await connectPromise
  } finally {
    inflight.delete(userId)
  }
}

export function allPoolStatus() {
  return Array.from(pool.values()).map((a) => a.status())
}
