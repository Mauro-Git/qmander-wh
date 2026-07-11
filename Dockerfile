FROM node:22-alpine

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile --prod || pnpm install --prod
RUN pnpm add tsx

COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production
EXPOSE 3000

CMD ["pnpm", "start"]
