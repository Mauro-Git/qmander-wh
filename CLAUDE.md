# CLAUDE.md — TradingView → cTrader Bridge

## Qué es este proyecto

Plataforma multi-usuario de trading automatizado que conecta alertas de TradingView
con el broker Pepperstone (y en el futuro FTMO) a través de la cTrader Open API.
Los usuarios NO son desarrolladores — son traders que necesitan una interfaz simple.

## Estado actual

En producción (`main`, rama desplegada): single-tenant, `CTRADER_ACCOUNTS` estático en
`.env`, un solo `WEBHOOK_SECRET` global.

En desarrollo (rama `feature/multi-tenant`, NO desplegada todavía): migración a
multi-tenant completa. El webhook ahora lee todo de PostgreSQL (Prisma) en vez de env
vars estáticas — ver "Arquitectura — Dos proyectos separados" y "Multi-tenant (DB)" más
abajo. Pendiente: verificación end-to-end contra demo antes de mergear a `main`.

- **URL live (main)**: https://wh.qmander.com/ (también https://qmander-tradingview-bridge-tradingview-bridge.pommed.easypanel.host/)
- **Funcionalidad probada**: Scalper buy/sell, Smart Trail buy/sell, Exit, Close All en NAS100
- **Motor de señales**: Scalper (papá) + Smart Trail (hijos) + Exit, con reconstrucción de estado al reiniciar
- **Logs**: archivos diarios en `LOG_DIR/YYYY-MM-DD.log` (`/app/logs` en producción), volumen persistente en EasyPanel
- **Stack actual**: Express.js, WebSocket (`ws`) + JSON (puerto 5036), Zod, Prisma (en `feature/multi-tenant`)
- **Sin dependencias vulnerables**: eliminamos `@reiryoku/ctrader-layer`, `protobufjs`, `axios`

## Logs y monitoreo

Logs se escriben a consola Y a archivos diarios en `/app/logs/` (volumen persistente en EasyPanel).
Cada alerta aceptada loguea el desfase en segundos con TradingView.

### Endpoints de logs (requieren Authorization: Bearer ADMIN_SECRET en `feature/multi-tenant`; WEBHOOK_SECRET en `main`)
- `GET /admin/logs` — logs de hoy
- `GET /admin/logs/2026-07-23` — logs de una fecha específica
- `GET /admin/logs-list` — listar archivos de log disponibles
- `GET /health` — estado de cuentas, scalperState, kill switch

### Consultar desde PowerShell
```powershell
# Logs de hoy
Invoke-RestMethod -Uri "https://wh.qmander.com/admin/logs" -Headers @{Authorization="Bearer TU_ADMIN_SECRET"}

# Logs de una fecha
Invoke-RestMethod -Uri "https://wh.qmander.com/admin/logs/2026-07-22" -Headers @{Authorization="Bearer TU_ADMIN_SECRET"}

# Listar archivos disponibles
Invoke-RestMethod -Uri "https://wh.qmander.com/admin/logs-list" -Headers @{Authorization="Bearer TU_ADMIN_SECRET"}
```

## Reglas obligatorias

### Package manager
- Usar siempre **pnpm** (no npm ni yarn)
- Comando de desarrollo: `pnpm dev`
- Instalar dependencias: `pnpm install` / `pnpm add`
- El Dockerfile usa npm internamente (por compatibilidad con EasyPanel)

### Skills del proyecto
Leer y aplicar siempre estos archivos antes de generar código:
- `skills/nextjs15-trading-platform.md` — Stack, modelos Prisma, estructura, patrones
- `skills/trading-security.md` — Encriptación, validación webhook, control de riesgo
- `skills/ux-non-technical.md` — UX para traders no técnicos, microcopy, wizards
- `skills/trading-testing.md` — Estrategia de tests, mocks, conversiones numéricas

### El skill global `nextjs15-saas-b2b` NO aplica
Usar `nextjs15-trading-platform` en su lugar. Diferencias clave:
- PostgreSQL local en VPS (no Neon, no pgbouncer)
- NextAuth.js con Google (no JWT custom con jose)
- No hay OpenAI — hay cTrader Open API
- Deploy en EasyPanel + Traefik (no genérico)

