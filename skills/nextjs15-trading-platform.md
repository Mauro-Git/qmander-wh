---
name: nextjs15-trading-platform
description: >
  Estándares de arquitectura para la plataforma multi-usuario de trading automatizado
  TradingView → cTrader, construida con Next.js 15 App Router, Prisma 5, PostgreSQL local
  (VPS Hostinger), NextAuth.js con Google, Tailwind CSS 3, y WebSocket (ws). Usar este skill
  siempre que se genere código para: Route Handlers, Server Components, Client Components,
  Server Actions, modelos Prisma, queries a la base de datos, autenticación NextAuth, webhook
  receiver, integración con cTrader Open API, o cualquier archivo TypeScript en el proyecto.
  También aplicar cuando el usuario pida refactorizar, revisar, optimizar, o depurar cualquier
  parte del stack. Si hay dudas sobre si aplicar el skill, aplicarlo.
---

# Next.js 15 — Plataforma de trading multi-usuario

## Stack de referencia
- **Framework**: Next.js 15 (App Router, Server Components por defecto)
- **Lenguaje**: TypeScript 5 estricto (`strict: true`)
- **Base de datos**: PostgreSQL local en VPS (Hostinger KVM2, EasyPanel)
- **ORM**: Prisma 5 con `@prisma/client`
- **Auth**: NextAuth.js (Auth.js) con Google provider
- **Estilos**: Tailwind CSS 3
- **Trading**: WebSocket (`ws`) + JSON → cTrader Open API puerto 5036
- **Validación**: Zod
- **Deploy**: Docker + EasyPanel + Traefik (auto-HTTPS)
- **Runtime**: Node.js 22+

## Diferencias con el skill genérico nextjs15-saas-b2b

| Aspecto | Genérico | Este proyecto |
|---------|----------|---------------|
| Base de datos | Neon (serverless, con pgbouncer) | PostgreSQL local (sin pgbouncer) |
| Auth | JWT custom con `jose` | NextAuth.js con Google |
| IA | OpenAI API | No aplica |
| Trading | No aplica | cTrader Open API (WebSocket+JSON) |
| Deploy | Genérico | EasyPanel + Traefik en VPS Hostinger |

---

## 1. PostgreSQL local — Sin connection pooling de Neon

### Conexión directa (sin pgbouncer)
```typescript
// lib/prisma.ts
import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
```

```
# .env — URL directa, sin pgbouncer ni directUrl
DATABASE_URL="postgresql://user:password@postgres-service:5432/trading?schema=public"
```

```prisma
// schema.prisma — sin directUrl (no se necesita con PostgreSQL local)
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

---

## 2. Autenticación — NextAuth.js con Google

### Configuración base
```typescript
// lib/auth.ts
import NextAuth from 'next-auth'
import Google from 'next-auth/providers/google'
import { PrismaAdapter } from '@auth/prisma-adapter'
import { prisma } from '@/lib/prisma'

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  callbacks: {
    session({ session, user }) {
      session.user.id = user.id
      return session
    },
  },
})
```

### Proteger páginas (Server Component)
```typescript
// app/dashboard/page.tsx
import { auth } from '@/lib/auth'
import { redirect } from 'next/navigation'

export default async function DashboardPage() {
  const session = await auth()
  if (!session?.user) redirect('/login')

  // ...el resto del componente
}
```

### Proteger Route Handlers
```typescript
// app/api/config/route.ts
import { auth } from '@/lib/auth'
import { NextResponse } from 'next/server'

export async function GET() {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  // ...
}
```

---

## 3. Modelo de datos — Multi-usuario con cTrader

### Schema Prisma central
```prisma
model User {
  id             String    @id @default(cuid())
  name           String?
  email          String    @unique
  emailVerified  DateTime?
  image          String?
  accounts       Account[]       // NextAuth
  sessions       Session[]       // NextAuth
  brokerAccount  BrokerAccount?  // cTrader
  config         UserConfig?     // Configuración de trading
  trades         Trade[]         // Historial de operaciones
  webhookToken   String    @unique @default(cuid())
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
}

model BrokerAccount {
  id              String   @id @default(cuid())
  userId          String   @unique
  user            User     @relation(fields: [userId], references: [id])
  ctraderHost     String   @default("demo.ctraderapi.com")
  clientId        String
  clientSecretEnc Bytes    // encriptado
  accessTokenEnc  Bytes    // encriptado
  refreshTokenEnc Bytes    // encriptado
  tokenIv         String
  tokenTag        String
  accountId       String   // ctidTraderAccountId
  status          String   @default("disconnected") // connected | disconnected | error
  expiresAt       DateTime?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}

