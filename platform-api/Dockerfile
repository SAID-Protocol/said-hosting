FROM node:22-slim AS builder

RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
COPY prisma/ ./prisma/
RUN npm ci
RUN npx prisma generate
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

FROM node:22-slim

RUN apt-get update && apt-get install -y openssl openssh-client && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
COPY prisma/ ./prisma/
RUN npm ci --omit=dev
RUN npx prisma generate
COPY --from=builder /app/dist ./dist

COPY start.sh ./
RUN chmod +x start.sh

EXPOSE 3002

CMD ["./start.sh"]