## Stack objetivo (Fase 1 en adelante)

- **Framework**: Next.js 15 (App Router, Server Components por defecto)
- **Lenguaje**: TypeScript 5 estricto (`strict: true`)
- **Base de datos**: PostgreSQL local en VPS (EasyPanel service)
- **ORM**: Prisma 5
- **Auth**: NextAuth.js con Google provider
- **Estilos**: Tailwind CSS 3
- **Trading**: WebSocket (`ws`) + JSON → cTrader Open API puerto 5036
- **Validación**: Zod
- **Deploy**: Docker + EasyPanel + Traefik (auto-HTTPS)
- **VPS**: Hostinger KVM2, Ubuntu 24.04

## Arquitectura — Dos proyectos separados

El sistema se compone de dos aplicaciones independientes que comparten la misma
base de datos PostgreSQL:

### Proyecto 1: Webhook (repo: traderWebHook)
- **Qué hace**: recibe alertas de TradingView, ejecuta el motor de señales, opera en cTrader
- **Stack**: Express.js, WebSocket (`ws`), Zod
- **Dominio**: wh.qmander.com
- **Lee de PostgreSQL**: configuración de usuarios, credenciales encriptadas
- **Escribe en PostgreSQL**: registro de operaciones (trades)
- **Estado**: funcionando en producción

### Proyecto 2: Frontend (repo: trading-dashboard)
- **Qué hace**: interfaz web para traders no técnicos
- **Stack**: Next.js 15, Prisma, NextAuth.js, Tailwind CSS 3
- **Dominio**: app.qmander.com (por definir)
- **Lee/escribe PostgreSQL**: usuarios, configuración, trades, tokens
- **Funcionalidades**: login con Google, wizard OAuth cTrader, configuración de riesgo,
  monitor de operaciones, kill switch, webhook URL personal

### Base de datos compartida
- PostgreSQL como servicio en EasyPanel
- Ambos proyectos usan la misma DATABASE_URL
- Schema Prisma compartido (duplicado en ambos repos al inicio)

### Ventajas de la separación
- Si el frontend se cae, el webhook sigue ejecutando órdenes
- Se puede desplegar el frontend sin reiniciar el webhook (que perdería conexiones WebSocket)
- Cada proyecto tiene su propio ciclo de deploy y repo

## Infraestructura

- **VPS**: Hostinger KVM2, Ubuntu 24.04, EasyPanel
- **Proyecto 1 (webhook)**: wh.qmander.com / qmander-tradingview-bridge-tradingview-bridge.pommed.easypanel.host
- **Proyecto 2 (frontend)**: app.qmander.com (por configurar)
- **PostgreSQL**: servicio en EasyPanel (por crear)
- **Repos**: privados en GitHub (traderWebHook + trading-dashboard)
- **Entorno dev**: Windows, PowerShell, pnpm
- **Ruta local webhook**: C:\Users\mmend\My Work\F1Help\traderWebHook
- **Ruta local frontend**: C:\Users\mmend\My Work\F1Help\trading-dashboard

## Fases del proyecto

### Fase 1A — Base de datos + Webhook lee de PostgreSQL — EN CURSO (`feature/multi-tenant`)
1. ✅ PostgreSQL en EasyPanel (`qmander-db`), compartida con trading-dashboard
2. ✅ Prisma en el webhook, mismo `schema.prisma` que trading-dashboard (solo `prisma generate`, nunca `migrate`/`db push` desde este repo)
3. ✅ El webhook autentica por `User.webhookToken` y lee `UserConfig`/`BrokerAccount` de PostgreSQL en vez del `.env`
4. ✅ Cada alerta aceptada se registra en `Trade` (`queued` → `executed`/`failed`/`retrying`)
5. ✅ Credenciales del broker desencriptadas con AES-256-GCM (`src/lib/crypto.ts`, mismo `ENCRYPTION_KEY` que el dashboard)
6. ⏳ Verificación end-to-end contra cTrader demo antes de mergear a `main`
7. ⏳ Deploy a EasyPanel (requiere agregar `DATABASE_URL`/`ENCRYPTION_KEY`/`ADMIN_SECRET` a las env vars del servicio)

