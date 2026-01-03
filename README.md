# md-search

Astro + Pagefind で CodiMD を全文検索する。CodiMD から取得した Markdown を S3/MinIO に保存し、ビルド時に同期してインデックスを生成。

## 必要な環境変数 (.env)
- CodiMD
  - `CODIMD_COOKIE` (必須)
  - `CODIMD_BASE_URL` (必須)
- S3/MinIO
  - `S3_ENDPOINT`
  - `S3_REGION`(任意、既定 `auto`)
  - `S3_ACCESS_KEY`
  - `S3_SECRET_KEY`
  - `S3_BUCKET`
- 取得挙動の調整
  - `FETCH_BATCH_LIMIT`(既定 300)
  - `FETCH_CONCURRENCY`(既定 4)
  - `PORT` または `SERVE_PORT`(任意、 配信ポート、 既定 3000)

## 開発・ビルド手順
```sh

# 依存関係のインストール
npm install

# データ取得 (CodiMD → S3/MinIO)
npm run fetch

# S3/MinIO → ローカル同期（ビルド前に実行）
npm run pull-notes

# 静的ビルド + Pagefind インデックス生成（postbuild 自動）
npm run build

# ローカル確認
npm run preview
```

## デプロイ・運用

### GitHub Actions による自動化
- **fetch workflow（`.github/workflows/fetch.yml`）**：1時間ごとに CodiMD から取得した Markdown を S3 にアップロード
- **build workflow（`.github/workflows/build.yml`）**：6時間ごとに S3 から pull → Astro ビルド → dist を S3 にアップロード

### Docker / Buildpack による配信
コンテナ起動時に S3 から最新の `dist.tar.gz` をダウンロードし、展開して配信します。

```sh
# Buildpack の場合（Procfile 使用）
# Procfile: web: npm run serve-dist

# Docker の場合
docker run -e S3_ENDPOINT=... -e S3_ACCESS_KEY=... -e S3_SECRET_KEY=... -e S3_BUCKET=... -p 3000:3000 <image>

# 環境変数例
S3_ENDPOINT=...
S3_ACCESS_KEY=...
S3_SECRET_KEY=...
S3_BUCKET=...
S3_REGION=auto
PORT=3000  # 任意
```

ビルドは GitHub Actions で完結し、配信コンテナはメモリを抑えて軽量に動作します。
