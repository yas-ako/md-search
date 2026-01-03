# --- Stage 1: Builder ---
FROM node:20-slim AS builder

ENV NODE_ENV=production

WORKDIR /app

# 依存関係インストール (tsxも入ります)
COPY package.json package-lock.json* ./
RUN npm ci

COPY . .

# 環境変数
ARG CODIMD_COOKIE
ARG CODIMD_BASE_URL
ENV CODIMD_COOKIE=$CODIMD_COOKIE
ENV CODIMD_BASE_URL=$CODIMD_BASE_URL

# CodiMD を取得して静的サイトを生成
RUN npx tsx scripts/fetch-codimd.ts
RUN npm run build && npm run postbuild

# --- Stage 2: Serve ---
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]