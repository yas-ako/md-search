import fs from 'fs/promises';
import { createReadStream } from 'fs';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import 'dotenv/config';

const S3_ENDPOINT = process.env.S3_ENDPOINT;
const S3_REGION = process.env.S3_REGION || 'auto';
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY;
const S3_SECRET_KEY = process.env.S3_SECRET_KEY;
const S3_BUCKET = process.env.S3_BUCKET;

const DIST_DIR = 'dist';
const TAR_FILE = 'dist.tar.gz';
const S3_KEY = 'build/dist.tar.gz';

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

async function createTarGz() {
  console.log('Creating tar.gz...');
  const { spawn } = await import('child_process');
  
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-czf', TAR_FILE, '-C', DIST_DIR, '.'], {
      stdio: 'inherit',
    });
    tar.on('close', (code) => {
      if (code === 0) resolve(void 0);
      else reject(new Error(`tar exited with code ${code}`));
    });
  });
}

async function uploadToS3(filePath: string) {
  console.log(`Uploading ${filePath} to S3...`);
  const s3 = createS3Client();
  const fileStream = createReadStream(filePath);
  const stats = await fs.stat(filePath);

  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: S3_KEY,
      Body: fileStream,
      ContentType: 'application/gzip',
      ContentLength: stats.size,
    })
  );
  console.log(`Uploaded to s3://${S3_BUCKET}/${S3_KEY}`);
}

async function main() {
  if (!S3_BUCKET || !S3_ENDPOINT || !S3_ACCESS_KEY || !S3_SECRET_KEY) {
    console.error('Error: S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET are required.');
    process.exit(1);
  }

  await createTarGz();
  await uploadToS3(TAR_FILE);
  await fs.unlink(TAR_FILE);
  console.log('Done.');
}

main().catch((e) => {
  console.error('Fatal error:', e?.message ?? e);
  process.exit(1);
});
