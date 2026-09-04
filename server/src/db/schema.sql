-- Gulf Breeze Air front-desk schema (DESIGN.md §2)
-- All datetimes UTC ISO strings; money in cents (matching source data).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Imported tables (recreated from data/*.jsonl by import.js — read-only source)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS customers (
  id          TEXT PRIMARY KEY,
  first_name  TEXT,
  last_name   TEXT,
  company     TEXT,
  kind        TEXT,
  tags        TEXT NOT NULL DEFAULT '[]',  -- JSON array
  job_count   INTEGER NOT NULL DEFAULT 0,
  first_job   TEXT,
  last_job    TEXT
);

CREATE TABLE IF NOT EXISTS customer_addresses (
  id            TEXT PRIMARY KEY,
  customer_id   TEXT NOT NULL REFERENCES customers(id),
  street        TEXT,
  street_line_2 TEXT,
  city          TEXT,
  state         TEXT,
  zip           TEXT,
  lat           REAL,
  lng           REAL
);
CREATE INDEX IF NOT EXISTS idx_addresses_customer ON customer_addresses(customer_id);
CREATE INDEX IF NOT EXISTS idx_addresses_street ON customer_addresses(street);

CREATE TABLE IF NOT EXISTS employees (
  id         TEXT PRIMARY KEY,
  first_name TEXT,
  last_name  TEXT,
  role       TEXT,
  job_count  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS jobs (
  id                  TEXT PRIMARY KEY,
  invoice_number      TEXT,
  description         TEXT,
  work_status         TEXT,
  on_my_way_at        TEXT,
  started_at          TEXT,
  completed_at        TEXT,
  scheduled_start     TEXT,
  scheduled_end       TEXT,
  time_zone           TEXT,
  arrival_window      INTEGER,             -- minutes
  tags                TEXT NOT NULL DEFAULT '[]',  -- JSON array
  total_amount        INTEGER,
  outstanding_balance INTEGER,
  customer_id         TEXT,
  address_id          TEXT,
  created_at          TEXT,
  updated_at          TEXT,
  source              TEXT NOT NULL DEFAULT 'import'  -- 'import' | 'agent'
);
CREATE INDEX IF NOT EXISTS idx_jobs_customer ON jobs(customer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_scheduled_start ON jobs(scheduled_start);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(work_status);

CREATE TABLE IF NOT EXISTS job_assignments (
  job_id      TEXT NOT NULL REFERENCES jobs(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  PRIMARY KEY (job_id, employee_id)
);
CREATE INDEX IF NOT EXISTS idx_assignments_employee ON job_assignments(employee_id);

CREATE TABLE IF NOT EXISTS job_notes (
  id         TEXT PRIMARY KEY,
  job_id     TEXT NOT NULL REFERENCES jobs(id),
  content    TEXT,
  author     TEXT NOT NULL DEFAULT 'import',  -- 'import' | 'agent' | 'office'
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notes_job ON job_notes(job_id);

CREATE TABLE IF NOT EXISTS invoices (
  id             TEXT PRIMARY KEY,
  job_id         TEXT,
  invoice_number TEXT,
  status         TEXT,
  amount         INTEGER,
  subtotal       INTEGER,
  due_amount     INTEGER,
  paid_at        TEXT,
  sent_at        TEXT,
  service_date   TEXT,
  invoice_date   TEXT
);
CREATE INDEX IF NOT EXISTS idx_invoices_job ON invoices(job_id);

CREATE TABLE IF NOT EXISTS invoice_items (
  id                TEXT PRIMARY KEY,
  invoice_id        TEXT NOT NULL REFERENCES invoices(id),
  name              TEXT,
  type              TEXT,
  unit_price        INTEGER,
  qty_in_hundredths INTEGER,
  amount            INTEGER
);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);

-- ---------------------------------------------------------------------------
-- Platform tables (created once, owned by the agent/platform — never dropped)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS calls (
  id             TEXT PRIMARY KEY,
  call_sid       TEXT,
  from_number    TEXT,
  started_at     TEXT,
  ended_at       TEXT,
  status         TEXT,
  summary        TEXT,
  outcome        TEXT,
  handoff_reason TEXT
);

CREATE TABLE IF NOT EXISTS call_transcripts (
  id         TEXT PRIMARY KEY,
  call_id    TEXT NOT NULL REFERENCES calls(id),
  speaker    TEXT NOT NULL CHECK (speaker IN ('agent', 'caller')),
  text       TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_transcripts_call ON call_transcripts(call_id);

CREATE TABLE IF NOT EXISTS agent_actions (
  id         TEXT PRIMARY KEY,
  call_id    TEXT,
  tool       TEXT NOT NULL,
  args       TEXT,   -- JSON
  result     TEXT,   -- JSON
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_actions_call ON agent_actions(call_id);

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('handoff', 'followup', 'message')),
  title       TEXT,
  detail      TEXT,
  call_id     TEXT,
  job_id      TEXT,
  customer_id TEXT,
  assigned_employee_id TEXT,           -- crew-line messages: NULL = the office
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  created_at  TEXT
);

-- Crew-line PINs (DESIGN: crew line). employee_id deliberately has NO foreign
-- key to employees: the importer DROPs and recreates the imported tables, and
-- a hard FK would make those drops fail (or cascade) — this table must survive
-- reseeds. Seeded lazily by employeeService.ensureEmployeePins().
CREATE TABLE IF NOT EXISTS employee_auth (
  employee_id TEXT PRIMARY KEY,
  pin         TEXT NOT NULL            -- 4 digits
);
