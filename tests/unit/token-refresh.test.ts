import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { refreshAccessToken } from '../../src/lib/ctrader-oauth.js'

describe('refreshAccessToken', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('POSTs grant_type=refresh_token with client credentials and returns the new tokens', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        accessToken: 'new-access',
        tokenType: 'bearer',
        expiresIn: 2592000,
        refreshToken: 'new-refresh',
      }),
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await refreshAccessToken('old-refresh')

    expect(result.accessToken).toBe('new-access')
    expect(result.refreshToken).toBe('new-refresh')

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string)
    expect(calledUrl.origin + calledUrl.pathname).toBe('https://openapi.ctrader.com/apps/token')
    expect(calledUrl.searchParams.get('grant_type')).toBe('refresh_token')
    expect(calledUrl.searchParams.get('refresh_token')).toBe('old-refresh')
    expect(calledUrl.searchParams.get('client_id')).toBe(process.env.CTRADER_CLIENT_ID)
    expect(calledUrl.searchParams.get('client_secret')).toBe(process.env.CTRADER_CLIENT_SECRET)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' })
  })

  it('throws when cTrader returns an errorCode', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ errorCode: 'INVALID_REFRESH_TOKEN', description: 'expired' }),
    }) as unknown as typeof fetch

    await expect(refreshAccessToken('bad-refresh')).rejects.toThrow(/INVALID_REFRESH_TOKEN/)
  })

  it('throws when the HTTP response is not ok', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    }) as unknown as typeof fetch

    await expect(refreshAccessToken('x')).rejects.toThrow(/500/)
  })
})
