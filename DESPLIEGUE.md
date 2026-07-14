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

## 5. Motor de señales — Scalper + Smart Trail + Exit

El sistema opera con dos indicadores de TradingView (Scalper y Smart Trail)
más una señal de salida (Exit). Cada alerta incluye un campo `signal` que
identifica el indicador de origen.

### Tipos de señal

| signal       | action | Qué cierra                         | Qué abre                        |
|--------------|--------|-------------------------------------|----------------------------------|
| `scalper`    | buy    | Si había Sell: Scalper + Smart Trails | 5 contratos Buy               |
| `scalper`    | sell   | Si había Buy: Scalper + Smart Trails  | 5 contratos Sell              |
| `smart_trail`| buy    | Nada                                | 3 contratos (si Scalper es Buy) |
| `smart_trail`| sell   | Nada                                | 3 contratos (si Scalper es Sell)|
| `exit`       | close  | Solo Smart Trails                   | Nada                            |
| `close_all`  | close  | Todo (Scalper + Smart Trails)       | Nada                            |

### Reglas clave

- El Scalper NUNCA se cierra manualmente. Solo se cierra cuando llega un
  Scalper en dirección contraria.
- Los Smart Trail solo abren si coinciden con la dirección del Scalper activo.
  Si van en contra, se ignoran.
- Exit cierra solo Smart Trails. El Scalper no se toca.
- Close All es el botón de emergencia: cierra todo y limpia el estado.

### Stop Loss y Take Profit (opcionales)

Los campos `sl_pips` y `tp_pips` son opcionales en todas las señales:

| En el JSON                        | Resultado                     |
|-----------------------------------|-------------------------------|
| `"sl_pips": 50`                   | Orden con SL a 50 pips        |
| `"sl_pips": 50, "tp_pips": 100`   | Orden con SL y TP             |
| Sin `sl_pips` ni `tp_pips`        | Orden sin protección          |
| `"tp_pips": 100` (sin SL)         | Orden solo con TP             |

### Alertas en TradingView

Webhook URL: `https://hooks.tudominio.com/webhook/tradingview`

Trigger: **Once Per Bar Close** (en todas las alertas).

**Alerta Scalper Buy:**
```json
{
  "secret": "TU_WEBHOOK_SECRET",
  "alert_id": "{{timenow}}-{{ticker}}-scalper-buy",
  "action": "buy",
  "signal": "scalper",
  "ticker": "{{ticker}}",
  "price": {{close}},
  "time": {{timenow}},
  "lots": 5,
  "sl_pips": 50,
  "tp_pips": 100
}
```
> `sl_pips` y `tp_pips` son opcionales. Si no los incluyes, la orden se abre sin protección.

**Alerta Scalper Sell:**
```json
{
  "secret": "TU_WEBHOOK_SECRET",
  "alert_id": "{{timenow}}-{{ticker}}-scalper-sell",
  "action": "sell",
  "signal": "scalper",
  "ticker": "{{ticker}}",
  "price": {{close}},
  "time": {{timenow}},
  "lots": 5
}
```
> Ejemplo sin SL ni TP — la orden se abre sin protección.

**Alerta Smart Trail Buy:**
```json
{
  "secret": "TU_WEBHOOK_SECRET",
  "alert_id": "{{timenow}}-{{ticker}}-smart-buy",
  "action": "buy",
  "signal": "smart_trail",
  "ticker": "{{ticker}}",
  "price": {{close}},
  "time": {{timenow}},
  "lots": 3,
  "sl_pips": 50
}
```
> Ejemplo solo con SL, sin TP.

**Alerta Smart Trail Sell:**
```json
{
  "secret": "TU_WEBHOOK_SECRET",
  "alert_id": "{{timenow}}-{{ticker}}-smart-sell",
  "action": "sell",
  "signal": "smart_trail",
  "ticker": "{{ticker}}",
  "price": {{close}},
  "time": {{timenow}},
  "lots": 3
}
```

**Alerta Exit (cierra solo Smart Trails):**
```json
{
  "secret": "TU_WEBHOOK_SECRET",
  "alert_id": "{{timenow}}-{{ticker}}-exit",
  "action": "close",
  "signal": "exit",
  "ticker": "{{ticker}}",
  "price": {{close}},
  "time": {{timenow}}
}
```

**Cerrar todo (Scalper + Smart Trails):**
```json
{
  "secret": "TU_WEBHOOK_SECRET",
  "alert_id": "{{timenow}}-{{ticker}}-close-all",
  "action": "close",
  "signal": "close_all",
  "ticker": "{{ticker}}",
  "price": {{close}},
  "time": {{timenow}}
}
```

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

## 9. Pruebas desde Postman

### Configurar timestamp automático

En Postman, pestaña **Pre-request Script** de cada request:
```javascript
pm.environment.set("timestamp", Date.now().toString())
```

Luego en el JSON usa `{{timestamp}}` en los campos `time` y `alert_id`.
Esto evita el error "Fuera de ventana" por timestamp expirado.

### Agregar IPs locales (solo para pruebas)

Para probar desde tu PC, agrega temporalmente en `src/server.ts`:
```typescript
TRADINGVIEW_IPS.add('127.0.0.1')
TRADINGVIEW_IPS.add('::1')
TRADINGVIEW_IPS.add('::ffff:127.0.0.1')
```
**Quitar antes de hacer push a producción.**

### Secuencia de prueba completa

Enviar en orden desde Postman contra `http://localhost:3000/webhook/tradingview`:

