// Customer search + 360 profile + history (DESIGN.md §3 find_customer / get_customer_profile / get_visit_history).
import { randomUUID } from 'node:crypto';
import db from '../db/index.js';

const esc = (s) => s.replace(/[%_\\]/g, (c) => `\\${c}`);

const parseCustomer = (row) => (row ? { ...row, tags: JSON.parse(row.tags || '[]') } : null);

/** Search by name, company, or address fragment. Returns top matches with addresses. */
export function search(query, limit = 10) {
  const q = `%${esc(String(query).trim())}%`;
  const rows = db
    .prepare(
      `SELECT DISTINCT c.* FROM customers c
       LEFT JOIN customer_addresses a ON a.customer_id = c.id
       WHERE (c.first_name || ' ' || c.last_name) LIKE ? ESCAPE '\\'
          OR c.company LIKE ? ESCAPE '\\'
          OR a.street LIKE ? ESCAPE '\\'
          OR a.city LIKE ? ESCAPE '\\'
          OR a.zip LIKE ? ESCAPE '\\'
       ORDER BY c.job_count DESC
       LIMIT ?`
    )
    .all(q, q, q, q, q, limit);
  const addrQ = db.prepare(`SELECT * FROM customer_addresses WHERE customer_id = ?`);
  return rows.map((c) => ({ ...parseCustomer(c), addresses: addrQ.all(c.id) }));
}

export function getById(id) {
  return parseCustomer(db.prepare(`SELECT * FROM customers WHERE id = ?`).get(id));
}

/** Update contact info on an existing customer (agent-captured). */
export function updateContact(id, { phone = null, email = null } = {}) {
  const existing = getById(id);
  if (!existing) return null;
  db.prepare(`UPDATE customers SET phone = COALESCE(?, phone), email = COALESCE(?, email) WHERE id = ?`)
    .run(phone, email, id);
  return getById(id);
}

/** Register a NEW customer + their address (agent-created). Returns both ids. */
export function createCustomer({ first_name = null, last_name = null, company = null, kind = 'homeowner', phone = null, email = null, address = {} } = {}) {
  const customerId = `cus_agent_${randomUUID()}`;
  const addressId = `adr_agent_${randomUUID()}`;
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO customers (id, first_name, last_name, company, kind, phone, email, tags, job_count, first_job, last_job)
       VALUES (?, ?, ?, ?, ?, ?, ?, '[]', 0, NULL, NULL)`
    ).run(customerId, first_name, last_name, company, kind === 'business' ? 'business' : 'homeowner', phone, email);
    db.prepare(
      `INSERT INTO customer_addresses (id, customer_id, street, street_line_2, city, state, zip, lat, lng)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`
    ).run(addressId, customerId, address.street ?? null, address.street_line_2 ?? null, address.city ?? null, address.state ?? null, address.zip ?? null);
  });
  tx();
  return { customer_id: customerId, address_id: addressId };
}

/** Customer 360: identity, kind, tags, addresses, job counts, open balance. */
export function getProfile(id) {
  const customer = getById(id);
  if (!customer) return null;
  const addresses = db.prepare(`SELECT * FROM customer_addresses WHERE customer_id = ?`).all(id);
  const balance = db
    .prepare(
      `SELECT COALESCE(SUM(i.due_amount), 0) AS open_balance
       FROM invoices i JOIN jobs j ON j.id = i.job_id
       WHERE j.customer_id = ? AND i.status = 'open'`
    )
    .get(id);
  return { ...customer, addresses, open_balance: balance.open_balance };
}

// Housecall Pro automation drafts ("[AI Auto-Complete …]" letters, "=== AI
// STATUS FLAGS ===" blocks) are office workflow data — never shown to callers
// via visit history or crew schedule notes.
const isAutomationDraftNote = (content) => {
  const s = String(content ?? '').trimStart();
  return s.startsWith('[AI Auto-Complete') || s.includes('=== AI STATUS FLAGS ===');
};

const techQ = db.prepare(
  `SELECT e.id, e.first_name, e.last_name FROM job_assignments ja
   JOIN employees e ON e.id = ja.employee_id WHERE ja.job_id = ?`
);

function jobRow(r, noteLimit) {
  const notes = db
    .prepare(`SELECT id, content, author, created_at FROM job_notes WHERE job_id = ?`)
    .all(r.id)
    .filter((n) => !isAutomationDraftNote(n.content))
    .map((n) => ({
      ...n,
      summary: n.content && n.content.length > 200 ? `${n.content.slice(0, 200)}…` : n.content,
    }))
    .slice(0, noteLimit);
  return {
    id: r.id,
    invoice_number: r.invoice_number,
    description: r.description,
    work_status: r.work_status,
    scheduled_start: r.scheduled_start,
    completed_at: r.completed_at,
    source: r.source,
    address: {
      street: r.street, street_line_2: r.street_line_2,
      city: r.city, state: r.state, zip: r.zip,
    },
    techs: techQ.all(r.id),
    notes,
  };
}

/** Recent visit history, newest scheduled first. */
export function getVisitHistory(id, limit = 10) {
  if (!getById(id)) return null;
  const rows = db
    .prepare(
      `SELECT j.*, a.street, a.street_line_2, a.city, a.state, a.zip
       FROM jobs j LEFT JOIN customer_addresses a ON a.id = j.address_id
       WHERE j.customer_id = ? AND j.scheduled_start <= datetime('now')
       ORDER BY j.scheduled_start DESC NULLS LAST
       LIMIT ?`
    )
    .all(id, limit);
  return rows.map((r) => jobRow(r, 5));
}

/** All invoices for a customer, newest service date first, with line items. */
export function getInvoices(id) {
  if (!getById(id)) return null;
  return db
    .prepare(
      `SELECT i.* FROM invoices i JOIN jobs j ON j.id = i.job_id
       WHERE j.customer_id = ?
       ORDER BY i.service_date DESC NULLS LAST, i.invoice_date DESC NULLS LAST`
    )
    .all(id)
    .map((inv) => ({
      ...inv,
      items: db.prepare(`SELECT * FROM invoice_items WHERE invoice_id = ?`).all(inv.id),
    }));
}

/** Scheduled / in-progress future jobs. */
export function getUpcomingAppointments(id) {
  const now = new Date().toISOString();
  const rows = db
    .prepare(
      `SELECT j.*, a.street, a.street_line_2, a.city, a.state, a.zip
       FROM jobs j LEFT JOIN customer_addresses a ON a.id = j.address_id
       WHERE j.customer_id = ?
         AND j.work_status IN ('scheduled', 'in progress')
         AND j.scheduled_start >= ?
       ORDER BY j.scheduled_start`
    )
    .all(id, now);
  return rows.map((r) => jobRow(r, 3));
}
