/**
 * Enforcement de límites diarios de ganancia/pérdida (UserConfig.dailyProfitTarget
 * / dailyLossLimit). Se alimenta del P&L realizado real que reporta cTrader al
 * cerrar cada posición (CTraderAccount.onPositionClosed) — no se estima a partir
 * del precio de la alerta de TradingView.
 *
 * Corte de día: medianoche UTC (mismo criterio que utcDay() en ctrader.ts).
 * Si el límite se cruza, se cierran todas las posiciones y se activa
 * UserConfig.killSwitch. Una vez disparado (`triggered`), no se vuelve a
 * evaluar ese mismo día aunque el usuario reactive killSwitch a mano.
 */

import { prisma } from './lib/prisma.js'
import type { CTraderAccount } from './ctrader.js'

export interface DailyLimitConfig {
  dailyProfitTarget: number | null
  dailyProfitTargetType: string // 'percent' | 'fixed'
  dailyLossLimit: number | null
  dailyLossLimitType: string
}

export type DailyLimitReason = 'profit-target' | 'loss-limit'

export function checkDailyLimit(
  config: DailyLimitConfig,
  startBalance: number,
  realizedPnl: number
): { triggered: boolean; reason?: DailyLimitReason } {
  if (config.dailyProfitTarget != null) {
    const threshold = config.dailyProfitTargetType === 'fixed'
      ? config.dailyProfitTarget
      : startBalance * (config.dailyProfitTarget / 100)
    if (realizedPnl >= threshold) return { triggered: true, reason: 'profit-target' }
  }
  if (config.dailyLossLimit != null) {
    const threshold = config.dailyLossLimitType === 'fixed'
      ? config.dailyLossLimit
      : startBalance * (config.dailyLossLimit / 100)
    if (realizedPnl <= -threshold) return { triggered: true, reason: 'loss-limit' }
  }
  return { triggered: false }
}

function utcMidnight(): Date {
  return new Date(new Date().toISOString().slice(0, 10))
}

// Registro sin import circular: server.ts se registra una vez al arrancar para
// limpiar el scalperState en memoria del usuario cuando este módulo dispara un
// cierre por límite diario.
let clearStateHook: ((userId: string) => void) | null = null
export function onDailyLimitClearState(fn: (userId: string) => void): void {
  clearStateHook = fn
}

/** Cuenta mínima que necesita recordRealizedPnl — evita acoplar los tests a un CTraderAccount real. */
export type PnlAwareAccount = Pick<CTraderAccount, 'userId' | 'name' | 'closeAllPositions'>

export async function recordRealizedPnl(
  account: PnlAwareAccount,
  info: { netPnl: number; balanceAfterClose: number }
): Promise<void> {
  try {
    const day = utcMidnight()
    const startBalanceForNewRow = info.balanceAfterClose - info.netPnl

    const state = await prisma.dailyPnlState.upsert({
      where: { userId_day: { userId: account.userId, day } },
      create: { userId: account.userId, day, startBalance: startBalanceForNewRow, realizedPnl: info.netPnl },
      update: { realizedPnl: { increment: info.netPnl } },
    })

    if (state.triggered) return

    const config = await prisma.userConfig.findUnique({ where: { userId: account.userId } })
    if (!config) return

    const startBalance = state.startBalance ?? startBalanceForNewRow
    const result = checkDailyLimit(config, startBalance, state.realizedPnl)
    if (!result.triggered) return

    // Compare-and-set atómico: solo el evento que efectivamente gana la carrera dispara el cierre.
    const claimed = await prisma.dailyPnlState.updateMany({
      where: { id: state.id, triggered: false },
      data: { triggered: true },
    })
    if (claimed.count === 0) return

    console.warn(
      `[dailyPnlGuard] ${account.name}: límite diario alcanzado (${result.reason}), ` +
      `realizedPnl=${state.realizedPnl.toFixed(2)} startBalance=${startBalance.toFixed(2)} — cerrando todo y activando killSwitch`
    )

    await account.closeAllPositions().catch((err) => {
      console.error(`[dailyPnlGuard] ${account.name}: error cerrando posiciones: ${(err as Error).message}`)
    })
    await prisma.userConfig.update({ where: { userId: account.userId }, data: { killSwitch: true } })
    clearStateHook?.(account.userId)
  } catch (err) {
    console.error(`[dailyPnlGuard] Error procesando P&L de ${account.name}: ${(err as Error).message}`)
  }
}
