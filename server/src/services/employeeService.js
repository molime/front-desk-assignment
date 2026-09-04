// Crew line: employee identity, PINs, per-call verification, roster/schedule/
// message reads (DESIGN: crew line MVP — read-only by name, mutations by PIN).
import { randomInt } from 'node:crypto';
import db from '../db/index.js';
import { broadcast } from '../lib/events.js';
import { etToUtc, todayEt, addDays } from '../lib/time.js';

const EXCLUDED_NAMES = new Set(['team phone']); // shared office line, not a person

const fullName = (e) => `${e.first_name ?? ''} ${e.last_name ?? ''}`.trim();

const genPin = () => String(randomInt(0, 10000)).padStart(4, '0');

/** Fill PIN gaps for employees who don't have one yet. Survives reseeds
 * (INSERT OR IGNORE; employee_auth is not an imported table). */
export function ensureEmployeePins() {
  const ins = db.prepare(`INSERT OR IGNORE INTO employee_auth (employee_id, pin) VALUES (?, ?)`);
  const emps = db.prepare(`SELECT id, first_name, last_name FROM employees`).all();
  for (const e of emps) {
    if (EXCLUDED_NAMES.has(fullName(e).toLowerCase())) continue;
    ins.run(e.id, genPin());
  }
}

// --- per-call verification state (single process, in-memory) -------------------

const callAuth = new Map(); // callId → { employeeId, scope: 'read'|'full' }

export function getCallAuth(callId) {
  return callId ? callAuth.get(callId) ?? null : null;
}
export function setCallAuth(callId, auth) {
  if (callId) callAuth.set(callId, auth);
}
export function clearCallAuth(callId) {
  callAuth.delete(callId);
}

// --- matching + PIN -------------------------------------------------------------

/** Fuzzy employee match: case-insensitive substring over the full name. */
export function matchEmployee(name) {
  const q = String(name ?? '').trim().toLowerCase();
  if (!q) return [];
  return db
    .prepare(`SELECT id, first_name, last_name, role FROM employees`)
    .all()
    .filter((e) => {
      const full = fullName(e).toLowerCase();
      return full.includes(q) || q.split(/\s+/).every((p) => full.includes(p));
    });
}

export function getEmployee(id) {
  return db.prepare(`SELECT id, first_name, last_name, role, job_count FROM employees WHERE id = ?`).get(id) ?? null;
}

export function getPin(employeeId) {
  return db.prepare(`SELECT pin FROM employee_auth WHERE employee_id = ?`).get(employeeId)?.pin ?? null;
}

export function verifyPin(employeeId, pin) {
  const row = getPin(employeeId);
  return row != null && row === String(pin ?? '').trim();
}

// --- reads for tools + REST -------------------------------------------------------

const ACTIVE = ['scheduled', 'in progress'];

/** One ET day's active jobs for an employee, ordered by start, voice-friendly. */
export function scheduleFor(employeeId, dateEt) {
  const startUtc = etToUtc(dateEt, 0);
  const endUtc = etToUtc(addDays(dateEt, 1), 0);
  const rows = db
    .prepare(
      `SELECT j.id, j.description, j.work_status, j.scheduled_start, j.scheduled_end,
              a.street, a.street_line_2, a.city, a.state, a.zip
       FROM job_assignments ja
       JOIN jobs j ON j.id = ja.job_id
       LEFT JOIN customer_addresses a ON a.id = j.address_id
       WHERE ja.employee_id = ?
         AND j.work_status IN ('scheduled', 'in progress')
         AND j.scheduled_start >= ? AND j.scheduled_start < ?
       ORDER BY j.scheduled_start`
    )
    .all(employeeId, startUtc, endUtc);
  const noteQ = db.prepare(
    `SELECT content FROM job_notes WHERE job_id = ? AND content IS NOT NULL ORDER BY created_at DESC NULLS LAST LIMIT 1`
  );
  const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  return rows.map((r) => {
    const note = noteQ.get(r.id)?.content ?? null;
    return {
      job_id: r.id,
      window: `${timeFmt.format(new Date(r.scheduled_start))} – ${timeFmt.format(new Date(r.scheduled_end))}`,
      address: [r.street, r.street_line_2, r.city, r.state, r.zip].filter(Boolean).join(', ') || null,
      description: r.description,
      status: r.work_status,
      latest_note: note ? String(note).split('\n')[0].slice(0, 100) : null,
    };
  });
}

/** Roster for the office UI: includes PINs (internal tool, no auth — known tradeoff). */
export function roster() {
  ensureEmployeePins();
  const today = todayEt();
  const startUtc = etToUtc(today, 0);
  const endUtc = etToUtc(addDays(today, 1), 0);
  const todayQ = db.prepare(
    `SELECT COUNT(*) AS n FROM job_assignments ja JOIN jobs j ON j.id = ja.job_id
     WHERE ja.employee_id = ? AND j.work_status IN ('scheduled','in progress')
       AND j.scheduled_start >= ? AND j.scheduled_start < ?`
  );
  return db
    .prepare(
      `SELECT e.id, e.first_name, e.last_name, e.role, e.job_count, ea.pin
       FROM employees e LEFT JOIN employee_auth ea ON ea.employee_id = e.id
       ORDER BY e.role, e.last_name`
    )
    .all()
    .map((e) => ({
      id: e.id,
      name: fullName(e),
      role: e.role,
      pin: e.pin ?? null,
      job_count: e.job_count,
      jobs_today: todayQ.get(e.id, startUtc, endUtc).n,
    }));
}

/** Messages addressed to one employee (crew-line leave_message tasks). */
export function messagesFor(employeeId) {
  return db
    .prepare(
      `SELECT * FROM tasks WHERE assigned_employee_id = ? AND kind = 'message' ORDER BY created_at DESC LIMIT 100`
    )
    .all(employeeId);
}

/** Mark a job complete by the verified tech. Broadcasts job.updated. */
export function completeJobAs(jobId, employeeId) {
  const job = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(jobId);
  if (!job) return { error: 'job not found' };
  const assigned = db
    .prepare(`SELECT 1 FROM job_assignments WHERE job_id = ? AND employee_id = ?`)
    .get(jobId, employeeId);
  if (!assigned) return { error: 'that job is not assigned to you' };
  if (job.work_status?.includes('complete')) return { error: 'job is already complete' };
  if (job.work_status?.includes('canceled')) return { error: 'job is canceled' };
  const now = new Date().toISOString();
  db.prepare(`UPDATE jobs SET work_status = 'complete unrated', completed_at = ?, updated_at = ? WHERE id = ?`).run(now, now, jobId);
  const detail = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(jobId);
  broadcast('job.updated', { job: { id: jobId, work_status: detail.work_status, completed_at: now }, change: 'completed' });
  return { completed: true, job_id: jobId, status: detail.work_status };
}

export { fullName };
