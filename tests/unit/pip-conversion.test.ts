import { describe, it, expect } from 'vitest'
import { relativeFromPips } from '../../src/ctrader.js'

describe('relativeFromPips', () => {
  it('converts pips to relative SL for 5-digit forex (EURUSD, pipPosition 4)', () => {
    expect(relativeFromPips(20, 4)).toBe(200)
  })

  it('converts pips to relative SL for 3-digit pairs (USDJPY, pipPosition 2)', () => {
    expect(relativeFromPips(20, 2)).toBe(20000)
  })

  it('converts pips for an index with pipPosition 1', () => {
    expect(relativeFromPips(40, 1)).toBe(400000)
  })
})
