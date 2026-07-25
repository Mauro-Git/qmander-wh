import { describe, it, expect, vi, beforeEach } from 'vitest'

const findUniqueMock = vi.fn()

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: { user: { findUnique: findUniqueMock } },
}))

// accountPool y ctrader abren conexiones reales al importarse indirectamente
// desde server.ts en producción, pero solo dentro de start() — que está
// guardado por `if (!process.env.VITEST)`, así que importar server.ts en
// tests no dispara nada de red.
const { resolveUserFromSecret, AlertSchema } = await import('../../src/server.js')

describe('resolveUserFromSecret', () => {
  beforeEach(() => findUniqueMock.mockReset())

  it('looks up the user by webhookToken, including brokerAccount and config', async () => {
    const fakeUser = { id: 'user-1', brokerAccount: { id: 'b1' }, config: { id: 'c1' } }
    findUniqueMock.mockResolvedValue(fakeUser)

    const result = await resolveUserFromSecret('cmrzmfojx0000t3w3p3cb6fl3')

    expect(result).toBe(fakeUser)
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { webhookToken: 'cmrzmfojx0000t3w3p3cb6fl3' },
      include: { brokerAccount: true, config: true },
    })
  })

  it('returns null when no user matches the token', async () => {
    findUniqueMock.mockResolvedValue(null)
    const result = await resolveUserFromSecret('token-que-no-existe')
    expect(result).toBeNull()
  })
})

describe('AlertSchema', () => {
  const validPayload = {
    secret: 'cmrzmfojx0000t3w3p3cb6fl3', // cuid, ~25 chars — no 32+ como el viejo WEBHOOK_SECRET
    alert_id: '1753500000-NAS100-scalper',
    action: 'buy',
    signal: 'scalper',
    ticker: 'NAS100',
    price: 21500.5,
    time: '2026-07-25T19:00:00Z',
    lots: 5,
    sl_pips: 20,
    tp_pips: 40,
  }

  it('accepts a realistic cuid-length webhookToken as secret', () => {
    expect(AlertSchema.safeParse(validPayload).success).toBe(true)
  })

  it('rejects a payload missing required fields', () => {
    const { ticker: _ticker, ...withoutTicker } = validPayload
    expect(AlertSchema.safeParse(withoutTicker).success).toBe(false)
  })

  it('rejects an invalid signal value', () => {
    expect(AlertSchema.safeParse({ ...validPayload, signal: 'not-a-signal' }).success).toBe(false)
  })

  it('rejects an invalid action value', () => {
    expect(AlertSchema.safeParse({ ...validPayload, action: 'hold' }).success).toBe(false)
  })

  it('accepts a payload without the optional sl_pips/tp_pips/lots', () => {
    const { lots: _lots, sl_pips: _sl, tp_pips: _tp, ...minimal } = validPayload
    expect(AlertSchema.safeParse(minimal).success).toBe(true)
  })
})
