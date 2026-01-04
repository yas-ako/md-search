import pLimit from 'p-limit';
import YAML from 'js-yaml';
import {
  S3Client,
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
const TIMEOUT_MS = 10_000; // タイムアウト

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

  console.log(`Base URL: ${BASE_URL}`);
  console.log('Fetching note list...');

  try {
    // ノート一覧を取得
    const { notes } = await fetchJson<NoteListResponse>(`${BASE_URL}/notes`);
    const total = notes.length;

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

    const tasks = candidates.map((note) => {
      return limit(async () => {
        try {
          count++;
          if (count % 100 === 0) {
            console.log(`Processing: ${count}/${candidates.length} (${Math.round((count / candidates.length) * 100)}%)`);
          }

          // 本文ダウンロード
          const body = await fetchText(`${BASE_URL}/${note.id}/download`);

          // 空ならスキップ
          if (!body) return;

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
          // 個別の失敗はログに出して続行
          // console.error(`Failed: ${note.id} - ${e.message}`);
        }
      });
    });

    await Promise.all(tasks);
    await putManifest(s3, manifest);
    console.log(`Done! Successfully saved ${successCount}/${total} notes.`);

  } catch (e: any) {
    console.error('Fatal Error during fetching list:', e.message);
    process.exit(1);
  }
}

main();