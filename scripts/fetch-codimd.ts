import pLimit from 'p-limit';
import YAML from 'js-yaml';
import {
  S3Client,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
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

type ManifestEntry = {
  lastFetchedAt: string;
  etag?: string;
};

type Manifest = Record<string, ManifestEntry>;

// 環境変数
const BASE_URL = process.env.CODIMD_BASE_URL;
const COOKIE = process.env.CODIMD_COOKIE;

const S3_ENDPOINT = process.env.S3_ENDPOINT;
const S3_REGION = process.env.S3_REGION || 'auto';
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY;
const S3_SECRET_KEY = process.env.S3_SECRET_KEY;
const S3_BUCKET = process.env.S3_BUCKET;

const BATCH_LIMIT = process.env.FETCH_BATCH_LIMIT ? Number(process.env.FETCH_BATCH_LIMIT) : 300; // 1サイクルの最大件数
const CONCURRENCY = process.env.FETCH_CONCURRENCY ? Number(process.env.FETCH_CONCURRENCY) : 4; // 同時にリクエストする数
const TIMEOUT_MS = process.env.FETCH_TIMEOUT_MS ? Number(process.env.FETCH_TIMEOUT_MS) : 10_000; // タイムアウト
const REQUEST_INTERVAL_MS = process.env.FETCH_REQUEST_INTERVAL_MS ? Number(process.env.FETCH_REQUEST_INTERVAL_MS) : 0; // リクエスト開始間隔
const RETRY_LIMIT = process.env.FETCH_RETRY_LIMIT ? Number(process.env.FETCH_RETRY_LIMIT) : 2; // 追加リトライ回数
const RETRY_BASE_DELAY_MS = process.env.FETCH_RETRY_BASE_DELAY_MS ? Number(process.env.FETCH_RETRY_BASE_DELAY_MS) : 2_000; // リトライ待機の初期値

class HttpError extends Error {
  status: number;
  statusText: string;

  constructor(status: number, statusText: string) {
    super(`HTTP ${status} ${statusText}`);
    this.name = 'HttpError';
    this.status = status;
    this.statusText = statusText;
  }
}

class RequestTimeoutError extends Error {
  timeoutMs: number;
  elapsedMs: number;

  constructor(timeoutMs: number, elapsedMs: number) {
    super(`Request timed out after ${elapsedMs}ms (timeout: ${timeoutMs}ms)`);
    this.name = 'RequestTimeoutError';
    this.timeoutMs = timeoutMs;
    this.elapsedMs = elapsedMs;
  }
}

async function fetchWithTimeout(url: string, init: RequestInit & { timeoutMs?: number } = {}) {
  const controller = new AbortController();
  const timeoutMs = init.timeoutMs ?? TIMEOUT_MS;
  const startedAt = Date.now();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return res;
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      throw new RequestTimeoutError(timeoutMs, Date.now() - startedAt);
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetchWithTimeout(url, {
    headers: { Cookie: COOKIE ?? '' },
  });
  if (!res.ok) {
    throw new HttpError(res.status, res.statusText);
  }
  return res.json() as Promise<T>;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetchWithTimeout(url, {
    headers: { Cookie: COOKIE ?? '' },
  });
  if (!res.ok) {
    throw new HttpError(res.status, res.statusText);
  }
  return res.text();
}

function formatDuration(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function classifyError(e: any) {
  if (e instanceof RequestTimeoutError) {
    return `timeout after ${formatDuration(e.elapsedMs)}`;
  }
  if (e instanceof HttpError) {
    return `HTTP ${e.status}`;
  }
  return e?.name || e?.message || 'unknown error';
}

function sleep(ms: number) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetry(e: any) {
  if (e instanceof RequestTimeoutError) return true;
  if (e instanceof HttpError) return e.status === 429 || e.status === 500 || e.status === 502 || e.status === 503 || e.status === 504;
  return false;
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= RETRY_LIMIT || !shouldRetry(e)) {
        throw e;
      }
      const delayMs = RETRY_BASE_DELAY_MS * 2 ** attempt;
      await sleep(delayMs);
      attempt++;
    }
  }
}