### Fase 1B — Frontend básico (Proyecto 2)
1. Crear proyecto Next.js 15 con NextAuth.js + Google
2. Configurar Prisma con el mismo schema
3. Páginas: login, dashboard vacío, configuración básica

### Fase 2 — Frontend de configuración
- Wizard OAuth para vincular cTrader (3 pasos, sin jerga técnica)
- Configuración de símbolos, lotes, SL, kill switch por usuario
- Webhook URL personal con botón "Copiar"
- Estados visuales: conectado/desconectado/error

### Fase 3 — Monitor de operaciones
- Feed de operaciones en tiempo real
- Historial filtrable por fecha y símbolo
- Kill switch prominente
- Notificaciones por email/Telegram ante errores

## Arquitectura del webhook (5 capas de seguridad)

1. **IP de origen** — solo IPs publicadas por TradingView (`TRADINGVIEW_IPS`)
2. **Token por usuario** — `alert.secret` se busca contra `User.webhookToken` (único,
   indexado en DB); ya no es un secreto global. Sin match → 404 genérico
3. **Esquema + frescura** — Zod + ventana de 60 segundos
4. **Idempotencia** — deduplicación por `${userId}:${alert_id}` (no global)
5. **Riesgo** — kill switch superadmin (global, en memoria, `POST /admin/kill-switch`
   con `ADMIN_SECRET`) → `UserConfig.killSwitch` del usuario → `allowedSymbols` →
   `maxLots`, todo por usuario desde `UserConfig`

## Lógica de señales — Scalper + Smart Trail + Exit

El sistema opera con dos indicadores de TradingView (LuxAlgo): Scalper y Smart Trail.
El Scalper es el "papá" y los Smart Trail son los "hijos".

### Reglas del motor de señales

**Señal Scalper (buy/sell):**
- Si NO hay Scalper abierto → abrir 5 contratos, marcar dirección de referencia
- Si HAY Scalper abierto y la señal es en la MISMA dirección → ignorar
- Si HAY Scalper abierto y la señal es CONTRARIA → cerrar Scalper anterior +
  cerrar TODOS los Smart Trail abiertos + abrir nuevo Scalper (5 contratos)

**Señal Smart Trail (buy/sell):**
- Si coincide con la dirección del Scalper abierto → abrir 3 contratos (acumulables)
- Si va en contra del Scalper abierto → ignorar, no hacer nada
- Si no hay Scalper abierto → ignorar

**Señal Exit:**
- Cerrar ÚNICAMENTE los Smart Trail abiertos
- El Scalper NO se toca
- Si no hay Smart Trail abiertos → no hacer nada

### Identificación de posiciones
Cada orden usa el campo `label` de cTrader para distinguir tipo:
- Scalper: label = `"scalper-buy"` o `"scalper-sell"`
- Smart Trail: label = `"smarttrail-buy-{n}"` o `"smarttrail-sell-{n}"`
Esto permite cerrar selectivamente por tipo.

### Payload de alerta TradingView

```json
{
  "secret": "TOKEN_DEL_USUARIO",
  "alert_id": "{{timenow}}-{{ticker}}-scalper",
  "action": "buy",
  "signal": "scalper",
  "ticker": "{{ticker}}",
  "price": {{close}},
  "time": {{timenow}},
  "lots": 5,
  "sl_pips": 20,
  "tp_pips": 40
}
```

Campos:
- `signal`: `"scalper"` | `"smart_trail"` | `"exit"` (identifica el indicador)
- `action`: `"buy"` | `"sell"` | `"close"` (dirección de la señal)
- `lots`: 5 para Scalper, 3 para Smart Trail (configurable por usuario)
- Para exit: solo se necesitan `signal`, `action: "close"`, `ticker`

## cTrader Open API — Detalles técnicos

