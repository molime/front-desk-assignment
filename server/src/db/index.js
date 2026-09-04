import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DB_DIR = path.resolve(here, '..', '..', 'data');
// GBA_DB_PATH lets the eval harness point the whole DB layer at a throwaway
// copy of the database (one child process per scenario). Unset in normal boot.
export const DB_PATH = process.env.GBA_DB_PATH ?? path.join(DB_DIR, 'gulfbreeze.db');

mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = readFileSync(path.join(here, 'schema.sql'), 'utf8');
db.exec(schema);

// --- migrations for DBs created before the crew line --------------------------
// The tasks table predates assigned_employee_id and the 'message' kind. SQLite
// can't ALTER a CHECK constraint, so rebuild the table when either is missing.
{
  const cols = db.prepare(`PRAGMA table_info(tasks)`).all().map((c) => c.name);
  const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`).get()?.sql ?? '';
  if (!cols.includes('assigned_employee_id') || !sql.includes("'message'")) {
    db.transaction(() => {
      db.exec(`DROP TABLE IF EXISTS tasks_new`);
      db.exec(`CREATE TABLE tasks_new (
        id          TEXT PRIMARY KEY,
        kind        TEXT NOT NULL CHECK (kind IN ('handoff', 'followup', 'message')),
        title       TEXT,
        detail      TEXT,
        call_id     TEXT,
        job_id      TEXT,
        customer_id TEXT,
        assigned_employee_id TEXT,
        status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
        created_at  TEXT
      )`);
      const keep = cols.filter((c) => c !== 'assigned_employee_id').join(', ');
      db.exec(`INSERT INTO tasks_new (${keep}) SELECT ${keep} FROM tasks`);
      db.exec(`DROP TABLE tasks`);
      db.exec(`ALTER TABLE tasks_new RENAME TO tasks`);
    })();
  }
}

// customers predates agent-captured contact info.
{
  const cols = db.prepare(`PRAGMA table_info(customers)`).all().map((c) => c.name);
  if (!cols.includes('phone')) db.exec(`ALTER TABLE customers ADD COLUMN phone TEXT`);
  if (!cols.includes('email')) db.exec(`ALTER TABLE customers ADD COLUMN email TEXT`);
}

export default db;
