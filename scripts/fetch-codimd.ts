import fs from 'fs/promises';
import path from 'path';
import pLimit from 'p-limit';
import 'dotenv/config';

// 型定義
interface Note {
  id: string;
  text: string;
  timestamp: number;
}

interface NoteListResponse {
  notes: Note[];
}

// 環境変数と設定
const BASE_URL = process.env.CODIMD_BASE_URL;
const COOKIE = process.env.CODIMD_COOKIE;
const OUT_DIR = 'src/content/notes';

// 制御パラメータ
const FETCH_LIMIT = 20; // 取得する最大件数
const CONCURRENCY = 2; // 同時リクエスト数
const TIMEOUT_MS = 10_000; // fetch タイムアウト

async function fetchWithTimeout(url: string, init: RequestInit & { timeoutMs?: number } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetchWithTimeout(url, {
    headers: { Cookie: COOKIE ?? '' },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetchWithTimeout(url, {
    headers: { Cookie: COOKIE ?? '' },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  return res.text();
}

async function main() {

  if (!BASE_URL) {
    console.error('Error: CODIMD_BASE_URL environment variable is required.');
    process.exit(1);
  }
  
  if (!COOKIE) {
    console.error('Error: CODIMD_COOKIE environment variable is required.');
    process.exit(1);
  }

  // 出力ディレクトリの作成
  await fs.mkdir(OUT_DIR, { recursive: true });

  console.log(`Base URL: ${BASE_URL}`);
  console.log('Fetching note list...');

  try {
    // 1. ノート一覧を取得
    const { notes } = await fetchJson<NoteListResponse>(`${BASE_URL}/notes?limit=${FETCH_LIMIT}`);
    const total = notes.length;
    console.log(`Found ${total} notes. Start downloading with concurrency: ${CONCURRENCY}...`);

    // 並列実行の制御 (p-limit)
    const limit = pLimit(CONCURRENCY);
    let count = 0;
    let successCount = 0;

    const tasks = notes.map((note) => {
      return limit(async () => {
        try {
          // 進捗ログ
          count++;
          if (count % 100 === 0) {
            console.log(`Processing: ${count}/${total} (${Math.round((count / total) * 100)}%)`);
          }

          // 2. 本文ダウンロード
          const body = await fetchText(`${BASE_URL}/${note.id}/download`);

          // コンテンツチェック (空ならスキップ)
          if (!body) return;

          // Frontmatter作成
          const dateStr = new Date(note.timestamp).toISOString();
          const safeTitle = note.text.replace(/"/g, '\\"'); // タイトルのエスケープ

          const fileContent = `---
title: "${safeTitle}"
id: "${note.id}"
date: "${dateStr}"
---

${body}
`;

          await fs.writeFile(path.join(OUT_DIR, `${note.id}.md`), fileContent);
          successCount++;
        } catch (e: any) {
          // 個別の失敗はログに出して続行
          // console.error(`Failed: ${note.id} - ${e.message}`);
        }
      });
    });

    await Promise.all(tasks);
    console.log(`Done! Successfully saved ${successCount}/${total} notes.`);

  } catch (e: any) {
    console.error('Fatal Error during fetching list:', e.message);
    process.exit(1);
  }
}

main();