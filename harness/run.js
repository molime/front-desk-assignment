// Eval harness orchestrator (DESIGN.md §5 / §7 Stage 5).
//
// For each scenario:
//   1. copy server/data/gulfbreeze.db (+ WAL sidecars) to harness/tmp/scenario-<name>.db
//   2. spawn `node harness/run-one.js <scenarioFile>` with GBA_DB_PATH pointed at the copy
//      (the DB layer opens its DB at import time, so one child process per scenario
//      gives clean module/DB isolation)
//   3. collect the child's JSON result, print the report, aggregate exit codes
//
// Flags:
//   --dry-run          validate scenario files + referenced data only; no OpenAI call
//   --scenario <name>  run a single scenario (name = scenario file basename, e.g. s3-emergency-booking)
// Env:
//   HARNESS_MODEL      chat model (default gpt-4o-mini)
//   HARNESS_FAKE_LLM=1 deterministic fake LLM instead of OpenAI (offline proof of the loop)
//   OPENAI_API_KEY     required unless --dry-run or HARNESS_FAKE_LLM=1
import { readdirSync, copyFileSync, existsSync, mkdirSync, statSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const SRC_DB = path.join(ROOT, 'server', 'data', 'gulfbreeze.db');
const TMP_DIR = path.join(here, 'tmp');
const SCEN_DIR = path.join(here, 'scenarios');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const onlyIdx = args.indexOf('--scenario');
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Snapshot of the source DB to prove we never touch it.
 *  WAL mode: mere READS can rewrite the -shm shared-memory sidecar (copying the
 *  DB at scenario start does this), so -shm is excluded — only the main .db
 *  (sha256 + mtime + size) and the -wal are integrity-checked. */
function snapshotSourceDb() {
  const snap = {};
  for (const suffix of ['', '-wal']) {
    const f = SRC_DB + suffix;
    if (existsSync(f)) {
      const st = statSync(f);
      snap[f] = { size: st.size, mtimeMs: st.mtimeMs, sha: sha256(f) };
    }
  }
  return snap;
}

function copyDbForScenario(name) {
  mkdirSync(TMP_DIR, { recursive: true });
  const dest = path.join(TMP_DIR, `scenario-${name}.db`);
  // Copy main file plus WAL sidecars if present — the source DB runs in WAL mode,
  // so a bare copy of the .db file could miss recent (committed) transactions.
  for (const suffix of ['', '-wal', '-shm']) {
    const src = SRC_DB + suffix;
    if (existsSync(src)) copyFileSync(src, dest + suffix);
    else if (existsSync(dest + suffix)) {
      // stale sidecar from a previous run of this scenario
      rmSync(dest + suffix);
    }
  }
  return dest;
}

function runScenario(file) {
  const name = path.basename(file, '.js');
  const dbPath = copyDbForScenario(name);
  const child = spawnSync(
    process.execPath,
    [path.join(here, 'run-one.js'), path.join(SCEN_DIR, file), ...(dryRun ? ['--validate'] : [])],
    {
      env: {
        ...process.env,
        GBA_DB_PATH: dbPath,
        HARNESS_DRY_RUN: dryRun ? '1' : '',
      },
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    }
  );

  // Child prints human transcript to stderr and one JSON result line to stdout.
  if (child.stderr) process.stderr.write(child.stderr);
  const jsonLine = (child.stdout ?? '').trim().split('\n').filter(Boolean).pop();
  let result;
  try {
    result = JSON.parse(jsonLine);
  } catch {
    result = {
      name,
      pass: false,
      assertions: [{ name: 'scenario ran to completion', pass: false, detail: (child.stdout ?? '').slice(-500) }],
      error: child.error?.message ?? `exit ${child.status}`,
    };
  }
  return { result, exitCode: child.status ?? 1 };
}

// --- discover scenarios -------------------------------------------------------

let files = readdirSync(SCEN_DIR).filter((f) => f.endsWith('.js')).sort();
if (only) {
  files = files.filter((f) => f === `${only}.js` || path.basename(f, '.js') === only);
  if (files.length === 0) {
    console.error(`No scenario matching "${only}". Available:`);
    for (const f of readdirSync(SCEN_DIR).filter((f) => f.endsWith('.js'))) console.error(`  ${path.basename(f, '.js')}`);
    process.exit(2);
  }
}

if (!dryRun && !process.env.HARNESS_FAKE_LLM && !process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is not set. Use --dry-run for offline validation or HARNESS_FAKE_LLM=1 for a stubbed end-to-end run.');
  process.exit(2);
}

const mode = dryRun ? 'DRY-RUN (validation only, no LLM)' : process.env.HARNESS_FAKE_LLM ? `FAKE LLM (${process.env.HARNESS_FAKE_LLM})` : `LLM: ${process.env.HARNESS_MODEL ?? 'gpt-4o-mini'}`;
console.log(`Gulf Breeze Air — eval harness  [${mode}]`);
console.log(`Source DB: ${path.relative(ROOT, SRC_DB)} (read-only; each scenario runs against a fresh copy in harness/tmp/)\n`);

const before = snapshotSourceDb();

const results = [];
for (const f of files) {
  const { result } = runScenario(f);
  results.push(result);
  const mark = result.pass ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${result.name}${result.description ? ` — ${result.description}` : ''}`);
  for (const a of result.assertions ?? []) {
    console.log(`     ${a.pass ? '✓' : '✗'} ${a.name}${a.pass ? '' : a.detail ? ` — ${a.detail}` : ''}`);
  }
  if (result.error) console.log(`     ✗ error: ${result.error}`);
  console.log('');
}

// --- source DB integrity ------------------------------------------------------

const after = snapshotSourceDb();
const touched = Object.keys(before).filter((f) => {
  const b = before[f];
  const a = after[f];
  return !a || a.size !== b.size || a.mtimeMs !== b.mtimeMs || a.sha !== b.sha;
});
const newFiles = Object.keys(after).filter((f) => !before[f]);
const dbUntouched = touched.length === 0 && newFiles.length === 0;
console.log(
  dbUntouched
    ? '✓ source DB untouched (sha256 + mtime verified on gulfbreeze.db and -wal; -shm excluded — reads can rewrite it)'
    : `✗ SOURCE DB MODIFIED: ${[...touched, ...newFiles].join(', ')}`
);

// --- tally --------------------------------------------------------------------

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} scenarios passed${dryRun ? ' (dry-run)' : ''}`);
process.exit(dbUntouched && passed === results.length ? 0 : 1);
