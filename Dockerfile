FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install

COPY src ./src
COPY scripts ./scripts

RUN mkdir -p /app/logs

ENV NODE_ENV=production
ENV LOG_DIR=/app/logs
EXPOSE 3000

CMD ["npx", "tsx", "src/server.ts"]
