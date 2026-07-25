import { describe, it, expect } from 'vitest'
import { stateKey } from '../../src/server.js'

describe('stateKey', () => {
  it('scopes the key by user, so the same ticker does not collide between users', () => {
    const keyA = stateKey('user-a', 'NAS100')
    const keyB = stateKey('user-b', 'NAS100')
    expect(keyA).not.toBe(keyB)
  })

  it('normalizes the ticker to uppercase', () => {
    expect(stateKey('user-a', 'nas100')).toBe(stateKey('user-a', 'NAS100'))
  })

  it('is stable for the same user+ticker', () => {
    expect(stateKey('user-a', 'EURUSD')).toBe(stateKey('user-a', 'EURUSD'))
  })

  it('can be used as a Map key to keep independent state per user', () => {
    const scalperState = new Map<string, { direction: 'buy' | 'sell' }>()
    scalperState.set(stateKey('user-a', 'NAS100'), { direction: 'buy' })
    scalperState.set(stateKey('user-b', 'NAS100'), { direction: 'sell' })

    expect(scalperState.get(stateKey('user-a', 'NAS100'))?.direction).toBe('buy')
    expect(scalperState.get(stateKey('user-b', 'NAS100'))?.direction).toBe('sell')
  })
})