model UserConfig {
  id             String   @id @default(cuid())
  userId         String   @unique
  user           User     @relation(fields: [userId], references: [id])
  allowedSymbols String[] @default([])
  maxLots        Float    @default(0.01)
  defaultSlPips  Float    @default(20)
  killSwitch     Boolean  @default(false)
  symbolMap      Json     @default("{}") // {"NAS100":"USTEC"}
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
}

model Trade {
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id])
  alertId   String
  action    String   // buy | sell | close
  ticker    String
  lots      Float?
  price     Float
  slPips    Float?
  tpPips    Float?
  status    String   // queued | executed | failed | retrying
  error     String?
  sourceIp  String
  createdAt DateTime @default(now())

  @@index([userId, createdAt(sort: Desc)])
  @@index([alertId])
}
```

---

## 4. Webhook Router — Multi-usuario

### Identificar usuario por token
```typescript
// app/api/webhook/tradingview/route.ts
export async function POST(req: NextRequest) {
  // 1. Parsear y validar esquema
  // 2. Buscar usuario por token
  const user = await prisma.user.findUnique({
    where: { webhookToken: alert.secret },
    include: { config: true, brokerAccount: true },
  })
  if (!user) return new Response('Not found', { status: 404 })

  // 3. Aplicar configuración DEL USUARIO (no global)
  if (user.config?.killSwitch) { /* rechazar */ }
  if (!user.config?.allowedSymbols.includes(alert.ticker)) { /* rechazar */ }
  if (alert.lots > (user.config?.maxLots ?? 0.01)) { /* rechazar */ }

  // 4. Ejecutar con las credenciales DEL USUARIO
  // ...
}
```

---

## 5. Estructura de archivos del proyecto

```
src/
├── app/
│   ├── (auth)/
│   │   └── login/page.tsx
│   ├── (dashboard)/
│   │   ├── layout.tsx          # Layout protegido con auth
│   │   ├── page.tsx            # Dashboard principal
│   │   ├── config/page.tsx     # Configuración del usuario
│   │   ├── trades/page.tsx     # Historial de operaciones
│   │   └── connect/page.tsx    # Wizard vinculación cTrader
│   ├── api/
│   │   ├── auth/[...nextauth]/route.ts
│   │   ├── webhook/tradingview/route.ts
│   │   ├── ctrader/callback/route.ts  # OAuth callback
│   │   └── config/route.ts
│   └── actions/
│       ├── config.ts           # Server Actions de configuración
│       └── broker.ts           # Server Actions de conexión broker
├── components/
│   ├── ui/                     # Componentes genéricos
│   └── features/
│       ├── connection-status.tsx
│       ├── kill-switch.tsx
│       ├── trade-feed.tsx
│       └── connect-wizard.tsx
├── lib/
│   ├── prisma.ts
│   ├── auth.ts
│   ├── crypto.ts               # Encriptación AES-256-GCM
│   └── ctrader/
│       ├── client.ts           # Cliente WebSocket+JSON
│       ├── pool.ts             # Pool de conexiones
│       └── types.ts
├── services/
│   ├── webhook.ts              # Lógica de validación
│   ├── trading.ts              # Lógica de ejecución
│   └── users.ts
└── types/
    └── index.ts
```

---

## 6. Reglas heredadas del skill genérico

Las siguientes reglas del skill `nextjs15-saas-b2b` siguen aplicando sin cambios:
- TypeScript estricto (sin `any`, Result types, const objects para enums)
- Prisma: evitar N+1, usar `select`, paginación obligatoria, transacciones
- Route Handlers: validar con Zod, autenticar primero
- Server Components por defecto, Client Components solo cuando hay interactividad
- Migraciones: solo `--create-only`, nunca aplicar automáticamente
- Git: feature branches, PRs con descripción, nunca merge directo a main

---

## 7. Checklist antes de generar código

- [ ] ¿Es Server Component o Client Component? (default: Server)
- [ ] ¿La autenticación usa `auth()` de NextAuth (no JWT manual)?
- [ ] ¿Los datos sensibles del broker están encriptados? (ver skill trading-security)
- [ ] ¿La UI sigue los principios de UX no técnico? (ver skill ux-non-technical)
- [ ] ¿Los tests cubren la funcionalidad? (ver skill trading-testing)
- [ ] ¿Las queries usan `select` y tienen paginación?
- [ ] ¿Los Route Handlers validan input con Zod?
- [ ] ¿Las operaciones multi-tabla están en `$transaction`?
- [ ] ¿El webhook identifica al usuario por su token personal?
