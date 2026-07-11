---
name: trading-security
description: >
  Reglas de seguridad obligatorias para la plataforma de trading automatizado TradingView → cTrader.
  Usar este skill siempre que se genere código que toque: credenciales de broker (access tokens, client
  secrets, API keys), webhooks que ejecutan órdenes, flujos OAuth de cTrader/Spotware, encriptación de
  datos sensibles en PostgreSQL, validación de alertas de TradingView, control de riesgo (lotes, drawdown,
  kill switch), o cualquier endpoint que interactúe con dinero real o cuentas de trading. También aplicar
  cuando se revise, refactorice, o depure código existente que involucre estas áreas. Si hay dudas sobre
  si aplicar el skill, aplicarlo — un error de seguridad en trading puede costar dinero real.
---

# Seguridad para plataforma de trading automatizado

## 1. Credenciales de broker — Encriptación en reposo

### Nunca almacenar tokens en texto plano
```typescript
// ❌ MAL — token visible en la base de datos
model UserBrokerAccount {
  accessToken  String
  refreshToken String
}

// ✅ BIEN — encriptados con AES-256-GCM
model UserBrokerAccount {
  accessTokenEnc  Bytes   // encriptado
  refreshTokenEnc Bytes   // encriptado
  tokenIv         String  // vector de inicialización
  tokenTag        String  // tag de autenticación
}
```

### Módulo de encriptación estándar
```typescript
// lib/crypto.ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const KEY = Buffer.from(process.env.ENCRYPTION_KEY!, 'hex') // 32 bytes

export function encrypt(text: string): { encrypted: Buffer; iv: string; tag: string } {
  const iv = randomBytes(16)
  const cipher = createCipheriv(ALGORITHM, KEY, iv)
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return { encrypted, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex') }
}

export function decrypt(encrypted: Buffer, iv: string, tag: string): string {
  const decipher = createDecipheriv(ALGORITHM, KEY, Buffer.from(iv, 'hex'))
  decipher.setAuthTag(Buffer.from(tag, 'hex'))
  return decipher.update(encrypted) + decipher.final('utf8')
}
```

### ENCRYPTION_KEY debe ser única por entorno
```bash
# Generar con:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Guardar en variables de entorno, NUNCA en código o .env del repo
```

---

## 2. Webhook — Validación multi-capa

### Las 5 capas son obligatorias, no opcionales
Cada webhook que ejecute órdenes DEBE implementar en este orden:
1. **IP de origen** — solo IPs publicadas por TradingView
2. **Token secreto** — comparación timing-safe (nunca `===`)
3. **Esquema + frescura** — Zod + ventana de 60 segundos
4. **Idempotencia** — deduplicación por `alert_id`
5. **Riesgo** — símbolos, lotes máx, kill switch

### Token por usuario, no global
```typescript
// ❌ MAL — un solo token para todos
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET

// ✅ BIEN — cada usuario tiene su propio token
const user = await prisma.user.findUnique({
  where: { webhookToken: alert.secret }
})
if (!user) return res.status(404).send('Not found')
```

### Nunca loguear el payload completo
```typescript
// ❌ MAL — el token secreto queda en los logs
console.log('Webhook recibido:', JSON.stringify(body))

// ✅ BIEN — loguear solo datos no sensibles
console.log(`Webhook: ${alert.action} ${alert.ticker} ${alert.lots} lotes`)
```

---

## 3. OAuth cTrader — Flujo seguro

### El authorization code expira en minutos
- Intercambiar inmediatamente después de recibir el redirect
- Si falla, generar nuevo code (nunca reutilizar)
- Limpiar variables de entorno entre intentos

### Access tokens expiran (~30 días)
- Implementar renovación automática con refresh token
- Almacenar fecha de expiración y renovar proactivamente
- Si la renovación falla, marcar la cuenta como desconectada y notificar

### Redirect URI debe coincidir exactamente
- Misma URI en el registro de la app, en la generación del code, y en el intercambio
- Diferencias de barra final `/`, `http` vs `https`, o casing invalidan el flujo

---

## 4. Control de riesgo — Reglas por usuario

### Límites obligatorios (no opcionales)
Cada cuenta de usuario DEBE tener configurados:
- `maxLots` — cantidad máxima por orden
- `allowedSymbols` — lista blanca de símbolos
- `defaultSlPips` — stop loss por defecto (si la alerta no lo trae)
- `killSwitch` — interruptor de emergencia

### Stop loss obligatorio en órdenes de mercado
```typescript
// ❌ MAL — permite órdenes sin stop loss
if (params.slPips) payload.relativeStopLoss = ...

// ✅ BIEN — rechaza órdenes sin stop loss
if (params.slPips <= 0) throw new Error('Stop loss obligatorio')
```

### Reglas adicionales para prop firms (FTMO)
- Máximo 1500 peticiones/día al servidor (FTMO prohíbe >2000)
- Llevar contador diario y frenar antes del límite
- No operar 2 minutos antes/después de noticias de alto impacto (cuentas fondeadas)
- Validar drawdown diario (5%) y total (10%) antes de cada orden

---

## 5. Endpoints de administración

### Proteger con el mismo estándar que los webhooks
```typescript
// ❌ MAL — endpoint de admin sin autenticación
app.post('/admin/kill-switch', (req, res) => { ... })

// ✅ BIEN — autenticación requerida
app.post('/admin/kill-switch', requireAuth, (req, res) => { ... })
```

### Respuestas genéricas ante credenciales inválidas
```typescript
// ❌ MAL — revela que el endpoint existe
return res.status(401).send('Invalid token')

// ✅ BIEN — no confirma nada
return res.status(404).send('Not found')
```

---

## 6. Base de datos — Datos sensibles

### Campos que DEBEN estar encriptados
- `accessToken` (cTrader)
- `refreshToken` (cTrader)
- `clientSecret` (cTrader)
- `webhookToken` (token del webhook, hasheado no encriptado)

### Campos que NO deben exponerse en el frontend
- Tokens encriptados (obvio)
- `clientSecret`
- IPs de TradingView
- Detalles internos de errores del broker

### Auditoría obligatoria
Cada operación ejecutada debe registrarse con:
- userId, timestamp, acción, símbolo, lotes, precio
- Resultado (éxito/error) y mensaje de error si aplica
- IP de origen del webhook
- No borrar registros de auditoría (solo soft delete si es necesario)

---

## 7. Checklist de seguridad antes de deploy

- [ ] ¿Los tokens del broker están encriptados en la DB?
- [ ] ¿El ENCRYPTION_KEY está en variables de entorno (no en código)?
- [ ] ¿Cada usuario tiene su propio webhookToken?
- [ ] ¿Las 5 capas de validación del webhook están activas?
- [ ] ¿El stop loss es obligatorio en órdenes de mercado?
- [ ] ¿Los endpoints de admin requieren autenticación?
- [ ] ¿Los logs no contienen tokens ni secrets?
- [ ] ¿El .env y node_modules están en .gitignore?
- [ ] ¿HTTPS está activo (TradingView lo requiere)?
- [ ] ¿Las IPs de TradingView están actualizadas?
