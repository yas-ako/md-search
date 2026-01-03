# md-search

Astro + Pagefind で CodiMD を全文検索する。ビルド時に CodiMD から Markdown を取得し、検索インデックスを生成。

## 必要な環境変数 (.env)
- `CODIMD_COOKIE` (必須): CodiMD への認証 Cookie
- `CODIMD_BASE_URL` (必須): CodiMDのURL

## 開発・ビルド手順
```sh

# 依存関係のインストール
npm install

# データ取得 (認証が必要)
npm run fetch

# 静的ビルド + Pagefind インデックス生成
# postbuild フックが走るので build だけで OK
npm run build

# ローカル確認
npm run preview
```
## Dockerfile によるデプロイ

開発中