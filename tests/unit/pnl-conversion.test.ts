import { describe, it, expect } from 'vitest'
import { scaleMoney, computeNetPnl } from '../../src/ctrader.js'

describe('scaleMoney', () => {
  it('scales an int64 raw value by 10^moneyDigits', () => {
    expect(scaleMoney(12345, 2)).toBeCloseTo(123.45)
  })

  it('handles moneyDigits = 8 (common for high-precision assets)', () => {
    expect(scaleMoney(100000000, 8)).toBeCloseTo(1)
  })

  it('handles negative raw values (e.g. a loss)', () => {
    expect(scaleMoney(-5000, 2)).toBeCloseTo(-50)
  })

  it('handles moneyDigits = 0 (no scaling)', () => {
    expect(scaleMoney(42, 0)).toBe(42)
  })
})

describe('computeNetPnl', () => {
  it('sums grossProfit + swap + commission, all scaled the same way', () => {
    // grossProfit=$100, swap=-$2, commission=-$5 (comisión ya viene negativa) -> neto $93
    const net = computeNetPnl({ grossProfit: 10000, swap: -200, commission: -500, moneyDigits: 2 })
    expect(net).toBeCloseTo(93)
  })

  it('a losing trade nets negative even with positive swap', () => {
    // grossProfit=-$50, swap=+$1, commission=-$3 -> neto -$52
    const net = computeNetPnl({ grossProfit: -5000, swap: 100, commission: -300, moneyDigits: 2 })
    expect(net).toBeCloseTo(-52)
  })

  it('a breakeven trade with only costs nets negative by exactly the costs', () => {
    const net = computeNetPnl({ grossProfit: 0, swap: -50, commission: -200, moneyDigits: 2 })
    expect(net).toBeCloseTo(-2.5)
  })
})
