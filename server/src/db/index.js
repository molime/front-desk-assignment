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

export default db;
