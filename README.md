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
