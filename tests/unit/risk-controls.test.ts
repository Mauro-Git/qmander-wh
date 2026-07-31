import { describe, it, expect } from 'vitest'
import { checkRisk, type UserRiskConfig } from '../../src/server.js'

const baseConfig: UserRiskConfig = { allowedSymbols: [], maxLots: 5, killSwitch: false, dailyLimitTriggered: false }

describe('checkRisk', () => {
  it('allows a valid alert within limits', () => {
    const result = checkRisk({ ticker: 'NAS100', lots: 3 }, baseConfig, false)
    expect(result.allowed).toBe(true)
  })

  it('denies everything when the superadmin kill switch is active, even if the user config allows it', () => {
    const result = checkRisk({ ticker: 'NAS100', lots: 1 }, baseConfig, true)
    expect(result).toEqual({ allowed: false, reason: 'superadmin-kill-switch' })
  })

  it('denies when the per-user kill switch is active', () => {
    const config: UserRiskConfig = { ...baseConfig, killSwitch: true }
    const result = checkRisk({ ticker: 'NAS100', lots: 1 }, config, false)
    expect(result).toEqual({ allowed: false, reason: 'user-kill-switch' })
  })

  it('denies when the daily P&L limit already triggered today, without touching the manual kill switch', () => {
    const config: UserRiskConfig = { ...baseConfig, dailyLimitTriggered: true }
    const result = checkRisk({ ticker: 'NAS100', lots: 1 }, config, false)
    expect(result).toEqual({ allowed: false, reason: 'daily-limit-triggered' })
    expect(config.killSwitch).toBe(false)
  })

  it('denies a symbol not in the allowlist', () => {
    const config: UserRiskConfig = { ...baseConfig, allowedSymbols: ['EURUSD'] }
    const result = checkRisk({ ticker: 'NAS100', lots: 1 }, config, false)
    expect(result).toEqual({ allowed: false, reason: 'symbol-not-allowed' })
  })

  it('allows a symbol in the allowlist regardless of case', () => {
    const config: UserRiskConfig = { ...baseConfig, allowedSymbols: ['NAS100'] }
    const result = checkRisk({ ticker: 'nas100', lots: 1 }, config, false)
    expect(result.allowed).toBe(true)
  })

  it('does not restrict symbols when the allowlist is empty', () => {
    const result = checkRisk({ ticker: 'ANYTHING', lots: 1 }, baseConfig, false)
    expect(result.allowed).toBe(true)
  })

  it('denies lots exceeding maxLots', () => {
    const config: UserRiskConfig = { ...baseConfig, maxLots: 2 }
    const result = checkRisk({ ticker: 'NAS100', lots: 2.5 }, config, false)
    expect(result).toEqual({ allowed: false, reason: 'max-lots-exceeded' })
  })

  it('allows when lots is omitted (treated as 0)', () => {
    const result = checkRisk({ ticker: 'NAS100' }, baseConfig, false)
    expect(result.allowed).toBe(true)
  })

  it('one user kill switch does not affect another user (no shared state)', () => {
    const userA: UserRiskConfig = { ...baseConfig, killSwitch: true }
    const userB: UserRiskConfig = { ...baseConfig, killSwitch: false }
    expect(checkRisk({ ticker: 'NAS100' }, userA, false).allowed).toBe(false)
    expect(checkRisk({ ticker: 'NAS100' }, userB, false).allowed).toBe(true)
  })

  it('always allows exit/close_all even with the user kill switch active — closing must never get trapped', () => {
    const config: UserRiskConfig = { ...baseConfig, killSwitch: true }
    expect(checkRisk({ ticker: 'NAS100', signal: 'exit' }, config, false).allowed).toBe(true)
    expect(checkRisk({ ticker: 'NAS100', signal: 'close_all' }, config, false).allowed).toBe(true)
  })

  it('always allows exit/close_all even with the daily limit already triggered', () => {
    const config: UserRiskConfig = { ...baseConfig, dailyLimitTriggered: true }
    expect(checkRisk({ ticker: 'NAS100', signal: 'exit' }, config, false).allowed).toBe(true)
  })

  it('always allows exit/close_all even for a symbol outside the allowlist or lots over maxLots', () => {
    const config: UserRiskConfig = { ...baseConfig, allowedSymbols: ['EURUSD'], maxLots: 1 }
    const result = checkRisk({ ticker: 'NAS100', lots: 99, signal: 'close_all' }, config, false)
    expect(result.allowed).toBe(true)
  })

  it('the superadmin emergency kill switch still blocks exit/close_all — it freezes everything', () => {
    const result = checkRisk({ ticker: 'NAS100', signal: 'close_all' }, baseConfig, true)
    expect(result).toEqual({ allowed: false, reason: 'superadmin-kill-switch' })
  })

  it('scalper/smart_trail signals still go through the normal risk checks (only exit/close_all are exempt)', () => {
    const config: UserRiskConfig = { ...baseConfig, killSwitch: true }
    expect(checkRisk({ ticker: 'NAS100', signal: 'scalper' }, config, false).allowed).toBe(false)
    expect(checkRisk({ ticker: 'NAS100', signal: 'smart_trail' }, config, false).allowed).toBe(false)
  })
})
