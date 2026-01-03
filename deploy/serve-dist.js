import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = __dirname; // deployディレクトリがルートになる

const PORT = Number(process.env.PORT || '3000');
const DIST_DIR = path.join(repoRoot, 'dist');

async function downloadDist() {
  console.log('[init] Downloading dist from S3...');
  const { spawn: spawnNode } = await import('child_process');
  return new Promise((resolve, reject) => {
    const proc = spawnNode('node', ['download-dist.js'], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: process.env,
    });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`download-dist exited with code ${code}`));
    });
  });
}

function startServer() {
  console.log(`[server] Starting on port ${PORT}...`);
  const serveBin = path.resolve(repoRoot, 'node_modules', '.bin', 'serve');
  const proc = spawn('node', [serveBin, '-l', String(PORT), DIST_DIR], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  proc.on('close', (code) => {
    console.log(`[server] exited with code ${code}`);
    process.exit(code ?? 1);
  });
}

function handleSignals() {
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

async function main() {
  handleSignals();
  await downloadDist();
  startServer();
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
