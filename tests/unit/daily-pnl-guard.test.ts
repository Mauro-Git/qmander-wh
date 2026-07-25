import { describe, it, expect, vi, beforeEach } from 'vitest'

const upsertMock = vi.fn()
const updateManyMock = vi.fn()
const findUniqueMock = vi.fn()
const updateMock = vi.fn()

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    dailyPnlState: { upsert: upsertMock, updateMany: updateManyMock },
    userConfig: { findUnique: findUniqueMock, update: updateMock },
  },
}))

const { recordRealizedPnl, onDailyLimitClearState } = await import('../../src/dailyPnlGuard.js')

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

  it('does not close positions or touch killSwitch when under the threshold', async () => {
    upsertMock.mockResolvedValue({ id: 's1', triggered: false, startBalance: 10000, realizedPnl: -10 })
    findUniqueMock.mockResolvedValue(noLimitConfig)
    const closeAllPositions = vi.fn().mockResolvedValue(0)

    await recordRealizedPnl(fakeAccount({ closeAllPositions }), { netPnl: -10, balanceAfterClose: 9990 })

    expect(closeAllPositions).not.toHaveBeenCalled()
    expect(updateMock).not.toHaveBeenCalled()
    expect(updateManyMock).not.toHaveBeenCalled()
  })

  it('closes all positions, activates killSwitch, and clears in-memory state exactly once when the limit is crossed', async () => {
    upsertMock.mockResolvedValue({ id: 's1', triggered: false, startBalance: 10000, realizedPnl: -100 })
    findUniqueMock.mockResolvedValue(noLimitConfig) // dailyLossLimit: 100 fixed
    updateManyMock.mockResolvedValue({ count: 1 }) // ganamos la carrera del compare-and-set
    const closeAllPositions = vi.fn().mockResolvedValue(2)
    const clearState = vi.fn()
    onDailyLimitClearState(clearState)

    await recordRealizedPnl(fakeAccount({ closeAllPositions }), { netPnl: -100, balanceAfterClose: 9900 })

    expect(updateManyMock).toHaveBeenCalledWith({ where: { id: 's1', triggered: false }, data: { triggered: true } })
    expect(closeAllPositions).toHaveBeenCalledOnce()
    expect(updateMock).toHaveBeenCalledWith({ where: { userId: 'user-1' }, data: { killSwitch: true } })
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

  it('still activates killSwitch even if closing positions fails (fail-safe: prefer killSwitch on over off)', async () => {
    upsertMock.mockResolvedValue({ id: 's1', triggered: false, startBalance: 10000, realizedPnl: -100 })
    findUniqueMock.mockResolvedValue(noLimitConfig)
    updateManyMock.mockResolvedValue({ count: 1 })
    const closeAllPositions = vi.fn().mockRejectedValue(new Error('WS caído'))

    await recordRealizedPnl(fakeAccount({ closeAllPositions }), { netPnl: -100, balanceAfterClose: 9900 })

    expect(updateMock).toHaveBeenCalledWith({ where: { userId: 'user-1' }, data: { killSwitch: true } })
  })

  it('never throws, even if Prisma rejects', async () => {
    upsertMock.mockRejectedValue(new Error('DB caída'))
    await expect(recordRealizedPnl(fakeAccount(), { netPnl: 10, balanceAfterClose: 100 })).resolves.toBeUndefined()
  })
})
