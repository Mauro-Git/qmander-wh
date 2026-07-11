---
name: trading-testing
description: >
  Estrategia de testing para la plataforma de trading automatizado TradingView → cTrader.
  Usar este skill siempre que se escriban tests, se diseñen casos de prueba, se configure el
  framework de testing, o se valide cualquier funcionalidad del sistema. También aplicar cuando
  se agreguen nuevas features que necesiten cobertura de tests, o cuando se depuren fallos en
  producción que debieron haberse detectado con tests. Cubre: tests unitarios para validación
  de webhooks, tests de integración para el flujo completo alerta→orden, tests de las conversiones
  de volumen/pips, tests de seguridad para encriptación y autenticación, y tests del frontend.
  Incluye mocks para cTrader y TradingView para no depender de servicios externos en CI.
---

# Testing — Plataforma de trading automatizado

## 1. Stack de testing

```json
{
  "devDependencies": {
    "vitest": "^2.0.0",
    "@testing-library/react": "^16.0.0",
    "@testing-library/user-event": "^14.0.0",
    "msw": "^2.0.0"
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
  }
}
```

- **Vitest** — test runner (compatible con el ecosistema Next.js/Vite)
- **Testing Library** — tests de componentes React
- **MSW (Mock Service Worker)** — interceptar llamadas HTTP en tests

---

## 2. Qué testear y qué no

### SIEMPRE testear (riesgo alto)
- Validación del webhook (las 5 capas de seguridad)
- Conversión de lotes a volumen de API (`lots * lotSize`)
- Conversión de pips a `relativeStopLoss` (`pipFactor`)
- Encriptación/desencriptación de tokens
- Comparación timing-safe del token secreto
- Lógica de idempotencia (deduplicación)
- Límites de riesgo (max lots, allowed symbols, kill switch)
- Resolución de símbolos (mapeo TradingView → cTrader)
- Renovación de tokens OAuth

### TESTEAR con prioridad media
- Componentes del dashboard (estados de conexión, feed de operaciones)
- Flujo de onboarding/wizard OAuth
- Formularios de configuración (validaciones)
- Paginación y filtros del historial

### NO testear (bajo valor)
- Estilos CSS / diseño visual (validar manualmente)
- Configuración de Next.js o Prisma
- Código generado por terceros

---

## 3. Tests unitarios — Webhook y riesgo

### Estructura de test para el webhook
```typescript
// tests/webhook.test.ts
import { describe, it, expect } from 'vitest'

describe('Webhook validation', () => {
  describe('Layer 1: IP filtering', () => {
    it('accepts requests from TradingView IPs', () => { ... })
    it('rejects requests from unknown IPs', () => { ... })
    it('handles IPv6 mapped addresses (::ffff:x.x.x.x)', () => { ... })
  })

  describe('Layer 2: Token verification', () => {
    it('accepts valid token', () => { ... })
    it('rejects invalid token', () => { ... })
    it('uses timing-safe comparison', () => { ... })
    it('rejects empty token', () => { ... })
  })

  describe('Layer 3: Schema + freshness', () => {
    it('accepts valid payload', () => { ... })
    it('rejects payload missing required fields', () => { ... })
    it('rejects payload older than 60 seconds', () => { ... })
    it('rejects payload from the future (>10s)', () => { ... })
    it('rejects invalid action values', () => { ... })
  })

  describe('Layer 4: Idempotency', () => {
    it('processes first request with alert_id', () => { ... })
    it('rejects duplicate alert_id', () => { ... })
    it('cleans up old alert_ids after 10 minutes', () => { ... })
  })

  describe('Layer 5: Risk controls', () => {
    it('rejects symbol not in allowed list', () => { ... })
    it('rejects lots exceeding max', () => { ... })
    it('rejects orders without stop loss', () => { ... })
    it('rejects when kill switch is active', () => { ... })
  })
})
```

---

## 4. Tests críticos — Conversiones numéricas

Estos son los tests que previenen pérdidas reales por bugs matemáticos.

### Conversión de lotes a volumen
```typescript
describe('Volume conversion', () => {
  it('converts 0.01 lots to correct volume for forex', () => {
    // lotSize para EURUSD típicamente = 100000
    const volume = Math.round(0.01 * 100000)
    expect(volume).toBe(1000) // 1,000 unidades = micro lote
  })

  it('converts 1.0 lots to correct volume', () => {
    const volume = Math.round(1.0 * 100000)
    expect(volume).toBe(100000) // lote estándar
  })

  it('handles different lotSizes per symbol', () => {
    // NAS100 puede tener lotSize diferente
    const volume = Math.round(0.01 * 1) // lotSize = 1 para índices
    expect(volume).toBe(0) // ← esto fallaría, hay que verificar
  })
})
```

### Conversión de pips a relativeStopLoss
```typescript
describe('Pip conversion', () => {
  it('converts pips to relative SL for 5-digit forex (EURUSD)', () => {
    // pipPosition = 4 para EURUSD
    const pipFactor = Math.pow(10, 5 - 4) // = 10
    const relativeSL = Math.round(20 * pipFactor) // 20 pips
    expect(relativeSL).toBe(200)
  })

  it('converts pips to relative SL for 3-digit pairs (USDJPY)', () => {
    // pipPosition = 2 para USDJPY
    const pipFactor = Math.pow(10, 5 - 2) // = 1000
    const relativeSL = Math.round(20 * pipFactor)
    expect(relativeSL).toBe(20000)
  })

  it('converts pips to relative SL for indices', () => {
    // pipPosition varía por índice — verificar con datos reales
  })
})
```

