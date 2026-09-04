// JSONL → SQLite importer. Idempotent: drops and recreates the *imported*
// tables, then re-reads every record. data/ is READ-ONLY; we never write there.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import db from './index.js';
import { ensureEmployeePins } from '../services/employeeService.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(here, '..', '..', '..', 'data');

function readJsonl(name) {
  return readFileSync(path.join(DATA_DIR, name), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

const IMPORTED_TABLES = [
  'invoice_items',
  'invoices',
  'job_notes',
  'job_assignments',
  'jobs',
  'customer_addresses',
  'customers',
  'employees',
];

/** Rebuild all imported tables from data/*.jsonl. Returns row counts per table. */
export function runImport() {
  const run = db.transaction(() => {
  for (const t of IMPORTED_TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
  const schema = readFileSync(path.join(here, 'schema.sql'), 'utf8');
  db.exec(schema);

  // --- employees ------------------------------------------------------------
  const insEmployee = db.prepare(
    `INSERT INTO employees (id, first_name, last_name, role, job_count) VALUES (?, ?, ?, ?, ?)`
  );
  for (const e of readJsonl('employees.jsonl')) {
    insEmployee.run(e.id, e.first_name ?? null, e.last_name ?? null, e.role ?? null, e.jobs ?? 0);
  }

  // --- customers + addresses -------------------------------------------------
  const insCustomer = db.prepare(
    `INSERT INTO customers (id, first_name, last_name, company, kind, tags, job_count, first_job, last_job)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insAddress = db.prepare(
    `INSERT OR IGNORE INTO customer_addresses (id, customer_id, street, street_line_2, city, state, zip, lat, lng)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const seenAddresses = new Set();
  const addAddress = (customerId, a, fallbackId) => {
    const id = a.id ?? fallbackId;
    if (!id || seenAddresses.has(id)) return;
    seenAddresses.add(id);
    insAddress.run(
      id, customerId, a.street ?? null, a.street_line_2 ?? null,
      a.city ?? null, a.state ?? null, a.zip ?? null,
      a.latitude ?? null, a.longitude ?? null
    );
    return id;
  };

  for (const c of readJsonl('customers.jsonl')) {
    insCustomer.run(
      c.id, c.first_name ?? null, c.last_name ?? null, c.company ?? null,
      c.kind ?? null, JSON.stringify(c.tags ?? []), c.job_count ?? 0,
      c.first_job ?? null, c.last_job ?? null
    );
    for (const a of c.addresses ?? []) addAddress(c.id, a);
  }

  // --- jobs + assignments + notes -------------------------------------------
  const insJob = db.prepare(
    `INSERT INTO jobs (id, invoice_number, description, work_status, on_my_way_at, started_at, completed_at,
       scheduled_start, scheduled_end, time_zone, arrival_window, tags, total_amount, outstanding_balance,
       customer_id, address_id, created_at, updated_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import')`
  );
  const insAssignment = db.prepare(
    `INSERT OR IGNORE INTO job_assignments (job_id, employee_id) VALUES (?, ?)`
  );
  const insNote = db.prepare(
    `INSERT OR IGNORE INTO job_notes (id, job_id, content, author, created_at) VALUES (?, ?, ?, 'import', NULL)`
  );

  let noteCount = 0;
  for (const j of readJsonl('jobs.jsonl')) {
    // 4 jobs have address.id null in the source — give them a stable synthetic id
    let addressId = null;
    if (j.address) {
      addressId = j.address.id ?? `adr_syn_${j.id}`;
      if (j.customer?.id) addAddress(j.customer.id, j.address, addressId);
    }
    insJob.run(
      j.id, j.invoice_number ?? null, j.description ?? null, j.work_status ?? null,
      j.work_timestamps?.on_my_way_at ?? null, j.work_timestamps?.started_at ?? null,
      j.work_timestamps?.completed_at ?? null,
      j.schedule?.scheduled_start ?? null, j.schedule?.scheduled_end ?? null,
      j.schedule?.time_zone ?? null, j.schedule?.arrival_window ?? null,
      JSON.stringify(j.tags ?? []), j.total_amount ?? null, j.outstanding_balance ?? null,
      j.customer?.id ?? null, addressId, j.created_at ?? null, j.updated_at ?? null
    );
    for (const emp of j.assigned_employees ?? []) {
      if (emp?.id) insAssignment.run(j.id, emp.id);
    }
    for (const n of j.notes ?? []) {
      if (n?.id) {
        insNote.run(n.id, j.id, n.content ?? null);
        noteCount++;
      }
    }
  }

  // --- invoices + items ------------------------------------------------------
  const insInvoice = db.prepare(
    `INSERT INTO invoices (id, job_id, invoice_number, status, amount, subtotal, due_amount, paid_at, sent_at, service_date, invoice_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insItem = db.prepare(
    `INSERT INTO invoice_items (id, invoice_id, name, type, unit_price, qty_in_hundredths, amount)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  let itemCount = 0;
  for (const inv of readJsonl('invoices.jsonl')) {
    insInvoice.run(
      inv.id, inv.job_id ?? null, inv.invoice_number ?? null, inv.status ?? null,
      inv.amount ?? null, inv.subtotal ?? null, inv.due_amount ?? null,
      inv.paid_at ?? null, inv.sent_at ?? null, inv.service_date ?? null, inv.invoice_date ?? null
    );
    for (const it of inv.items ?? []) {
      insItem.run(it.id ?? null, inv.id, it.name ?? null, it.type ?? null,
        it.unit_price ?? null, it.qty_in_hundredths ?? null, it.amount ?? null);
      itemCount++;
    }
  }

  return { noteCount, itemCount };
  });

  const { noteCount, itemCount } = run();

  // Crew-line PINs survive reseeds: only fills gaps for employees missing one.
  ensureEmployeePins();

  const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  const counts = {};
  for (const t of ['customers', 'customer_addresses', 'employees', 'jobs', 'job_assignments', 'job_notes', 'invoices', 'invoice_items']) {
    counts[t] = count(t);
  }
  return { counts, noteCount, itemCount };
}

// Script mode (`npm run seed`): run the import and print the row counts.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { counts, noteCount, itemCount } = runImport();
  console.log('Import complete:');
  for (const [t, n] of Object.entries(counts)) console.log(`  ${t.padEnd(20)} ${n}`);
  console.log(`  (parsed from JSONL: ${noteCount} notes, ${itemCount} invoice items)`);
}
