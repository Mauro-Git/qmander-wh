# CLAUDE.md — TradingView → cTrader Bridge

## Qué es este proyecto

Plataforma multi-usuario de trading automatizado que conecta alertas de TradingView
con el broker Pepperstone (y en el futuro FTMO) a través de la cTrader Open API.
Los usuarios NO son desarrolladores — son traders que necesitan una interfaz simple.

## Estado actual (funcionando en producción)

El receptor de webhooks está desplegado y operativo:
- **URL live**: https://qmander-tradingview-bridge-tradingview-bridge.pommed.easypanel.host/
- **Cuenta demo Pepperstone**: 47603328
- **Funcionalidad probada**: buy, sell, close en EURUSD (demo)
- **Pendiente de probar**: NAS100 (nombre puede ser USTEC en cTrader)
- **Stack actual**: Express.js, WebSocket (`ws`) + JSON (puerto 5036), Zod
- **Sin dependencias vulnerables**: eliminamos `@reiryoku/ctrader-layer`, `protobufjs`, `axios`

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

## Infraestructura

- **VPS**: Hostinger KVM2, Ubuntu 24.04, EasyPanel
- **Dominio EasyPanel**: qmander-tradingview-bridge-tradingview-bridge.pommed.easypanel.host
- **Repo**: privado en GitHub
- **Entorno dev**: Windows, PowerShell
- **Ruta local**: C:\Users\mmend\My Work\F1Help\traderWebHook

## Fase 1 — Próximos pasos (multi-usuario + base de datos)

### Objetivo
Migrar la configuración del .env a PostgreSQL. Cada usuario tiene su propio
token de webhook, credenciales cTrader (encriptadas), y configuración de riesgo.

### Tareas
1. Crear servicio PostgreSQL en EasyPanel
2. Configurar Prisma con los modelos del skill `nextjs15-trading-platform.md`
3. Migrar el proyecto de Express puro a Next.js 15 App Router
4. Implementar NextAuth.js con Google
5. Adaptar el webhook router para identificar usuarios por token
6. Encriptar credenciales del broker con AES-256-GCM
7. Pool de conexiones cTrader (1 WebSocket por cuenta activa)

### Fase 2 — Frontend de configuración
- Login con Google (NextAuth)
- Wizard OAuth para vincular cTrader (3 pasos, sin jerga técnica)
- Configuración de símbolos, lotes, SL, kill switch
- Webhook URL personal con botón "Copiar"

### Fase 3 — Monitor de operaciones
- Feed de operaciones en tiempo real
- Historial filtrable por fecha y símbolo
- Estados visuales: conectado/desconectado/error
- Kill switch prominente

## Arquitectura del webhook (5 capas de seguridad)

1. **IP de origen** — solo IPs publicadas por TradingView
2. **Token secreto** — comparación timing-safe por usuario
3. **Esquema + frescura** — Zod + ventana de 60 segundos
4. **Idempotencia** — deduplicación por alert_id
5. **Riesgo** — símbolos, lotes máx, kill switch (por usuario)

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
- Heartbeat cada 10s (el servidor cierra conexiones inactivas)
- PayloadTypes clave: 2100 (AppAuth), 2102 (AccountAuth), 2106 (NewOrder),
  2110 (ClosePosition), 2114 (SymbolsList), 2116 (SymbolById), 2124 (Reconcile)
- Access token expira ~30 días, renovar con refresh token
- SYMBOL_MAP env var para mapeo TradingView → cTrader (ej: NAS100 → USTEC)

## Aprendizajes clave (no repetir estos errores)

- `@reiryoku/ctrader-layer` tiene vulnerabilidades irresolubles en protobufjs y axios — NO reintroducir
- `ctrader-ts` NO existe en npm — no intentar instalarlo
- WebSocket+JSON (puerto 5036) elimina TODAS las dependencias vulnerables
- El authorization code de OAuth cTrader expira en minutos — intercambiar inmediatamente
- En PowerShell, variables de entorno del .env deben cargarse manualmente con Get-Content
- `$env:CODE` debe limpiarse entre intentos de OAuth (Remove-Item Env:CODE)
- EasyPanel con pnpm en Dockerfile falla — usar npm dentro del contenedor
