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
  - `FETCH_TIMEOUT_MS`(既定 10000)
  - `FETCH_REQUEST_INTERVAL_MS`(既定 0)
  - `FETCH_RETRY_LIMIT`(既定 2)
  - `FETCH_RETRY_BASE_DELAY_MS`(既定 2000)
  - `PORT` または `SERVE_PORT`(任意、 配信ポート、 既定 3000)

## 開発・ビルド手順
```sh

# 依存関係のインストール
npm install

# データ取得 (CodiMD → S3/MinIO)
npm run fetch

# S3/MinIO → ローカル同期（ビルド前に実行）
npm run pull-notes

# Astroでビルド + Pagefind
npm run build

# ローカル確認
npm run preview
```

## デプロイ・運用

### GitHub Actions による自動化
- **fetch workflow（`.github/workflows/fetch.yml`）**：1時間ごとに CodiMD から取得した Markdown を S3 にアップロード
- **build workflow（`.github/workflows/build.yml`）**：6時間ごとに S3 から pull → Astro ビルド → dist を S3 にアップロード

`fetch` は CodiMD の `/notes` を正として扱い、CodiMD 側から削除されたノートは S3/MinIO の `notes/{id}.md` と manifest からも削除する。

### デプロイ
コンテナ起動時に S3 から最新の `dist.tar.gz` をダウンロードし、展開する。

```sh
# 依存関係のインストール
cd deploy && npm install

# サーバー起動 (S3からダウンロード -> 展開 -> サーバーを起動)
cd deploy && npm start
```

```sh
# 環境変数例
S3_ENDPOINT=...
S3_ACCESS_KEY=...
S3_SECRET_KEY=...
S3_BUCKET=...
S3_REGION=auto
PORT=3000  # 任意
```

ビルドは GitHub Actions で完結し、配信コンテナはメモリを抑えて軽量に動作します。
