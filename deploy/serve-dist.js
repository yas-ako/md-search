import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import 'dotenv/config';
import {
  assertS3Config,
  createS3Client,
  DIST_DIR,
  TAR_FILE,
  downloadDistTar,
  extractTarGz,
  formatError,
  getRemoteDistInfo,
  isSameDistInfo,
  validateTarEntries,
} from './download-dist.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = __dirname; // deployディレクトリがルートになる

const PORT = Number(process.env.PORT || '3000');
function parseRefreshInterval() {
  const raw = process.env.DIST_REFRESH_INTERVAL_MS;
  if (!raw) return 0;

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(value, 60_000);
}

const REFRESH_INTERVAL_MS = parseRefreshInterval();

const s3 = createS3Client();
let currentDistInfo;
let serverProc;
let refreshing = false;
let stoppingServer = false;
let shuttingDown = false;
let refreshTimer;

async function prepareDist() {
  console.log('[dist] Downloading dist from S3...');
  const downloadedDistInfo = await downloadDistTar(TAR_FILE, s3);
  try {
    await extractTarGz(TAR_FILE, DIST_DIR);
  } finally {
    await fs.unlink(TAR_FILE).catch(() => {});
  }
  currentDistInfo = downloadedDistInfo;
  console.log('[dist] dist/ is ready.');
}

function startServer() {
  console.log(`[server] Starting on port ${PORT}...`);
  const serveBin = path.resolve(repoRoot, 'node_modules', '.bin', 'serve');
  serverProc = spawn('node', [serveBin, '-l', String(PORT), DIST_DIR], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  serverProc.on('close', (code) => {
    const expectedStop = stoppingServer || shuttingDown;
    serverProc = undefined;
    stoppingServer = false;
    console.log(`[server] exited with code ${code}`);
    if (!expectedStop) {
      process.exit(code ?? 1);
    }
  });
  serverProc.on('error', (err) => {
    console.error('[server] failed:', formatError(err));
    if (!stoppingServer && !shuttingDown) {
      process.exit(1);
    }
  });
}

async function stopServer() {
  if (!serverProc) return;
  stoppingServer = true;
  await new Promise((resolve) => {
    const proc = serverProc;
    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
    }, 10_000);
    proc.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}

async function refreshDistIfNeeded() {
  if (refreshing || shuttingDown) return;
  refreshing = true;
  let serverStopped = false;
  try {
    const remoteDistInfo = await getRemoteDistInfo(s3);
    if (isSameDistInfo(currentDistInfo, remoteDistInfo)) {
      console.log('[refresh] dist is up to date.');
      return;
    }

    console.log('[refresh] New dist detected. Downloading before restart...');
    const downloadedDistInfo = await downloadDistTar(TAR_FILE, s3);
    await validateTarEntries(TAR_FILE);

    console.log('[refresh] Restarting static server...');
    await stopServer();
    serverStopped = true;
    try {
      await extractTarGz(TAR_FILE, DIST_DIR);
      currentDistInfo = downloadedDistInfo;
    } finally {
      await fs.unlink(TAR_FILE).catch(() => {});
    }
    startServer();
    console.log('[refresh] Updated dist is now being served.');
  } catch (err) {
    console.error('[refresh] Failed:', formatError(err));
    await fs.unlink(TAR_FILE).catch(() => {});
    if (serverStopped && !shuttingDown) {
      console.error('[refresh] Static server was stopped before refresh failed. Exiting.');
      process.exit(1);
    }
  } finally {
    refreshing = false;
  }
}

function startRefreshTimer() {
  if (!REFRESH_INTERVAL_MS || REFRESH_INTERVAL_MS <= 0) {
    console.log('[refresh] Disabled.');
    return;
  }
  console.log(`[refresh] Checking S3 every ${Math.round(REFRESH_INTERVAL_MS / 1000)}s.`);
  refreshTimer = setInterval(() => {
    refreshDistIfNeeded();
  }, REFRESH_INTERVAL_MS);
}

function handleSignals() {
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    if (refreshTimer) clearInterval(refreshTimer);
    await stopServer();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main() {
  assertS3Config();
  handleSignals();
  await prepareDist();
  startServer();
  startRefreshTimer();
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((err) => {
    console.error(formatError(err));
    process.exit(1);
  });
}
