# Despliegue: TradingView → cTrader (WebSocket + JSON)

## Cambios respecto a la versión anterior

Esta versión elimina `@reiryoku/ctrader-layer` y todas sus dependencias
vulnerables (`protobufjs`, `axios`, `uuid`). En su lugar usa un cliente
ligero que se conecta por **WebSocket al puerto 5036** con mensajes
**JSON** en vez de Protobuf. Dependencias: solo `ws`, `express` y `zod`.

**Package manager: pnpm** (no npm ni yarn).

## 1. Prerrequisitos en cTrader

1. Crea tu cuenta **demo** de Pepperstone cTrader desde el área de cliente
   de Pepperstone. Necesitas establecer una contraseña para cTrader:
   en tu área de cliente busca la opción de restablecer contraseña de
   cTrader (te redirigirá a ct.spotware.com → usa tu email de Pepperstone
   en "Forgot your password").
2. Inicia sesión en **https://openapi.ctrader.com** con tu cTrader ID
   (número de cuenta, ej. 5299263) y la contraseña que acabas de
   establecer.
3. Crea una aplicación: **Applications → Add new app**.
   - Name: `TradingView Webhook Bridge`
   - Redirect URI: `https://tu-dominio.com/callback` (no necesita existir)
   - Permissions: `Trading`
   - Anota **Client ID** y **Client Secret**.

## 2. Obtener el access token (en tu PC local)

```bash
cd tradingview-ctrader
pnpm install

# Paso 1: obtener URL de autorización
CTRADER_CLIENT_ID=tu_client_id \
CTRADER_REDIRECT_URI=https://tu-dominio.com/callback \
pnpm get-token
# → Abre la URL en el navegador, autoriza, copia el ?code=... de la URL

# Paso 2: intercambiar el code por tokens
CTRADER_CLIENT_ID=tu_client_id \
CTRADER_CLIENT_SECRET=tu_client_secret \
CTRADER_REDIRECT_URI=https://tu-dominio.com/callback \
CODE=el_code_copiado \
pnpm get-token
# → Anota accessToken y refreshToken

# Renovar token expirado (~30 días):
CTRADER_CLIENT_ID=tu_client_id \
CTRADER_CLIENT_SECRET=tu_client_secret \
REFRESH_TOKEN=tu_refresh_token \
pnpm get-token
```

**En Windows (PowerShell)**, las variables se definen así:
```powershell
$env:CTRADER_CLIENT_ID="tu_client_id"
$env:CTRADER_REDIRECT_URI="https://tu-dominio.com/callback"
pnpm get-token
```

El `CTRADER_ACCOUNT_ID` es el **ctidTraderAccountId** de tu cuenta demo
(visible en el Playground del portal Open API).

## 3. Desarrollo local

```bash
# Cargar variables de entorno (PowerShell)
Get-Content .env | ForEach-Object {
  if ($_ -match '^([^#][^=]+)=(.*)$') {
    [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), "Process")
  }
}

# Arrancar en modo desarrollo (con hot reload)
pnpm dev
```

## 4. Despliegue en EasyPanel (VPS Hostinger KVM2, Ubuntu 24.04)

1. Sube el proyecto a un repo Git privado (GitHub/GitLab).
2. En EasyPanel: **Create Project → App**.
   - Source: tu repo Git, rama main.
   - Build: **Dockerfile** (lo detecta automáticamente).
3. En la pestaña **Environment**, pega las variables de `.env.example`
   con tus valores reales. Nunca subas el `.env` al repo.
4. En **Domains**: agrega tu subdominio (ej. `hooks.tudominio.com`),
   apunta el DNS A record a la IP del VPS, activa HTTPS (Let's Encrypt
   automático) y configura el **puerto interno 3000**.
5. Deploy. Verifica:
   ```bash
   curl https://hooks.tudominio.com/health
   # → {"connected":true,"symbols":NNN,...}
   ```

## 5. Alerta en TradingView

Webhook URL: `https://hooks.tudominio.com/webhook/tradingview`

Mensaje (compra):
```json
{
  "secret": "TU_WEBHOOK_SECRET",
  "alert_id": "{{timenow}}-{{ticker}}-señal-compra",
  "action": "buy",
  "ticker": "{{ticker}}",
  "price": {{close}},
  "time": {{timenow}},
  "lots": 0.01,
  "sl_pips": 20,
  "tp_pips": 40
}
```
Para venta: `"action": "sell"`. Para cerrar posiciones del símbolo:
`"action": "close"` (no requiere lots/sl).

Trigger: **Once Per Bar Close**.

## 6. Kill switch

```bash
# Activar (detiene ejecución sin tumbar el servicio)
curl -X POST https://hooks.tudominio.com/admin/kill-switch \
  -H "Authorization: Bearer TU_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'

# Desactivar
curl -X POST https://hooks.tudominio.com/admin/kill-switch \
  -H "Authorization: Bearer TU_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'
```

## 7. Puntos a verificar en la primera prueba

- **Puerto 5036**: este cliente usa JSON sobre WebSocket (puerto 5036),
  no Protobuf (puerto 5035). Asegúrate de que tu VPS puede hacer
  conexiones salientes al puerto 5036.
- **Volumen**: verifica con una orden de 0.01 lotes que la posición
  abierta en cTrader muestre exactamente 1,000 unidades (forex estándar).
- **relativeStopLoss**: confirma que el SL quede a los pips esperados.
  Si no, ajusta `pipFactor` en `src/ctrader.ts`.
- **Token**: el access token expira (~30 días). Renueva con el refresh
  token usando `pnpm get-token` con REFRESH_TOKEN=... y actualiza la
  variable en EasyPanel.
- **IPs de TradingView**: confirma la lista vigente en la documentación
  oficial (About webhooks) y actualízala en `server.ts`.
- **Reconexión**: si en los logs ves desconexiones del WebSocket,
  EasyPanel reinicia el contenedor automáticamente si el proceso muere
  (el código hace `process.exit(1)` ante fallo de conexión).

## 8. Migración futura a FTMO

Para operar en FTMO con cTrader, solo necesitas:
1. Cambiar `CTRADER_HOST` a `demo.ctraderapi.com` o `live.ctraderapi.com`
   según corresponda (FTMO usa la misma infraestructura cTrader).
2. Obtener un nuevo access token autorizando tu cuenta FTMO cTrader.
3. Actualizar `CTRADER_ACCOUNT_ID` con el ID de tu cuenta FTMO.
4. Bajar `MAX_DAILY_REQUESTS` a 1500 o menos (FTMO prohíbe >2000/día).
5. Implementar validaciones adicionales de drawdown diario/total.

## 9. Secuencia de pruebas recomendada

1. `curl` manual al webhook (comentar filtro IP temporalmente o agregar
   tu IP para pruebas).
2. Alerta real de TradingView → verificar orden en cTrader **demo**.
3. Semanas en demo midiendo: fills, slippage, símbolos, SL/TP correctos.
4. Solo entonces, evaluar cuenta real.


##  10. Comandos utiles powershell

# Health del Webhook 
  Invoke-RestMethod https://wh.qmander.com/health
  
# Generar Webhook secret
  -join ((1..32) | ForEach-Object { "{0:x2}" -f (Get-Random -Max 256) }) 

# URL Webhook
  https://wh.qmander.com/webhook/tradingview

# Obtener TimeStamp
  [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

# Cargar variables e inicial local
Get-Content .env | ForEach-Object {
  if ($_ -match '^([^#][^=]+)=(.*)$') {
    [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), "Process")
  }
}
pnpm dev (desarrollo)
pnpm start (producción)

