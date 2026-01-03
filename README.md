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
  - `BUILD_INTERVAL_MS`(任意、 定期ビルド間隔ミリ秒、 既定 3600000)
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

## Docker 実行（定期 pull/build + 静的サーブ）
コンテナ起動時に S3 からの pull と Astro ビルドを行い、その後も一定間隔で再ビルドしつつ同一コンテナで配信します。

```sh
# コンテナ起動時に実行
npm run start  # 起動時に pull-notes & build を行い、その後 serve で dist を配信

# 環境変数例（コンテナ実行環境で設定）
S3_ENDPOINT=...
S3_ACCESS_KEY=...
S3_SECRET_KEY=...
S3_BUCKET=...
S3_REGION=auto
BUILD_INTERVAL_MS=3600000  # 任意: 1時間毎に pull/build
PORT=3000                  # 任意: 配信ポート
```

サーバは dist を配信し続け、ビルドはバックグラウンドで `pull-notes -> build -> postbuild` を行います。ビルドが完了すると dist を更新します。
