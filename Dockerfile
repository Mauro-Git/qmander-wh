# Alpine no trae openssl instalado, y Prisma detecta la versión de OpenSSL en
# tiempo de ejecución (no solo al generar) — necesario en ambas etapas.
# Ver "Aprendizajes" en CLAUDE.md (mismo bug ya resuelto en trading-dashboard).

# ---- Dependencias (incluye `prisma generate` vía postinstall) ----
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache openssl
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm install

# ---- Runtime ----
FROM node:22-alpine AS runner
WORKDIR /app
RUN apk add --no-cache openssl
ENV NODE_ENV=production
ENV LOG_DIR=/app/logs

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY prisma ./prisma
COPY src ./src
COPY scripts ./scripts

RUN mkdir -p /app/logs

EXPOSE 3000
CMD ["npx", "tsx", "src/server.ts"]
