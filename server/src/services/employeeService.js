// Crew line: employee identity, PINs, per-call verification, roster/schedule/
// message reads (DESIGN: crew line MVP — read-only by name, mutations by PIN).
import { createHmac } from 'node:crypto';
import db from '../db/index.js';
import { broadcast } from '../lib/events.js';
import { etToUtc, todayEt, addDays } from '../lib/time.js';

const EXCLUDED_NAMES = new Set(['team phone']); // shared office line, not a person

const fullName = (e) => `${e.first_name ?? ''} ${e.last_name ?? ''}`.trim();

// Housecall Pro automation drafts ("[AI Auto-Complete …]" letters, "=== AI
// STATUS FLAGS ===" blocks) are office workflow data — never read to callers.
const isAutomationDraftNote = (content) => {
  const s = String(content ?? '').trimStart();
  return s.startsWith('[AI Auto-Complete') || s.includes('=== AI STATUS FLAGS ===');
};

// Deterministic 4-digit PIN per employee, derived from a seed. Random PINs
// would silently change on every redeploy (ephemeral DB on Railway) and break
// any PIN the office was told. Seed is overridable via CREW_PIN_SEED.
const PIN_SEED = process.env.CREW_PIN_SEED ?? 'gba-crew-line-v1';
const pinFor = (employeeId) =>
  String(createHmac('sha256', PIN_SEED).update(employeeId).digest().readUInt32BE(0) % 10000).padStart(4, '0');

/** Fill PIN gaps for employees who don't have one yet. Survives reseeds
 *  (INSERT OR IGNORE; employee_auth is not an imported table). Deterministic:
 *  the same employee always gets the same PIN, so a redeploy (ephemeral DB on
 *  Railway) never silently changes the PINs the office knows. */
export function ensureEmployeePins() {
  const ins = db.prepare(`INSERT OR IGNORE INTO employee_auth (employee_id, pin) VALUES (?, ?)`);
  const emps = db.prepare(`SELECT id, first_name, last_name FROM employees`).all();
  for (const e of emps) {
    if (EXCLUDED_NAMES.has(fullName(e).toLowerCase())) continue;
    ins.run(e.id, pinFor(e.id));
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
// Tiny edit-distance for voice-transcription typos (Whisper hears "McGuire"
// as "Maguire" etc.). Only used on tokens of ≥4 chars.
function lev1(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function tokenMatch(qt, et) {
  if (!qt) return true;
  if (et.startsWith(qt) || qt.startsWith(et)) return true;
  return qt.length >= 4 && et.length >= 4 && lev1(qt, et);
}

export function matchEmployee(name) {
  const q = String(name ?? '').trim().toLowerCase();
  if (!q) return [];
  return db
    .prepare(`SELECT id, first_name, last_name, role FROM employees`)
    .all()
    .filter((e) => {
      const full = fullName(e).toLowerCase();
      if (full.includes(q)) return true;
      const qTokens = q.split(/\s+/).filter(Boolean);
      const eTokens = full.split(/\s+/).filter(Boolean);
      // every query token must match some name token (prefix or 1-edit fuzzy)
      return qTokens.every((qt) => eTokens.some((et) => tokenMatch(qt, et)));
    });
}

export function getEmployee(id) {
  return db.prepare(`SELECT id, first_name, last_name, role, job_count FROM employees WHERE id = ?`).get(id) ?? null;
}

export function getPin(employeeId) {
  return db.prepare(`SELECT pin FROM employee_auth WHERE employee_id = ?`).get(employeeId)?.pin ?? null;
}

export function verifyPin(employeeId, pin, callId = null) {
  const row = getPin(employeeId);
  if (row != null && row === String(pin ?? '').trim()) {
    pinFails.delete(employeeId);
    return true;
  }
  // Throttle: 3 wrong PINs on one call lock crew access for the rest of THAT
  // call. A new call starts with a clean slate (no lockout persistence).
  const prev = pinFails.get(employeeId);
  const count = prev && prev.callId === callId ? prev.count : 0;
  pinFails.set(employeeId, { callId, count: count + 1 });
  return false;
}

const pinFails = new Map(); // employeeId → { callId, count } wrong-PIN attempts

const CREW_PIN_MAX_FAILS = 3;

/** Wrong-PIN attempts on the current call (0 when none / a different call). */
export function pinFailCount(employeeId, callId = null) {
  const f = pinFails.get(employeeId);
  return f && f.callId === callId ? f.count : 0;
}

/** True when the caller has burned their PIN tries on this call. */
export function crewLocked(employeeId, callId = null) {
  return pinFailCount(employeeId, callId) >= CREW_PIN_MAX_FAILS;
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
    `SELECT content FROM job_notes WHERE job_id = ? AND content IS NOT NULL ORDER BY created_at DESC NULLS LAST`
  );
  const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  return rows.map((r) => {
    // Latest HUMAN note — skip Housecall Pro automation drafts (AI Auto-Complete
    // letters / AI STATUS FLAGS blocks) so they're never read to a caller.
    const note = noteQ.all(r.id).find((n) => !isAutomationDraftNote(n.content))?.content ?? null;
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

/** Roster for the office UI. PINs are NEVER included here: the platform has no
 *  auth, so the roster is effectively public — a PIN in this payload would hand
 *  out the crew-line credentials to anyone who opens the page. Office staff who
 *  need a PIN use `npm --prefix server run pins` (prints them locally). */
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
      `SELECT e.id, e.first_name, e.last_name, e.role, e.job_count
       FROM employees e
       ORDER BY e.role, e.last_name`
    )
    .all()
    .map((e) => ({
      id: e.id,
      name: fullName(e),
      role: e.role,
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
