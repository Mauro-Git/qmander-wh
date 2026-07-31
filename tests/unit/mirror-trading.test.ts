import { describe, it, expect, vi, beforeEach } from 'vitest'

const findManyMock = vi.fn()
const createMock = vi.fn()
const updateMock = vi.fn()

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    accountLink: { findMany: findManyMock },
    trade: { create: createMock, update: updateMock },
  },
}))

const { replicateToFollowers, buildMirrorAlert } = await import('../../src/mirrorTrading.js')

const baseAlert = {
  secret: 'master-token',
  alert_id: '1753500000-NAS100-scalper',
  action: 'buy' as const,
  signal: 'scalper' as const,
  ticker: 'NAS100',
  price: 21500.5,
  time: '2026-07-25T19:00:00Z',
  lots: 5,
  sl_pips: 20,
  tp_pips: 40,
}

function follower(overrides: Partial<{
  id: string
  brokerAccount: unknown
  config: { allowedSymbols: string[]; maxLots: number; killSwitch: boolean; symbolMap: unknown } | null
}> = {}) {
  return {
    id: overrides.id ?? 'follower-1',
    brokerAccount: 'brokerAccount' in overrides ? overrides.brokerAccount : { id: 'b1' },
    config: 'config' in overrides
      ? overrides.config
      : { allowedSymbols: [], maxLots: 10, killSwitch: false, symbolMap: {} },
  }
}

function link(followerRecord: ReturnType<typeof follower>) {
  return { follower: followerRecord }
}

function fakeDeps(overrides: Partial<{
  checkRisk: ReturnType<typeof vi.fn>
  processSignal: ReturnType<typeof vi.fn>
  isDuplicate: ReturnType<typeof vi.fn>
  isDailyLimitTriggered: ReturnType<typeof vi.fn>
  superadminKillSwitch: boolean
}> = {}) {
  return {
    checkRisk: overrides.checkRisk ?? vi.fn().mockReturnValue({ allowed: true }),
    processSignal: overrides.processSignal ?? vi.fn().mockResolvedValue(undefined),
    isDuplicate: overrides.isDuplicate ?? vi.fn().mockReturnValue(false),
    isDailyLimitTriggered: overrides.isDailyLimitTriggered ?? vi.fn().mockResolvedValue(false),
    superadminKillSwitch: overrides.superadminKillSwitch ?? false,
    log: vi.fn(),
  }
}

beforeEach(() => {
  findManyMock.mockReset()
  createMock.mockReset()
  updateMock.mockReset()
  createMock.mockResolvedValue({ id: 'trade-mirror-1' })
  updateMock.mockResolvedValue({})
})

describe('buildMirrorAlert', () => {
  it('derives a traceable alert_id per follower', () => {
    const result = buildMirrorAlert(baseAlert, 'follower-1', 10)
    expect(result.alert_id).toBe('1753500000-NAS100-scalper-mirror-follower-1')
  })

  it('clamps lots to the follower own maxLots, never the master lots', () => {
    const result = buildMirrorAlert(baseAlert, 'follower-1', 2)
    expect(result.lots).toBe(2)
  })

  it('keeps master lots when they are already within the follower limit', () => {
    const result = buildMirrorAlert(baseAlert, 'follower-1', 10)
    expect(result.lots).toBe(5)
  })

  it('leaves lots undefined when the master alert has none (close/exit signals)', () => {
    const { lots: _lots, ...withoutLots } = baseAlert
    const result = buildMirrorAlert(withoutLots as typeof baseAlert, 'follower-1', 10)
    expect(result.lots).toBeUndefined()
  })
})

