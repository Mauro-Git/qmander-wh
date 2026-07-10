/**
 * Obtención del access token de cTrader Open API (OAuth2).
 * Usa fetch nativo de Node.js 18+ — sin dependencias externas.
 *
 * PASO 1 — Obtener URL de autorización:
 *   CTRADER_CLIENT_ID=xxx CTRADER_REDIRECT_URI=https://tu-dominio/callback npm run get-token
 *
 * PASO 2 — Intercambiar code por tokens:
 *   CTRADER_CLIENT_ID=xxx CTRADER_CLIENT_SECRET=yyy CTRADER_REDIRECT_URI=... CODE=el_code npm run get-token
 *
 * PASO 3 — Renovar token expirado (~30 días):
 *   CTRADER_CLIENT_ID=xxx CTRADER_CLIENT_SECRET=yyy REFRESH_TOKEN=zzz npm run get-token
 */

const clientId     = process.env.CTRADER_CLIENT_ID
const clientSecret = process.env.CTRADER_CLIENT_SECRET
const redirectUri  = process.env.CTRADER_REDIRECT_URI
const code         = process.env.CODE
const refreshToken = process.env.REFRESH_TOKEN

if (!clientId) {
  console.error('Define CTRADER_CLIENT_ID')
  process.exit(1)
}

// ── Renovación con refresh token ─────────────────────────────
if (refreshToken) {
  if (!clientSecret) { console.error('Define CTRADER_CLIENT_SECRET'); process.exit(1) }
  const res = await fetch('https://openapi.ctrader.com/apps/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  })
  const tokens = await res.json()
  console.log('\nRespuesta de renovación:\n', JSON.stringify(tokens, null, 2))
  if (tokens.accessToken || tokens.access_token) {
    console.log('\n→ CTRADER_ACCESS_TOKEN =', tokens.accessToken ?? tokens.access_token)
  }
  process.exit(0)
}

// ── Paso 1: generar URL de autorización ──────────────────────
if (!code) {
  if (!redirectUri) { console.error('Define CTRADER_REDIRECT_URI'); process.exit(1) }
  const url = new URL('https://openapi.ctrader.com/apps/auth')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', 'trading')
  console.log('Abre esta URL en tu navegador y autoriza:\n')
  console.log(url.toString())
  console.log('\nLuego vuelve a ejecutar con CODE=<code de la redirección>')
  process.exit(0)
}

// ── Paso 2: intercambiar code → tokens ───────────────────────
if (!clientSecret) { console.error('Define CTRADER_CLIENT_SECRET'); process.exit(1) }
if (!redirectUri)  { console.error('Define CTRADER_REDIRECT_URI'); process.exit(1) }

const tokenRes = await fetch('https://openapi.ctrader.com/apps/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  }),
})

const tokens = await tokenRes.json()
console.log('\nRespuesta del token endpoint:\n', JSON.stringify(tokens, null, 2))

if (tokens.accessToken || tokens.access_token) {
  const accessToken = tokens.accessToken ?? tokens.access_token
  console.log('\n→ CTRADER_ACCESS_TOKEN =', accessToken)
  console.log('→ Guarda también el refreshToken para renovaciones.')
  console.log('\nPara obtener tu CTRADER_ACCOUNT_ID, consulta el portal')
  console.log('openapi.ctrader.com → tu app → Playground, o lista')
  console.log('las cuentas con ProtoOAGetAccountListByAccessTokenReq.')
}