let nextRequestAt = 0;

async function waitForRequestSlot() {
  const now = Date.now();
  const scheduledAt = Math.max(now, nextRequestAt);
  nextRequestAt = scheduledAt + REQUEST_INTERVAL_MS;
  await sleep(scheduledAt - now);
}

function createS3Client() {
  return new S3Client({
    endpoint: S3_ENDPOINT,
    region: S3_REGION,
    credentials:
      S3_ACCESS_KEY && S3_SECRET_KEY
        ? {
          accessKeyId: S3_ACCESS_KEY,
          secretAccessKey: S3_SECRET_KEY,
        }
        : undefined,
    forcePathStyle: true,
  });
}

async function streamToString(body: GetObjectCommandOutput['Body']): Promise<string> {
  if (!body) return '';
  // Node SDK v3 has transformToString in recent versions
  const anyBody = body as { transformToString?: () => Promise<string> };
  if (anyBody.transformToString) return anyBody.transformToString();

  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    (body as any)
      .on('data', (chunk: Buffer) => chunks.push(chunk))
      .on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
      .on('error', reject);
  });
}

async function getManifest(s3: S3Client): Promise<Manifest> {
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: S3_BUCKET, Key: 'meta/manifest.json' })
    );
    const text = await streamToString(res.Body);
    return text ? (JSON.parse(text) as Manifest) : {};
  } catch (e: any) {
    if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NoSuchKey') {
      return {};
    }
    console.error('Failed to load manifest:', e?.message ?? e);
    return {};
  }
}

async function putManifest(s3: S3Client, manifest: Manifest) {
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: 'meta/manifest.json',
      Body: JSON.stringify(manifest, null, 2),
      ContentType: 'application/json',
    })
  );
}

async function uploadNote(s3: S3Client, id: string, content: string) {
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: `notes/${id}.md`,
      Body: content,
      ContentType: 'text/markdown; charset=utf-8',
    })
  );
}

async function deleteNote(s3: S3Client, id: string) {
  await s3.send(
    new DeleteObjectCommand({
      Bucket: S3_BUCKET,
      Key: `notes/${id}.md`,
    })
  );
}

function getStaleNoteIds(manifest: Manifest, currentIds: Set<string>) {
  return Object.keys(manifest).filter((id) => !currentIds.has(id));
}

