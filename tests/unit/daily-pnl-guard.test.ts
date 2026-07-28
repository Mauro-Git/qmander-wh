import { describe, it, expect, vi, beforeEach } from 'vitest'

const upsertMock = vi.fn()
const updateManyMock = vi.fn()
const findUniqueMock = vi.fn()
const dailyPnlStateFindUniqueMock = vi.fn()
const updateMock = vi.fn()

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    dailyPnlState: { upsert: upsertMock, updateMany: updateManyMock, findUnique: dailyPnlStateFindUniqueMock },
    userConfig: { findUnique: findUniqueMock, update: updateMock },
  },
}))

const { recordRealizedPnl, onDailyLimitClearState, isDailyLimitTriggered } = await import('../../src/dailyPnlGuard.js')

function fakeAccount(overrides: Partial<{ closeAllPositions: ReturnType<typeof vi.fn> }> = {}) {
  return {
    userId: 'user-1',
    name: 'Test User',
    closeAllPositions: overrides.closeAllPositions ?? vi.fn().mockResolvedValue(0),
  }
}

const noLimitConfig = {
  dailyProfitTarget: null, dailyProfitTargetType: 'percent',
  dailyLossLimit: 100, dailyLossLimitType: 'fixed',
}

beforeEach(() => {
  upsertMock.mockReset()
  updateManyMock.mockReset()
  findUniqueMock.mockReset()
  dailyPnlStateFindUniqueMock.mockReset()
  updateMock.mockReset()
  onDailyLimitClearState(() => {}) // reset a no-op hook between tests
})

describe('recordRealizedPnl', () => {
  it('upserts with an atomic increment, not a read-then-write', async () => {
    upsertMock.mockResolvedValue({ id: 's1', triggered: false, startBalance: 10000, realizedPnl: -10 })
    findUniqueMock.mockResolvedValue(noLimitConfig)

    await recordRealizedPnl(fakeAccount(), { netPnl: -10, balanceAfterClose: 9990 })

    expect(upsertMock).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ startBalance: 10000, realizedPnl: -10 }),
      update: { realizedPnl: { increment: -10 } },
    }))
  })

  it('does not close positions or touch UserConfig when under the threshold', async () => {
    upsertMock.mockResolvedValue({ id: 's1', triggered: false, startBalance: 10000, realizedPnl: -10 })
    findUniqueMock.mockResolvedValue(noLimitConfig)
    const closeAllPositions = vi.fn().mockResolvedValue(0)

    await recordRealizedPnl(fakeAccount({ closeAllPositions }), { netPnl: -10, balanceAfterClose: 9990 })

    expect(closeAllPositions).not.toHaveBeenCalled()
    expect(updateMock).not.toHaveBeenCalled()
    expect(updateManyMock).not.toHaveBeenCalled()
  })

  it('closes all positions, marks DailyPnlState triggered+reason+triggeredAt, and clears in-memory state exactly once when the limit is crossed — without touching UserConfig.killSwitch', async () => {
    upsertMock.mockResolvedValue({ id: 's1', triggered: false, startBalance: 10000, realizedPnl: -100 })
    findUniqueMock.mockResolvedValue(noLimitConfig) // dailyLossLimit: 100 fixed
    updateManyMock.mockResolvedValue({ count: 1 }) // ganamos la carrera del compare-and-set
    const closeAllPositions = vi.fn().mockResolvedValue(2)
    const clearState = vi.fn()
    onDailyLimitClearState(clearState)

    await recordRealizedPnl(fakeAccount({ closeAllPositions }), { netPnl: -100, balanceAfterClose: 9900 })

    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: 's1', triggered: false },
      data: { triggered: true, reason: 'loss-limit', triggeredAt: expect.any(Date) },
    })
    expect(closeAllPositions).toHaveBeenCalledOnce()
    expect(updateMock).not.toHaveBeenCalled() // UserConfig.killSwitch es exclusivamente el toggle manual
    expect(clearState).toHaveBeenCalledWith('user-1')
  })

  it('does nothing further once the row is already triggered (no re-evaluation)', async () => {
    upsertMock.mockResolvedValue({ id: 's1', triggered: true, startBalance: 10000, realizedPnl: -300 })
    const closeAllPositions = vi.fn()

    await recordRealizedPnl(fakeAccount({ closeAllPositions }), { netPnl: -50, balanceAfterClose: 9650 })

    expect(findUniqueMock).not.toHaveBeenCalled()
    expect(closeAllPositions).not.toHaveBeenCalled()
    expect(updateMock).not.toHaveBeenCalled()
  })

  it('loses the compare-and-set race gracefully: does not double-close when another event already claimed the trigger', async () => {
    upsertMock.mockResolvedValue({ id: 's1', triggered: false, startBalance: 10000, realizedPnl: -100 })
    findUniqueMock.mockResolvedValue(noLimitConfig)
    updateManyMock.mockResolvedValue({ count: 0 }) // otro evento concurrente ya lo disparó
    const closeAllPositions = vi.fn()
    const clearState = vi.fn()
    onDailyLimitClearState(clearState)

    await recordRealizedPnl(fakeAccount({ closeAllPositions }), { netPnl: -100, balanceAfterClose: 9900 })

    expect(closeAllPositions).not.toHaveBeenCalled()
    expect(updateMock).not.toHaveBeenCalled()
    expect(clearState).not.toHaveBeenCalled()
  })

  it('still marks the trigger even if closing positions fails (fail-safe: prefer blocked-over-open)', async () => {
    upsertMock.mockResolvedValue({ id: 's1', triggered: false, startBalance: 10000, realizedPnl: -100 })
    findUniqueMock.mockResolvedValue(noLimitConfig)
    updateManyMock.mockResolvedValue({ count: 1 })
    const closeAllPositions = vi.fn().mockRejectedValue(new Error('WS caído'))
    const clearState = vi.fn()
    onDailyLimitClearState(clearState)

    await recordRealizedPnl(fakeAccount({ closeAllPositions }), { netPnl: -100, balanceAfterClose: 9900 })

    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: 's1', triggered: false },
      data: { triggered: true, reason: 'loss-limit', triggeredAt: expect.any(Date) },
    })
    expect(clearState).toHaveBeenCalledWith('user-1')
  })

  it('never throws, even if Prisma rejects', async () => {
    upsertMock.mockRejectedValue(new Error('DB caída'))
    await expect(recordRealizedPnl(fakeAccount(), { netPnl: 10, balanceAfterClose: 100 })).resolves.toBeUndefined()
  })
})

describe('isDailyLimitTriggered', () => {
  it('returns false when there is no DailyPnlState row for today', async () => {
    dailyPnlStateFindUniqueMock.mockResolvedValue(null)
    await expect(isDailyLimitTriggered('user-1')).resolves.toBe(false)
  })

  it('returns true when today row has triggered=true', async () => {
    dailyPnlStateFindUniqueMock.mockResolvedValue({ triggered: true })
    await expect(isDailyLimitTriggered('user-1')).resolves.toBe(true)
  })

  it('returns false when today row has triggered=false', async () => {
    dailyPnlStateFindUniqueMock.mockResolvedValue({ triggered: false })
    await expect(isDailyLimitTriggered('user-1')).resolves.toBe(false)
  })
})
