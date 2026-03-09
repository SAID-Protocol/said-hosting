FROM node:22-slim AS builder

WORKDIR /app
COPY package*.json ./
COPY prisma/ ./prisma/
RUN npm ci
RUN npx prisma generate
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

FROM node:22-slim

RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
COPY prisma/ ./prisma/
RUN npm ci --omit=dev
RUN npx prisma generate
COPY --from=builder /app/dist ./dist

EXPOSE 3002

CMD ["node", "dist/index.js"]
