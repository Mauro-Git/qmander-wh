import { describe, it, expect } from 'vitest'
import { volumeFromLots } from '../../src/ctrader.js'

describe('volumeFromLots', () => {
  it('converts 0.01 lots to correct volume for forex (lotSize 100000)', () => {
    expect(volumeFromLots(0.01, 100000)).toBe(1000)
  })

  it('converts 1.0 lots to correct volume', () => {
    expect(volumeFromLots(1.0, 100000)).toBe(100000)
  })

  it('handles fractional lotSize used by indices (e.g. NAS100)', () => {
    expect(volumeFromLots(5, 1)).toBe(5)
  })

  it('rounds to the nearest integer', () => {
    expect(volumeFromLots(0.015, 100)).toBe(2)
  })
})
