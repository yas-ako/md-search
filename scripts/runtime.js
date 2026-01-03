import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT || process.env.SERVE_PORT || '3000');
const BUILD_INTERVAL_MS = Number(process.env.BUILD_INTERVAL_MS || `${60 * 60 * 1000}`); // 1h default
const OUT_DIR = path.join(repoRoot, 'dist');
const NEXT_DIR = path.join(repoRoot, 'dist.next');

let building = false;
let queued = false;
let serverProc = null;

function run(cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

async function clean(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

async function swapDist() {
  await clean(OUT_DIR);
  await fs.rename(NEXT_DIR, OUT_DIR);
}

async function buildOnce(reason) {
  if (building) {
    queued = true;
    return;
  }
  building = true;
  console.log(`[build] start (${reason})`);
  try {
    await run('npm', ['run', 'pull-notes']);
    await clean(NEXT_DIR);
    const buildEnv = { BUILD_OUT_DIR: NEXT_DIR };
    await run('npm', ['run', 'build', '--', '--outDir', NEXT_DIR], buildEnv);
    await swapDist();
    console.log('[build] success');
  } catch (err) {
    console.error('[build] failed', err?.message || err);
  } finally {
    building = false;
    if (queued) {
      queued = false;
      void buildOnce('queued');
    }
  }
}

function startServer() {
  const serveBin = path.resolve(repoRoot, 'node_modules', '.bin', 'serve');
  serverProc = spawn('node', [serveBin, '-l', String(PORT), OUT_DIR], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  serverProc.on('close', (code) => {
    console.log(`[server] exited with code ${code}`);
    process.exit(code ?? 1);
  });
}

function handleSignals() {
  const shutdown = () => {
    if (serverProc) {
      serverProc.kill('SIGTERM');
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main() {
  handleSignals();
  await buildOnce('boot');
  if (!serverProc) startServer();
  if (BUILD_INTERVAL_MS > 0) {
    setInterval(() => buildOnce('interval'), BUILD_INTERVAL_MS).unref();
    console.log(`[loop] build interval: ${BUILD_INTERVAL_MS / 1000}s`);
  }
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