async function deleteStaleNotes(s3: S3Client, manifest: Manifest, currentIds: Set<string>, currentNoteCount: number) {
  const manifestCount = Object.keys(manifest).length;
  if (manifestCount > 0 && currentNoteCount < manifestCount * 0.8) {
    console.warn(
      `Skipped stale deletion because note list looked incomplete. Notes: ${currentNoteCount}, manifest entries: ${manifestCount}`
    );
    return;
  }

  const staleIds = getStaleNoteIds(manifest, currentIds);
  if (staleIds.length === 0) return;

  let deletedCount = 0;
  const deleteFailureCounts = new Map<string, number>();

  for (const id of staleIds) {
    try {
      await deleteNote(s3, id);
      delete manifest[id];
      deletedCount++;
    } catch (e: any) {
      const key = classifyError(e);
      deleteFailureCounts.set(key, (deleteFailureCounts.get(key) ?? 0) + 1);
    }
  }

  console.log(`Deleted stale notes: ${deletedCount}/${staleIds.length}`);
  if (deleteFailureCounts.size > 0) {
    console.warn('Delete failures by type:');
    for (const [type, count] of deleteFailureCounts) {
      console.warn(`- ${type}: ${count}`);
    }
  }
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

  if (!S3_BUCKET || !S3_ENDPOINT || !S3_ACCESS_KEY || !S3_SECRET_KEY) {
    console.error('Error: S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET are required.');
    process.exit(1);
  }

  const s3 = createS3Client();
  const manifest = await getManifest(s3);

  console.log(`Fetch settings: batchLimit=${BATCH_LIMIT}, concurrency=${CONCURRENCY}, timeout=${formatDuration(TIMEOUT_MS)}, requestInterval=${formatDuration(REQUEST_INTERVAL_MS)}, retryLimit=${RETRY_LIMIT}, retryBaseDelay=${formatDuration(RETRY_BASE_DELAY_MS)}`);
  console.log(`Loaded manifest entries: ${Object.keys(manifest).length}`);
  console.log('Fetching note list...');

  try {
    // ノート一覧を取得
    const listStartedAt = Date.now();
    const { notes } = await fetchJson<NoteListResponse>(`${BASE_URL}/notes`);
    const total = notes.length;
    const currentIds = new Set(notes.map((note) => note.id));
    console.log(`Fetched note list in ${formatDuration(Date.now() - listStartedAt)}. Notes: ${total}`);
    await deleteStaleNotes(s3, manifest, currentIds, total);

    // まだ取得していないものを優先、lastFetchedAt が古い順
    const candidates = [...notes]
      .sort((a, b) => {
        const aTime = manifest[a.id]?.lastFetchedAt;
        const bTime = manifest[b.id]?.lastFetchedAt;
        if (!aTime && !bTime) return 0;
        if (!aTime) return -1;
        if (!bTime) return 1;
        return new Date(aTime).getTime() - new Date(bTime).getTime();
      })
      .slice(0, BATCH_LIMIT);

    console.log(
      `Found ${total} notes. Picking ${candidates.length} oldest entries. Concurrency: ${CONCURRENCY}`
    );

    // 並列実行
    const limit = pLimit(CONCURRENCY);
    let count = 0;
    let successCount = 0;
    let emptyCount = 0;
    const failureCounts = new Map<string, number>();

    const tasks = candidates.map((note) => {
      return limit(async () => {
        try {
          count++;
          if (count % 100 === 0) {
            console.log(`Processing: ${count}/${candidates.length} (${Math.round((count / candidates.length) * 100)}%)`);
          }

          // 本文ダウンロード
          const body = await withRetry(async () => {
            await waitForRequestSlot();
            return fetchText(`${BASE_URL}/${note.id}/download`);
          });

          // 空ノートでも frontmatter は保存し、次回以降の再取得対象から外す
          if (!body) {
            emptyCount++;
          }

          // Frontmatter
          const frontmatter = {
            title: note.text || note.id,
            id: note.id,
            date: new Date(note.timestamp).toISOString(),
          };
          const fileContent = `---\n${YAML.dump(frontmatter)}---\n\n${body}\n`;

          await uploadNote(s3, note.id, fileContent);
          manifest[note.id] = { lastFetchedAt: new Date().toISOString() };
          successCount++;
        } catch (e: any) {
          // 個別の失敗は note ID を出さずに集計する
          const key = classifyError(e);
          failureCounts.set(key, (failureCounts.get(key) ?? 0) + 1);
        }
      });
    });

    await Promise.all(tasks);
    await putManifest(s3, manifest);
    console.log(`Done! Successfully saved ${successCount}/${candidates.length} picked notes. Total notes: ${total}. Empty: ${emptyCount}.`);
    if (failureCounts.size > 0) {
      console.warn('Failures by type:');
      for (const [type, count] of failureCounts) {
        console.warn(`- ${type}: ${count}`);
      }
    }

  } catch (e: any) {
    console.error('Fatal Error during fetching list:', classifyError(e));
    if (e instanceof RequestTimeoutError) {
      console.error(`Hint: try setting FETCH_TIMEOUT_MS to a larger value, e.g. 60000.`);
    }
    process.exit(1);
  }
}

main();
