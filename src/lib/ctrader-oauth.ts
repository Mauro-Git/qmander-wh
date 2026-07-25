// Renovación de access token de cTrader Open API (OAuth2).
// Mismo endpoint que trading-dashboard/src/lib/ctrader/oauth.ts (verificado
// contra help.ctrader.com/open-api/account-authentication/). El webhook solo
// necesita renovar tokens ya vinculados — el alta (authorization_code) vive
// en el dashboard.

const TOKEN_URL = 'https://openapi.ctrader.com/apps/token'

export interface CTraderTokenResponse {
  accessToken: string
  tokenType: string
  expiresIn: number
  refreshToken: string
  errorCode?: string | null
  description?: string | null
}

function appCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.CTRADER_CLIENT_ID
  const clientSecret = process.env.CTRADER_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('CTRADER_CLIENT_ID / CTRADER_CLIENT_SECRET no están configuradas')
  }
  return { clientId, clientSecret }
}

export async function refreshAccessToken(refreshToken: string): Promise<CTraderTokenResponse> {
  const { clientId, clientSecret } = appCredentials()
  const url = new URL(TOKEN_URL)
  url.searchParams.set('grant_type', 'refresh_token')
  url.searchParams.set('refresh_token', refreshToken)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('client_secret', clientSecret)

  const res = await fetch(url.toString(), { method: 'POST' })
  const data = (await res.json()) as CTraderTokenResponse

  if (!res.ok || data.errorCode) {
    throw new Error(`cTrader OAuth error: ${data.errorCode ?? res.status} ${data.description ?? ''}`.trim())
  }
  return data
}