- Conexión: WebSocket + JSON al puerto 5036 (NO Protobuf puerto 5035)
- Demo: wss://demo.ctraderapi.com:5036
- Live: wss://live.ctraderapi.com:5036
- **Multi-tenant (`feature/multi-tenant`)**: `src/ctrader.ts` (clase `CTraderAccount`) es
  agnóstico de la DB — recibe `{userId, name, host, accessToken, accountId, symbolMap}`
  por constructor. `src/accountPool.ts` es el puente con Prisma: lee `BrokerAccount` de la
  DB, desencripta tokens, refresca si están por vencer, y mantiene un
  `Map<userId, CTraderAccount>`. Cada alerta opera solo en la cuenta del usuario resuelto
  (ya no hay funciones `*All` de fan-out — `BrokerAccount` es 1:1 con `User`)
- Heartbeat cada 10s (el servidor cierra conexiones inactivas)
- PayloadTypes clave: 2100 (AppAuth), 2102 (AccountAuth), 2106 (NewOrder),
  2111 (ClosePosition), 2114 (SymbolsList), 2116 (SymbolById), 2124 (Reconcile)
- CUIDADO: 2110 es AmendPositionSLTP, NO ClosePosition (2111). Error original causó "Nothing to amend"
- Access token expira ~30 días. `accountPool.ts` renueva proactivamente si `expiresAt`
  está a menos de 48h (vía `refreshAccessToken` en `src/lib/ctrader-oauth.ts`)
- `symbolMap` para mapeo TradingView → cTrader (ej: NAS100 → USTEC) vive en
  `UserConfig.symbolMap` (JSON en DB), ya no es un env var
- int64 en JSON: enviar como Number, NO como String (String rompe el WebSocket)

## Multi-tenant — configuración por usuario (DB, no .env)

En `feature/multi-tenant`, `CTRADER_HOST`/`accessToken`/`accountId`/`ALLOWED_SYMBOLS`/
`MAX_LOTS`/`killSwitch`/`SYMBOL_MAP` ya NO son env vars — viven en `BrokerAccount` y
`UserConfig` (una fila por usuario), gestionadas desde el dashboard. Env vars que
siguen siendo globales (compartidas por todos los usuarios):

```
# Misma app de Spotware para todos los usuarios
CTRADER_CLIENT_ID=xxx
CTRADER_CLIENT_SECRET=yyy

# DB compartida con trading-dashboard — mismo valor en ambos .env
DATABASE_URL=postgres://...
ENCRYPTION_KEY=...   # AES-256-GCM, 32 bytes hex — debe ser IDÉNTICO al del dashboard

# Ya NO autentica alertas de TradingView (eso es webhookToken por usuario) —
# solo protege /admin/* (logs, kill switch superadmin)
ADMIN_SECRET=...
```

Para agregar un usuario nuevo: se hace 100% desde `trading-dashboard` (login Google +
wizard OAuth cTrader + configuración de riesgo). El webhook lo recoge solo — conecta la
cuenta eager al arrancar, o a demanda (fallback perezoso) si se vinculó después del boot.

## Aprendizajes clave (no repetir estos errores)

