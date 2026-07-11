FROM node:22-alpine

RUN npm install -g pnpm

WORKDIR /app

COPY package.json ./
RUN pnpm install

COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production
EXPOSE 3000

CMD ["pnpm", "start"]