import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const outDir = process.env.BUILD_OUT_DIR || 'dist';

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: 'inherit', cwd: path.resolve(__dirname, '..') });
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

async function main() {
  const pagefindBin = path.resolve(__dirname, '..', 'node_modules', '.bin', 'pagefind');
  console.log(`Running pagefind on ${outDir}...`);
  await run(pagefindBin, ['--site', outDir, '--output-subdir', 'pagefind']);
  console.log('pagefind done.');
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
