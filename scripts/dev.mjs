// One-command dev: runs the backend (:8080) and the Vite dev server (:5173)
// together, and kills both when you Ctrl+C. Used by the root `npm run dev`.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const procs = [
  spawn('node', ['--watch', 'server/src/index.js'], { cwd: root, stdio: 'inherit' }),
  spawn('npm', ['--prefix', 'web', 'run', 'dev'], { cwd: root, stdio: 'inherit', shell: true }),
];

const shutdown = () => {
  for (const p of procs) {
    try { p.kill('SIGTERM'); } catch { /* already gone */ }
  }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
for (const p of procs) p.on('exit', (code) => { if (code && code !== 0) shutdown(); });