- `@reiryoku/ctrader-layer` tiene vulnerabilidades irresolubles en protobufjs y axios — NO reintroducir
- `ctrader-ts` NO existe en npm — no intentar instalarlo
- WebSocket+JSON (puerto 5036) elimina TODAS las dependencias vulnerables
- El authorization code de OAuth cTrader expira en minutos — intercambiar inmediatamente
- En PowerShell, variables de entorno del .env deben cargarse manualmente con Get-Content
- `$env:CODE` debe limpiarse entre intentos de OAuth (Remove-Item Env:CODE)
- EasyPanel con pnpm en Dockerfile falla — usar npm dentro del contenedor
- PayloadType 2110 = AmendPositionSLTP, 2111 = ClosePosition — off-by-one que causa "Nothing to amend"
- El scalperState vive en memoria — al reiniciar se pierde. Solución: rebuildState() lee posiciones abiertas de cTrader al arrancar y reconstruye la dirección activa desde los labels
- SL y TP son opcionales — si no se envían en el JSON, la orden se abre sin protección
- TRADINGVIEW_IPS se lee desde .env, no hardcodeado en el código
- TradingView bloquea webhooks con datos que parecen tokens/passwords en el body — el secret funciona si el JSON llega como una línea sin saltos
- `{{timenow}}` de TradingView devuelve ISO string (2026-07-22T02:06:00Z), NO Unix timestamp — poner entre comillas en el JSON: `"time":"{{timenow}}"`
- TradingView envía Content-Type text/plain si el JSON tiene placeholders sin comillas ({{close}}) — nuestro servidor acepta ambos
- El contador diario de peticiones (`countTradingRequest`) solo cuenta NewOrderReq y ClosePositionReq — no consultas como Reconcile, SymbolList o SymbolById. Contar todo causaba falsos "límite alcanzado" con pocas operaciones reales
- Cada alerta aceptada loguea el desfase en segundos entre TradingView y el servidor (`[alerta] NAS100 scalper buy — desfase: 1.2s`). Si el desfase supera 30s consistentemente, hay un problema de sincronización
- `BrokerAccount` es 1:1 con `User` (no una lista) — un usuario tiene una sola cuenta cTrader. Las funciones de fan-out (`marketOrderAll`, etc.) no existen más; cada alerta opera solo en la cuenta del usuario resuelto por `webhookToken`
- `webhookToken` (default `cuid()` de Prisma) mide ~25 caracteres, no 32+ como el viejo `WEBHOOK_SECRET` hexadecimal — el `AlertSchema.secret` de Zod se relajó a `min(10).max(100)`, la validez real la determina el lookup en DB
- `docker run --env-file .env` NO despoja comillas de los valores (a diferencia de `tsx`, que sí carga `.env` correctamente) — un `DATABASE_URL="postgres://..."` con comillas literales rompe la conexión a Prisma con un error de protocolo confuso. Mantener `.env`/`.env.example` sin comillas en los valores
- Este repo (webhook) NUNCA corre `prisma migrate` ni `prisma db push` — solo `prisma generate`. `trading-dashboard` es la única fuente de verdad del schema de la DB compartida
- Probado localmente con `docker build` + `docker run --env-file .env`: `apk add --no-cache openssl` en la etapa `deps` (para `prisma generate`) y en la etapa `runner` (para el motor de Prisma en runtime) — ambas son necesarias, confirmado con el contenedor real conectando a la DB compartida y a las 2 cuentas cTrader demo existentes
- El middleware global `app.use(express.text({ type: '*/*' }))` matchea TODO content-type y consume el body como string antes que cualquier ruta. Un `express.json()` puesto en una ruta específica DESPUÉS de ese middleware global NO vuelve a parsear — body-parser detecta que el body ya fue leído y no-opea, dejando `req.body` como el string sin parsear. `/admin/kill-switch` tenía este bug (el switch nunca se activaba); se arregló parseando `JSON.parse(req.body)` manualmente en el handler, igual que ya se hacía en `/webhook/tradingview`
- Al probar el server localmente con procesos en segundo plano (`&` en bash), `kill $PID` no siempre mata el proceso de Node real — puede quedar un zombie escuchando el puerto y las pruebas siguientes le pegan a código viejo sin darse cuenta. Verificar con `netstat -ano | grep LISTENING` antes de asumir que un cambio no tuvo efecto
- `UserConfig.symbolMap` (a diferencia de `allowedSymbols`/`maxLots`/`killSwitch`, que se releen frescos de la DB en cada alerta) se capturaba una sola vez en `CTraderAccount` al conectar — si el usuario cambiaba el mapeo en el dashboard después, el webhook seguía usando el mapeo viejo hasta reconectar. Se arregló con `CTraderAccount.setSymbolMap()`, llamado en cada `processSignal` con el valor vigente de `UserConfig.symbolMap` (viaja en el `Job` de la cola)
- Verificado contra demo: la cuenta de Mauro usa `"US TECH 100"` como nombre de símbolo para el índice, NO `"NAS100"` — cada broker/cuenta puede nombrar los símbolos distinto, por eso `symbolMap` es obligatorio configurar por usuario si el ticker de TradingView no coincide literalmente con el nombre en cTrader
- El error `MARKET_CLOSED` de cTrader es una respuesta de negocio legítima (mercado cerrado fuera de horario), no un bug — se propaga igual que cualquier otro error de la API a través del pipeline de reintentos y auditoría en `Trade`