---

## 5. Mocks — cTrader y TradingView

### Mock del cliente cTrader
```typescript
// tests/mocks/ctrader.ts
export function createMockCTrader() {
  const symbols = new Map([
    ['EURUSD', { symbolId: 1, lotSize: 100000, pipPosition: 4 }],
    ['USDJPY', { symbolId: 2, lotSize: 100000, pipPosition: 2 }],
    ['NAS100', { symbolId: 3, lotSize: 1, pipPosition: 1 }],
  ])

  return {
    connected: true,
    marketOrder: vi.fn().mockResolvedValue(undefined),
    closeAll: vi.fn().mockResolvedValue(1),
    resolveSymbolId: (ticker: string) => {
      const s = symbols.get(ticker.toUpperCase())
      if (!s) throw new Error(`Símbolo no encontrado: ${ticker}`)
      return s.symbolId
    },
    getSymbolDetails: (id: number) => {
      for (const [, s] of symbols) {
        if (s.symbolId === id) return s
      }
      throw new Error(`Símbolo ${id} no encontrado`)
    },
  }
}
```

### Mock de payload de TradingView
```typescript
// tests/mocks/tradingview.ts
export function createValidPayload(overrides = {}) {
  return {
    secret: 'a'.repeat(64),
    alert_id: `${Date.now()}-EURUSD-test`,
    action: 'buy' as const,
    ticker: 'EURUSD',
    price: 1.1000,
    time: Date.now(),
    lots: 0.01,
    sl_pips: 20,
    tp_pips: 40,
    ...overrides,
  }
}

export function createExpiredPayload(overrides = {}) {
  return createValidPayload({
    time: Date.now() - 120_000, // 2 minutos atrás
    ...overrides,
  })
}
```

---

## 6. Tests de integración

### Flujo completo webhook → orden (con mock de cTrader)
```typescript
describe('Full webhook flow', () => {
  it('valid buy alert creates market order', async () => {
    const mock = createMockCTrader()
    const payload = createValidPayload()

    const response = await sendWebhook(payload)

    expect(response.status).toBe(200)
    await waitForQueue() // esperar a que la cola procese
    expect(mock.marketOrder).toHaveBeenCalledWith({
      ticker: 'EURUSD',
      side: 'buy',
      lots: 0.01,
      slPips: 20,
      tpPips: 40,
      label: expect.any(String),
    })
  })

  it('close alert closes all positions for symbol', async () => {
    const mock = createMockCTrader()
    const payload = createValidPayload({ action: 'close' })

    const response = await sendWebhook(payload)

    expect(response.status).toBe(200)
    await waitForQueue()
    expect(mock.closeAll).toHaveBeenCalledWith('EURUSD')
  })
})
```

---

## 7. Tests de seguridad

### Encriptación round-trip
```typescript
describe('Encryption', () => {
  it('encrypts and decrypts correctly', () => {
    const original = 'eyJhbGciOiJSUzI1NiIsInR5...'
    const { encrypted, iv, tag } = encrypt(original)
    const decrypted = decrypt(encrypted, iv, tag)
    expect(decrypted).toBe(original)
  })

  it('different inputs produce different ciphertexts', () => {
    const a = encrypt('token_a')
    const b = encrypt('token_b')
    expect(a.encrypted).not.toEqual(b.encrypted)
  })

  it('same input produces different ciphertexts (random IV)', () => {
    const a = encrypt('same_token')
    const b = encrypt('same_token')
    expect(a.iv).not.toBe(b.iv)
  })

  it('fails with wrong key', () => {
    const { encrypted, iv, tag } = encrypt('secret')
    // Cambiar ENCRYPTION_KEY...
    expect(() => decrypt(encrypted, iv, tag)).toThrow()
  })
})
```

---

## 8. Estructura de archivos de tests

```
tests/
├── unit/
│   ├── webhook-validation.test.ts
│   ├── volume-conversion.test.ts
│   ├── pip-conversion.test.ts
│   ├── encryption.test.ts
│   └── token-comparison.test.ts
├── integration/
│   ├── webhook-flow.test.ts
│   ├── oauth-flow.test.ts
│   └── user-config.test.ts
├── components/
│   ├── connection-status.test.tsx
│   ├── kill-switch.test.tsx
│   └── trade-feed.test.tsx
└── mocks/
    ├── ctrader.ts
    ├── tradingview.ts
    └── prisma.ts
```

---

## 9. Reglas de CI

### Ejecutar tests antes de cada deploy
- `npm test` debe pasar antes de que EasyPanel despliegue
- Cobertura mínima: 80% en archivos de `lib/` y `services/`
- Tests de conversión numérica: 100% cobertura obligatoria
- Un test fallido bloquea el deploy

### Tests que NO deben correr en CI
- Tests que requieran conexión real a cTrader (usar mocks)
- Tests que requieran base de datos real (usar Prisma mock)
- Tests de performance (correr manualmente)
