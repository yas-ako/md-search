FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .

# 環境変数で PORT/BUID_INTERVAL_MS を上書き可能
EXPOSE 3000

CMD ["npm", "run", "start"]