**Paso 1 — Scalper Buy (abre 5 contratos):**
```json
{
  "secret": "{{webhooksecret}}",
  "alert_id": "{{timestamp}}-NAS100-scalper-buy",
  "action": "buy",
  "signal": "scalper",
  "ticker": "NAS100",
  "price": 22000,
  "time": {{timestamp}},
  "lots": 5,
  "sl_pips": 500,
  "tp_pips": 1000
}
```
Log esperado: `[scalper] NUEVO buy 5 lotes NAS100`

**Paso 2 — Smart Trail Buy (abre 3 más):**
```json
{
  "secret": "{{webhooksecret}}",
  "alert_id": "{{timestamp}}-NAS100-smart-buy-1",
  "action": "buy",
  "signal": "smart_trail",
  "ticker": "NAS100",
  "price": 22050,
  "time": {{timestamp}},
  "lots": 3,
  "sl_pips": 500,
  "tp_pips": 1000
}
```
Log esperado: `[smart_trail] buy 3 lotes NAS100 label=smarttrail-buy-1`

**Paso 3 — Exit (cierra solo Smart Trail):**
```json
{
  "secret": "{{webhooksecret}}",
  "alert_id": "{{timestamp}}-NAS100-exit-1",
  "action": "close",
  "signal": "exit",
  "ticker": "NAS100",
  "price": 22030,
  "time": {{timestamp}}
}
```
Log esperado: `[exit] 1 smart trail cerradas en NAS100`

**Paso 4 — Smart Trail Sell (se ignora, Scalper es Buy):**
```json
{
  "secret": "{{webhooksecret}}",
  "alert_id": "{{timestamp}}-NAS100-smart-sell-1",
  "action": "sell",
  "signal": "smart_trail",
  "ticker": "NAS100",
  "price": 22020,
  "time": {{timestamp}},
  "lots": 3,
  "sl_pips": 500,
  "tp_pips": 1000
}
```
Log esperado: `[smart_trail] IGNORADO: sell contra scalper buy en NAS100`

**Paso 5 — Smart Trail Buy (abre otros 3):**
```json
{
  "secret": "{{webhooksecret}}",
  "alert_id": "{{timestamp}}-NAS100-smart-buy-2",
  "action": "buy",
  "signal": "smart_trail",
  "ticker": "NAS100",
  "price": 22060,
  "time": {{timestamp}},
  "lots": 3,
  "sl_pips": 500,
  "tp_pips": 1000
}
```
Log esperado: `[smart_trail] buy 3 lotes NAS100 label=smarttrail-buy-2`

**Paso 6 — Scalper Sell (reversa: cierra todo + abre Sell):**
```json
{
  "secret": "{{webhooksecret}}",
  "alert_id": "{{timestamp}}-NAS100-scalper-sell",
  "action": "sell",
  "signal": "scalper",
  "ticker": "NAS100",
  "price": 21950,
  "time": {{timestamp}},
  "lots": 5,
  "sl_pips": 500,
  "tp_pips": 1000
}
```
Log esperado:
```
[scalper] REVERSA: cerradas 1 scalper + 1 smart trail en NAS100
[scalper] NUEVO sell 5 lotes NAS100
```

**Paso 7 — Close All (limpia todo):**
```json
{
  "secret": "{{webhooksecret}}",
  "alert_id": "{{timestamp}}-NAS100-close-all",
  "action": "close",
  "signal": "close_all",
  "ticker": "NAS100",
  "price": 21950,
  "time": {{timestamp}}
}
```
Log esperado: `[close_all] 1 scalper + 0 smart trail cerradas en NAS100`

### Verificación en cTrader

Después de cada paso, verifica en https://ct.pepperstone.com:
- Posiciones abiertas con los lotes correctos
- Labels de las posiciones (`scalper-buy`, `smarttrail-buy-1`, etc.)
- SL y TP a la distancia esperada (si se enviaron en el JSON)
- Que el `/health` muestre el estado correcto del Scalper

### Notas sobre las pruebas

- Se usa `sl_pips: 500` (amplio) para evitar que las posiciones se
  cierren por SL entre pasos de prueba.
- Si el símbolo NAS100 no se encuentra, configurar `SYMBOL_MAP` en `.env`:
  `SYMBOL_MAP={"NAS100":"USTEC"}` (o el nombre que use cTrader).
- Si una posición ya se cerró por SL/TP antes de recibir la señal de
  cierre, el sistema lo detecta y continúa sin error.

## 10. Pruebas con TradingView (producción)

1. Quitar las IPs de prueba locales de `server.ts`.
2. Hacer push al repo → EasyPanel redespliega.
3. Verificar `/health` en la URL del VPS.
4. Crear las alertas en TradingView (una por señal) con los JSON de
   la sección 5, apuntando al webhook del VPS.
5. Dejar correr en demo semanas midiendo: fills, slippage, símbolos,
   SL/TP correctos, y que la lógica Scalper/Smart Trail se ejecute
   como se espera.
6. Solo entonces, evaluar cuenta real.
## 11. Comandos útiles PowerShell

```powershell
# Health del webhook
Invoke-RestMethod https://wh.qmander.com/health

# Generar webhook secret
-join ((1..32) | ForEach-Object { "{0:x2}" -f (Get-Random -Max 256) })

# URL del webhook
# https://wh.qmander.com/webhook/tradingview

# Obtener timestamp actual (milisegundos)
[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

# Cargar variables de entorno desde .env
Get-Content .env | ForEach-Object {
  if ($_ -match '^([^#][^=]+)=(.*)$') {
    [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), "Process")
  }
}

# Arrancar servidor
pnpm dev     # desarrollo (hot reload)
pnpm start   # producción
```
