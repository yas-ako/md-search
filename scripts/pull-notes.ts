import fs from 'fs/promises';
import path from 'path';
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import 'dotenv/config';

const S3_ENDPOINT = process.env.S3_ENDPOINT;
const S3_REGION = process.env.S3_REGION || 'auto';
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY;
const S3_SECRET_KEY = process.env.S3_SECRET_KEY;
const S3_BUCKET = process.env.S3_BUCKET;

const OUT_DIR = 'src/content/notes';

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

async function downloadObject(client: S3Client, key: string) {
  const res = await client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  return streamToString(res.Body);
}

function removeRelativeImages(markdown: string): string {
  // Markdown画像参照 ![alt](path){attributes} の ! を削除
  // ビルドエラーを避けるため、相対パス画像は画像参照ではなくテキストリンクに変換
  return markdown.replace(/!\[([^\]]*)\]\(([^)]*)\)(\{[^}]*\})?/g, '[$1]($2)$3');
}

async function listKeys(client: S3Client, prefix: string): Promise<string[]> {
  let continuationToken: string | undefined;
  const keys: string[] = [];

  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );
    if (res.Contents) {
      for (const obj of res.Contents) {
        if (obj.Key) keys.push(obj.Key);
      }
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);

  return keys;
}

async function main() {
  if (!S3_BUCKET || !S3_ENDPOINT || !S3_ACCESS_KEY || !S3_SECRET_KEY) {
    console.error('Error: S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET are required.');
    process.exit(1);
  }

  await fs.mkdir(OUT_DIR, { recursive: true });

  const s3 = createS3Client();
  console.log('Listing objects from S3...');
  const keys = await listKeys(s3, 'notes/');
  console.log(`Found ${keys.length} objects.`);

  let count = 0;
  for (const key of keys) {
    if (!key.endsWith('.md')) continue;
    let body = await downloadObject(s3, key);
    body = removeRelativeImages(body);
    const filename = key.replace(/^notes\//, '');
    const outPath = path.join(OUT_DIR, filename);
    await fs.writeFile(outPath, body, 'utf-8');
    count++;
    if (count % 100 === 0) {
      console.log(`Downloaded ${count}/${keys.length}...`);
    }
  }

  console.log(`Done. Downloaded ${count} markdown files.`);
}

main().catch((e) => {
  console.error('Fatal error:', e?.message ?? e);
  process.exit(1);
});