describe('replicateToFollowers', () => {
  it('does nothing when there are no accepted links', async () => {
    findManyMock.mockResolvedValue([])
    const deps = fakeDeps()

    await replicateToFollowers(baseAlert, 'master-1', deps)

    expect(findManyMock).toHaveBeenCalledWith({
      where: { masterUserId: 'master-1', status: 'accepted' },
      include: { follower: { include: { brokerAccount: true, config: true } } },
    })
    expect(deps.processSignal).not.toHaveBeenCalled()
  })

  it('replicates buy/sell with lots clamped to the follower maxLots, not the master risk', async () => {
    const f = follower({ id: 'follower-1', config: { allowedSymbols: [], maxLots: 2, killSwitch: false, symbolMap: { NAS100: 'USTEC' } } })
    findManyMock.mockResolvedValue([link(f)])
    const deps = fakeDeps()

    await replicateToFollowers(baseAlert, 'master-1', deps)

    expect(deps.isDailyLimitTriggered).toHaveBeenCalledWith('follower-1')
    expect(deps.checkRisk).toHaveBeenCalledWith(baseAlert, {
      allowedSymbols: [], maxLots: 2, killSwitch: false, dailyLimitTriggered: false,
    }, false)
    expect(deps.processSignal).toHaveBeenCalledWith(
      expect.objectContaining({ alert_id: expect.stringContaining('-mirror-follower-1'), lots: 2 }),
      'follower-1',
      { NAS100: 'USTEC' }
    )
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 'follower-1', status: 'queued', sourceIp: 'mirror:master-1' }),
    }))
    expect(updateMock).toHaveBeenCalledWith({ where: { id: 'trade-mirror-1' }, data: { status: 'executed' } })
  })

  it('skips a follower without a linked broker account or config, without creating a Trade', async () => {
    const f = follower({ id: 'follower-2', brokerAccount: null })
    findManyMock.mockResolvedValue([link(f)])
    const deps = fakeDeps()

    await replicateToFollowers(baseAlert, 'master-1', deps)

    expect(createMock).not.toHaveBeenCalled()
    expect(deps.processSignal).not.toHaveBeenCalled()
  })

  it('honors the follower own kill switch / risk config, independent of the master', async () => {
    const f = follower({ id: 'follower-3' })
    findManyMock.mockResolvedValue([link(f)])
    const deps = fakeDeps({ checkRisk: vi.fn().mockReturnValue({ allowed: false, reason: 'user-kill-switch' }) })

    await replicateToFollowers(baseAlert, 'master-1', deps)

    expect(createMock).not.toHaveBeenCalled()
    expect(deps.processSignal).not.toHaveBeenCalled()
  })

  it('blocks replication when the follower own daily P&L limit already triggered today', async () => {
    const f = follower({ id: 'follower-daily' })
    findManyMock.mockResolvedValue([link(f)])
    const checkRisk = vi.fn((_alert, config: { dailyLimitTriggered: boolean }) =>
      config.dailyLimitTriggered ? { allowed: false, reason: 'daily-limit-triggered' as const } : { allowed: true as const }
    )
    const deps = fakeDeps({ checkRisk, isDailyLimitTriggered: vi.fn().mockResolvedValue(true) })

    await replicateToFollowers(baseAlert, 'master-1', deps)

    expect(checkRisk).toHaveBeenCalledWith(baseAlert, expect.objectContaining({ dailyLimitTriggered: true }), false)
    expect(createMock).not.toHaveBeenCalled()
    expect(deps.processSignal).not.toHaveBeenCalled()
  })

  it('skips an already-seen mirror alert_id (idempotency, e.g. TradingView retries)', async () => {
    const f = follower({ id: 'follower-4' })
    findManyMock.mockResolvedValue([link(f)])
    const deps = fakeDeps({ isDuplicate: vi.fn().mockReturnValue(true) })

    await replicateToFollowers(baseAlert, 'master-1', deps)

    expect(createMock).not.toHaveBeenCalled()
    expect(deps.processSignal).not.toHaveBeenCalled()
  })

  it('retries a transient failure up to 3 times before giving up, marking failed only after the last attempt', async () => {
    vi.useFakeTimers()
    try {
      const f = follower({ id: 'follower-5' })
      findManyMock.mockResolvedValue([link(f)])
      const processSignal = vi.fn().mockRejectedValue(new Error('cuenta desconectada'))
      const deps = fakeDeps({ processSignal })

      const promise = replicateToFollowers(baseAlert, 'master-1', deps)
      await vi.advanceTimersByTimeAsync(100000)
      await expect(promise).resolves.toBeUndefined()

      expect(processSignal).toHaveBeenCalledTimes(3)
      expect(updateMock).toHaveBeenCalledWith({
        where: { id: 'trade-mirror-1' },
        data: { status: 'retrying', error: 'cuenta desconectada' },
      })
      expect(updateMock).toHaveBeenCalledWith({
        where: { id: 'trade-mirror-1' },
        data: { status: 'failed', error: 'cuenta desconectada' },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks executed if a retry succeeds after a transient failure, without exhausting all attempts', async () => {
    vi.useFakeTimers()
    try {
      const f = follower({ id: 'follower-retry' })
      findManyMock.mockResolvedValue([link(f)])
      const processSignal = vi.fn()
        .mockRejectedValueOnce(new Error('timeout esperando respuesta'))
        .mockResolvedValueOnce(undefined)
      const deps = fakeDeps({ processSignal })

      const promise = replicateToFollowers(baseAlert, 'master-1', deps)
      await vi.advanceTimersByTimeAsync(100000)
      await promise

      expect(processSignal).toHaveBeenCalledTimes(2)
      expect(updateMock).toHaveBeenCalledWith({
        where: { id: 'trade-mirror-1' },
        data: { status: 'retrying', error: 'timeout esperando respuesta' },
      })
      expect(updateMock).toHaveBeenCalledWith({ where: { id: 'trade-mirror-1' }, data: { status: 'executed' } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let one failing follower affect the others (Promise.allSettled)', async () => {
    vi.useFakeTimers()
    try {
      const ok = follower({ id: 'follower-ok' })
      const bad = follower({ id: 'follower-bad' })
      findManyMock.mockResolvedValue([link(bad), link(ok)])
      const processSignal = vi.fn(async (_alert: unknown, userId: string) => {
        if (userId === 'follower-bad') throw new Error('falla vinculado malo')
      })
      const deps = fakeDeps({ processSignal })

      const promise = replicateToFollowers(baseAlert, 'master-1', deps)
      await vi.advanceTimersByTimeAsync(100000)
      await promise

      // follower-bad agota los 3 intentos, follower-ok se resuelve al primero.
      expect(processSignal).toHaveBeenCalledTimes(4)
      expect(updateMock).toHaveBeenCalledWith({ where: { id: 'trade-mirror-1' }, data: { status: 'executed' } })
      expect(updateMock).toHaveBeenCalledWith({ where: { id: 'trade-mirror-1' }, data: { status: 'failed', error: 'falla vinculado malo' } })
    } finally {
      vi.useRealTimers()
    }
  })
})
