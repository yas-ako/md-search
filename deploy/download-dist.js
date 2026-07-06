import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import { spawn } from 'child_process';
import { pathToFileURL } from 'url';
import { pipeline } from 'stream/promises';
import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import 'dotenv/config';

import path from 'path';
import os from 'os';

const S3_ENDPOINT = process.env.S3_ENDPOINT;
const S3_REGION = process.env.S3_REGION || 'auto';
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY;
const S3_SECRET_KEY = process.env.S3_SECRET_KEY;
const S3_BUCKET = process.env.S3_BUCKET;

export const S3_KEY = 'build/dist.tar.gz';
export const TAR_FILE = path.join(os.tmpdir(), 'dist.tar.gz');
export const DIST_DIR = path.join(os.tmpdir(), 'dist');

export class SafeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SafeError';
  }
}

export function formatError(err) {
  if (err instanceof SafeError) return err.message;

  const name = err?.name || 'Error';
  const status = err?.$metadata?.httpStatusCode;
  return status ? `${name} HTTP ${status}` : name;
}

export function assertS3Config() {
  if (!S3_BUCKET || !S3_ENDPOINT || !S3_ACCESS_KEY || !S3_SECRET_KEY) {
    throw new SafeError('S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET are required.');
  }
}

export function createS3Client() {
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

function toDistInfo(res) {
  return {
    etag: res.ETag ?? '',
    lastModified: res.LastModified ? res.LastModified.toISOString() : '',
    contentLength: res.ContentLength ?? 0,
  };
}

export function isSameDistInfo(a, b) {
  if (!a || !b) return false;
  return (
    a.etag === b.etag &&
    a.lastModified === b.lastModified &&
    a.contentLength === b.contentLength
  );
}

export async function getRemoteDistInfo(client = createS3Client()) {
  const res = await client.send(
    new HeadObjectCommand({
      Bucket: S3_BUCKET,
      Key: S3_KEY,
    })
  );
  return toDistInfo(res);
}

export async function downloadDistTar(filePath = TAR_FILE, client = createS3Client()) {
  console.log(`Downloading ${S3_KEY}...`);
  try {
    const res = await client.send(
      new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: S3_KEY,
      })
    );
    if (!res.Body) {
      throw new SafeError('Downloaded object has no body.');
    }

    await pipeline(res.Body, createWriteStream(filePath));
    console.log('Download completed.');
    return toDistInfo(res);
  } catch (err) {
    await fs.unlink(filePath).catch(() => {});
    throw err;
  }
}

function runTar(args) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const tar = spawn('tar', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    tar.stdout.on('data', (chunk) => chunks.push(chunk));
    tar.stderr.resume();
    tar.on('error', reject);
    tar.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks).toString('utf-8'));
      } else {
        reject(new SafeError(`tar exited with code ${code}`));
      }
    });
  });
}

function isSafeTarPath(entryPath) {
  if (!entryPath) return false;
  if (entryPath === '.' || entryPath === './') return true;
  if (entryPath.startsWith('/')) return false;
  if (entryPath.includes('\\')) return false;
  if (/^[A-Za-z]:/.test(entryPath)) return false;
  if (/[\x00-\x1F\x7F]/.test(entryPath)) return false;

  const parts = entryPath.split('/');
  if (parts.includes('..')) return false;

  const normalized = path.posix.normalize(entryPath.replace(/^\.\/+/, ''));
  if (normalized === '.' || normalized.startsWith('../')) return false;
  return true;
}

export async function validateTarEntries(tarFile = TAR_FILE) {
  const output = await runTar(['-tzvf', tarFile]);
  const entries = output.split('\n').filter((line) => line.length > 0);
  if (entries.length === 0) {
    throw new SafeError('dist archive has no entries.');
  }

  for (const line of entries) {
    const type = line[0];
    if (type !== '-' && type !== 'd') {
      throw new SafeError('dist archive contains unsupported entry type.');
    }

    const entryPath = line.replace(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+/, '');
    if (!isSafeTarPath(entryPath)) {
      throw new SafeError('dist archive contains unsafe entry path.');
    }
  }
}

export async function extractTarGz(tarFile = TAR_FILE, distDir = DIST_DIR) {
  console.log('Validating dist archive...');
  await validateTarEntries(tarFile);
  console.log('Extracting dist archive...');

  try {
    await fs.rm(distDir, { recursive: true, force: true });
    await fs.mkdir(distDir, { recursive: true });
  } catch (err) {
    console.error('Failed to prepare dist dir.');
    throw err;
  }

  return new Promise((resolve, reject) => {
    const tar = spawn('tar', [
      '--extract',
      '--gzip',
      '--file',
      tarFile,
      '--directory',
      distDir,
      '--no-same-owner',
      '--no-same-permissions',
    ], {
      stdio: 'inherit',
    });
    tar.on('error', reject);
    tar.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new SafeError(`tar exited with code ${code}`));
    });
  });
}

export async function downloadAndExtractDist(client = createS3Client()) {
  await downloadDistTar(TAR_FILE, client);
  try {
    await extractTarGz(TAR_FILE, DIST_DIR);
  } finally {
    await fs.unlink(TAR_FILE).catch(() => {});
  }
  console.log('Done. dist/ is ready.');
}

async function main() {
  assertS3Config();
  const client = createS3Client();
  await downloadAndExtractDist(client);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((e) => {
    console.error('Fatal error:', formatError(e));
    process.exit(1);
  });
}
