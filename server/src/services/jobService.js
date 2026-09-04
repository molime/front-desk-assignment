// Job detail + mutations: book / reschedule / cancel / note (DESIGN.md §3 tools).
import { randomUUID } from 'node:crypto';
import db from '../db/index.js';
import { broadcast } from '../lib/events.js';
import { etToUtc, isValidDateStr } from '../lib/time.js';
import * as schedule from './scheduleService.js';

function notFound(msg = 'job not found') {
  const err = new Error(msg);
  err.statusCode = 404;
  return err;
}
function badRequest(msg) {
  const err = new Error(msg);
  err.statusCode = 400;
  return err;
}

/** Full job detail: tags, customer, address, assigned techs, notes, invoices + items. */
export function getJobDetail(id) {
  const job = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id);
  if (!job) return null;
  const customer = job.customer_id
    ? db.prepare(`SELECT id, first_name, last_name, company, kind FROM customers WHERE id = ?`).get(job.customer_id)
    : null;
  const address = job.address_id
    ? db.prepare(`SELECT * FROM customer_addresses WHERE id = ?`).get(job.address_id)
    : null;
  const techs = db
    .prepare(
      `SELECT e.id, e.first_name, e.last_name, e.role FROM job_assignments ja
       JOIN employees e ON e.id = ja.employee_id WHERE ja.job_id = ?`
    )
    .all(id);
  const notes = db
    .prepare(`SELECT id, content, author, created_at FROM job_notes WHERE job_id = ?`)
    .all(id);
  const invoices = db
    .prepare(`SELECT * FROM invoices WHERE job_id = ?`)
    .all(id)
    .map((inv) => ({
      ...inv,
      items: db.prepare(`SELECT * FROM invoice_items WHERE invoice_id = ?`).all(inv.id),
    }));
  return { ...job, tags: JSON.parse(job.tags || '[]'), customer, address, techs, notes, invoices };
}

/** Add an office-visible note; author 'agent' | 'office'. Broadcasts note.added. */
export function addNote(jobId, content, author = 'agent') {
  const job = db.prepare(`SELECT id FROM jobs WHERE id = ?`).get(jobId);
  if (!job) throw notFound();
  if (!content || !String(content).trim()) throw badRequest('note content is required');
  const note = {
    id: `nte_${author === 'agent' ? 'agent_' : ''}${randomUUID()}`,
    job_id: jobId,
    content: String(content).trim(),
    author,
    created_at: new Date().toISOString(),
  };
  db.prepare(`INSERT INTO job_notes (id, job_id, content, author, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    note.id, note.job_id, note.content, note.author, note.created_at
  );
  broadcast('note.added', { job_id: jobId, note });
  return note;
}

function validateSlot(date, windowLabel) {
  if (!isValidDateStr(date)) throw badRequest('date must be YYYY-MM-DD');
  const w = schedule.getWindow(windowLabel);
  if (!w) throw badRequest(`window must be one of ${schedule.ARRIVAL_WINDOWS.map((x) => x.label).join(', ')}`);
  const avail = schedule.getAvailability(date, windowLabel);
  if (avail.closed) throw badRequest(avail.reason ?? 'closed that day');
  const slot = avail.windows[0];
  if (!slot || !slot.open) throw badRequest(`no capacity in window ${windowLabel} on ${date}`);
  return { w, slot };
}

/**
 * Book a new job (agent). id job_agent_<uuid>, work_status 'scheduled', source 'agent'.
 * Picks the best-fit tech with capacity, broadcasts job.created.
 */
export function createJob({ customer_id, address_id, date, window, description, notes }) {
  if (!customer_id) throw badRequest('customer_id is required');
  const customer = db.prepare(`SELECT id FROM customers WHERE id = ?`).get(customer_id);
  if (!customer) throw notFound('customer not found');
  if (address_id) {
    const addr = db.prepare(`SELECT id FROM customer_addresses WHERE id = ? AND customer_id = ?`).get(address_id, customer_id);
    if (!addr) throw badRequest('address_id does not belong to this customer');
  }
  const { w } = validateSlot(date, window);
  const tech = schedule.pickTech(date, window);
  if (!tech) throw badRequest('no tech available in that window');

  const id = `job_agent_${randomUUID()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO jobs (id, invoice_number, description, work_status, scheduled_start, scheduled_end,
       time_zone, arrival_window, tags, total_amount, outstanding_balance, customer_id, address_id,
       created_at, updated_at, source)
     VALUES (?, NULL, ?, 'scheduled', ?, ?, 'America/New_York', ?, '[]', 0, 0, ?, ?, ?, ?, 'agent')`
  ).run(
    id, description ?? null,
    etToUtc(date, w.startHour), etToUtc(date, w.endHour),
    (w.endHour - w.startHour) * 60,
    customer_id, address_id ?? null, now, now
  );
  db.prepare(`INSERT INTO job_assignments (job_id, employee_id) VALUES (?, ?)`).run(id, tech.id);
  if (notes) addNote(id, notes, 'agent');

  const detail = getJobDetail(id);
  broadcast('job.created', { job: detail });
  return detail;
}

/** Move a job to a new date/window. Keeps current techs who are free; reassigns the rest. */
export function rescheduleJob(jobId, { date, window }) {
  const job = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(jobId);
  if (!job) throw notFound();
  if (['complete rated', 'complete unrated'].includes(job.work_status)) throw badRequest('cannot reschedule a completed job');
  if (job.work_status.includes('canceled')) throw badRequest('cannot reschedule a canceled job');
  const { w } = validateSlot(date, window);

  const currentTechs = db.prepare(`SELECT employee_id FROM job_assignments WHERE job_id = ?`).all(jobId).map((r) => r.employee_id);
  const startUtc = etToUtc(date, w.startHour);
  const endUtc = etToUtc(date, w.endHour);
  const keep = currentTechs.filter((tid) => schedule.techLoad(tid, startUtc, endUtc) < 2);
  const finalTechs = [...keep];
  if (finalTechs.length === 0) {
    const tech = schedule.pickTech(date, window);
    if (!tech) throw badRequest('no tech available in that window');
    finalTechs.push(tech.id);
  }

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE jobs SET scheduled_start = ?, scheduled_end = ?, arrival_window = ?, time_zone = 'America/New_York', updated_at = ?
       WHERE id = ?`
    ).run(startUtc, endUtc, (w.endHour - w.startHour) * 60, now, jobId);
    db.prepare(`DELETE FROM job_assignments WHERE job_id = ?`).run(jobId);
    const ins = db.prepare(`INSERT INTO job_assignments (job_id, employee_id) VALUES (?, ?)`);
    for (const tid of finalTechs) ins.run(jobId, tid);
  });
  tx();

  const detail = getJobDetail(jobId);
  broadcast('job.updated', { job: detail, change: 'rescheduled', date, window });
  return detail;
}

/** Cancel a job with an agent note recording the reason. */
export function cancelJob(jobId, { reason }) {
  const job = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(jobId);
  if (!job) throw notFound();
  if (job.work_status.includes('canceled')) throw badRequest('job is already canceled');
  const now = new Date().toISOString();
  db.prepare(`UPDATE jobs SET work_status = 'canceled', updated_at = ? WHERE id = ?`).run(now, jobId);
  addNote(jobId, `Canceled by agent${reason ? `: ${reason}` : ''}`, 'agent');

  const detail = getJobDetail(jobId);
  broadcast('job.updated', { job: detail, change: 'canceled', reason: reason ?? null });
  return detail;
}
