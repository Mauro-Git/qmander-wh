import { describe, it, expect } from 'vitest'
import { checkDailyLimit, type DailyLimitConfig } from '../../src/dailyPnlGuard.js'

const noLimits: DailyLimitConfig = {
  dailyProfitTarget: null, dailyProfitTargetType: 'percent',
  dailyLossLimit: null, dailyLossLimitType: 'percent',
}

describe('checkDailyLimit', () => {
  it('never triggers when both limits are null', () => {
    expect(checkDailyLimit(noLimits, 10000, 5000).triggered).toBe(false)
    expect(checkDailyLimit(noLimits, 10000, -5000).triggered).toBe(false)
  })

  it('triggers profit target as a percent of startBalance', () => {
    const config: DailyLimitConfig = { ...noLimits, dailyProfitTarget: 5, dailyProfitTargetType: 'percent' }
    // 5% of 10000 = 500
    expect(checkDailyLimit(config, 10000, 499).triggered).toBe(false)
    expect(checkDailyLimit(config, 10000, 500)).toEqual({ triggered: true, reason: 'profit-target' })
  })

  it('triggers profit target as a fixed USD amount', () => {
    const config: DailyLimitConfig = { ...noLimits, dailyProfitTarget: 200, dailyProfitTargetType: 'fixed' }
    expect(checkDailyLimit(config, 10000, 199).triggered).toBe(false)
    expect(checkDailyLimit(config, 10000, 200)).toEqual({ triggered: true, reason: 'profit-target' })
  })

  it('triggers loss limit as a percent of startBalance', () => {
    const config: DailyLimitConfig = { ...noLimits, dailyLossLimit: 5, dailyLossLimitType: 'percent' }
    // 5% of 10000 = 500 -> triggers at realizedPnl <= -500
    expect(checkDailyLimit(config, 10000, -499).triggered).toBe(false)
    expect(checkDailyLimit(config, 10000, -500)).toEqual({ triggered: true, reason: 'loss-limit' })
  })

  it('triggers loss limit as a fixed USD amount', () => {
    const config: DailyLimitConfig = { ...noLimits, dailyLossLimit: 100, dailyLossLimitType: 'fixed' }
    expect(checkDailyLimit(config, 10000, -99).triggered).toBe(false)
    expect(checkDailyLimit(config, 10000, -100)).toEqual({ triggered: true, reason: 'loss-limit' })
  })

  it('does not confuse a profit with the loss limit or vice versa', () => {
    const config: DailyLimitConfig = { ...noLimits, dailyLossLimit: 100, dailyLossLimitType: 'fixed' }
    expect(checkDailyLimit(config, 10000, 5000).triggered).toBe(false)
  })

  it('evaluates both limits together, profit target wins if both configured and profit is hit', () => {
    const config: DailyLimitConfig = {
      dailyProfitTarget: 100, dailyProfitTargetType: 'fixed',
      dailyLossLimit: 100, dailyLossLimitType: 'fixed',
    }
    expect(checkDailyLimit(config, 10000, 150)).toEqual({ triggered: true, reason: 'profit-target' })
    expect(checkDailyLimit(config, 10000, -150)).toEqual({ triggered: true, reason: 'loss-limit' })
    expect(checkDailyLimit(config, 10000, 50).triggered).toBe(false)
  })
})
