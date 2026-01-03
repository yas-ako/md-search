import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import 'dotenv/config';

const S3_ENDPOINT = process.env.S3_ENDPOINT;
const S3_REGION = process.env.S3_REGION || 'auto';
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY;
const S3_SECRET_KEY = process.env.S3_SECRET_KEY;
const S3_BUCKET = process.env.S3_BUCKET;

const S3_KEY = 'build/dist.tar.gz';
const TAR_FILE = 'dist.tar.gz';
const DIST_DIR = 'dist';

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

async function downloadFromS3(filePath) {
  console.log(`Downloading s3://${S3_BUCKET}/${S3_KEY}...`);
  const s3 = createS3Client();
  const res = await s3.send(
    new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: S3_KEY,
    })
  );

  const writeStream = createWriteStream(filePath);
  await new Promise((resolve, reject) => {
    res.Body.pipe(writeStream);
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });
  console.log(`Downloaded to ${filePath}`);
}

async function extractTarGz() {
  console.log('Extracting tar.gz...');
  const { spawn } = await import('child_process');

  await fs.rm(DIST_DIR, { recursive: true, force: true });
  await fs.mkdir(DIST_DIR, { recursive: true });

  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-xzf', TAR_FILE, '-C', DIST_DIR], {
      stdio: 'inherit',
    });
    tar.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited with code ${code}`));
    });
  });
}

async function main() {
  if (!S3_BUCKET || !S3_ENDPOINT || !S3_ACCESS_KEY || !S3_SECRET_KEY) {
    console.error('Error: S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET are required.');
    process.exit(1);
  }

  await downloadFromS3(TAR_FILE);
  await extractTarGz();
  await fs.unlink(TAR_FILE);
  console.log('Done. dist/ is ready.');
}

main().catch((e) => {
  console.error('Fatal error:', e?.message ?? e);
  process.exit(1);
});
