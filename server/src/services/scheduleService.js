// Schedule + availability engine (DESIGN.md §3 check_availability, §7 Stage 1).
// Windows in ET: 8–10, 10–12, 13–15, 15–17; Mon–Sat; capacity 2 jobs per tech per window.
import db from '../db/index.js';
import { etToUtc, utcToEtDate, etDayOfWeek, todayEt, addDays, isValidDateStr } from '../lib/time.js';

export const ARRIVAL_WINDOWS = [
  { label: '8-10', startHour: 8, endHour: 10 },
  { label: '10-12', startHour: 10, endHour: 12 },
  { label: '13-15', startHour: 13, endHour: 15 },
  { label: '15-17', startHour: 15, endHour: 17 },
];

const CAPACITY_PER_TECH_PER_WINDOW = 2;
const ACTIVE_STATUSES = ['scheduled', 'in progress'];
// Don't offer a window starting sooner than this — the crew can't teleport and
// the office needs lead time to dispatch. Today's already-started windows are
// closed no matter what.
const SAME_DAY_CUTOFF_HOUR = 14; // ET hour after which same-day booking is off

export function getWindow(label) {
  return ARRIVAL_WINDOWS.find((w) => w.label === label) ?? null;
}

/** Bookable techs: role 'field tech'. Excludes admins, office staff, 'Team Phone'. */
export function listTechs() {
  return db
    .prepare(`SELECT id, first_name, last_name, role FROM employees WHERE role = 'field tech' ORDER BY first_name`)
    .all();
}

function countStmt() {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM job_assignments ja
     JOIN jobs j ON j.id = ja.job_id
     WHERE ja.employee_id = ?
       AND j.work_status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})
       AND j.scheduled_start >= ? AND j.scheduled_start < ?`
  );
}

/** Active jobs for one tech in a UTC interval. */
export function techLoad(employeeId, winStartUtc, winEndUtc) {
  return countStmt().get(employeeId, ...ACTIVE_STATUSES, winStartUtc, winEndUtc).n;
}

/**
 * Availability for one ET date. Returns { date, closed?, windows: [...] }.
 * Each window: label, ET start/end, UTC bounds, open, slots free, available techs.
 * Windows already in the past are never open: on TODAY's date a window is only
 * offered if it starts strictly in the future AND after the same-day cutoff —
 * no dispatching a tech to a window that's half over (or already gone).
 */
export function getAvailability(dateStr, windowPref = null) {
  if (!isValidDateStr(dateStr)) {
    const err = new Error('date must be YYYY-MM-DD');
    err.statusCode = 400;
    throw err;
  }
  const dow = etDayOfWeek(dateStr);
  if (dow === 0) {
    return { date: dateStr, closed: true, reason: 'closed Sundays (business hours Mon–Sat)', windows: [] };
  }
  const techs = listTechs();
  const loadQ = countStmt();

  // ET "now" as {date, hour, minute} for past-window detection.
  const now = new Date();
  const nowParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(now).reduce((acc, p) => { if (p.type !== 'literal') acc[p.type] = Number(p.value); return acc; }, {});
  const nowEtDate = `${nowParts.year}-${String(nowParts.month).padStart(2, '0')}-${String(nowParts.day).padStart(2, '0')}`;
  const isToday = dateStr === nowEtDate;
  const isPastDate = dateStr < nowEtDate;

  let windows = ARRIVAL_WINDOWS.map((w) => {
    const startUtc = etToUtc(dateStr, w.startHour);
    const endUtc = etToUtc(dateStr, w.endHour);
    // Past-window logic (today only): closed if the window has already started,
    // or if it starts before the same-day cutoff hour.
    let past = false;
    let pastReason = null;
    if (isPastDate) {
      past = true;
      pastReason = 'that day is already past';
    } else if (isToday) {
      const nowMin = nowParts.hour * 60 + nowParts.minute;
      const startMin = w.startHour * 60;
      if (startMin <= nowMin) {
        past = true;
        pastReason = 'that window has already started today';
      } else if (nowMin > SAME_DAY_CUTOFF_HOUR * 60 && startMin <= SAME_DAY_CUTOFF_HOUR * 60) {
        past = true;
        pastReason = `too late in the day to dispatch a same-day visit (cutoff ${SAME_DAY_CUTOFF_HOUR}:00 ET)`;
      }
    }
    const techLoads = techs.map((t) => ({
      id: t.id,
      name: `${t.first_name} ${t.last_name}`.trim(),
      jobs: loadQ.get(t.id, ...ACTIVE_STATUSES, startUtc, endUtc).n,
    }));
    const available = techLoads.filter((t) => t.jobs < CAPACITY_PER_TECH_PER_WINDOW);
    const slots = available.reduce((s, t) => s + (CAPACITY_PER_TECH_PER_WINDOW - t.jobs), 0);
    return {
      label: w.label,
      start_local: `${dateStr}T${String(w.startHour).padStart(2, '0')}:00:00-ET`,
      end_local: `${dateStr}T${String(w.endHour).padStart(2, '0')}:00:00-ET`,
      start_utc: startUtc,
      end_utc: endUtc,
      past,
      past_reason: pastReason,
      open: !past && slots > 0,
      slots,
      capacity: techs.length * CAPACITY_PER_TECH_PER_WINDOW,
      available_techs: available.map((t) => ({ id: t.id, name: t.name, jobs_in_window: t.jobs })),
    };
  });

  if (windowPref) windows = windows.filter((w) => w.label === windowPref);
  return { date: dateStr, closed: false, windows };
}

/**
 * Best-fit tech for a window: field tech under capacity in the window, with the
 * fewest total active jobs that ET day. Returns employee row or null.
 */
export function pickTech(dateStr, windowLabel, excludeIds = []) {
  const w = getWindow(windowLabel);
  if (!w) return null;
  const dayStartUtc = etToUtc(dateStr, 0);
  const dayEndUtc = etToUtc(addDays(dateStr, 1), 0);
  const winStartUtc = etToUtc(dateStr, w.startHour);
  const winEndUtc = etToUtc(dateStr, w.endHour);

  const dayLoadQ = countStmt();
  let best = null;
  for (const t of listTechs()) {
    if (excludeIds.includes(t.id)) continue;
    const inWindow = techLoad(t.id, winStartUtc, winEndUtc);
    if (inWindow >= CAPACITY_PER_TECH_PER_WINDOW) continue;
    const inDay = dayLoadQ.get(t.id, ...ACTIVE_STATUSES, dayStartUtc, dayEndUtc).n;
    if (!best || inDay < best.inDay) best = { ...t, inDay };
  }
  return best ? { id: best.id, first_name: best.first_name, last_name: best.last_name } : null;
}

const jobSelect = `
  SELECT j.id, j.invoice_number, j.description, j.work_status,
         j.scheduled_start, j.scheduled_end, j.arrival_window, j.source,
         j.customer_id, c.first_name AS customer_first, c.last_name AS customer_last, c.company AS customer_company,
         a.street, a.street_line_2, a.city, a.state, a.zip
  FROM jobs j
  LEFT JOIN customers c ON c.id = j.customer_id
  LEFT JOIN customer_addresses a ON a.id = j.address_id`;

function attachTechs(rows) {
  const techQ = db.prepare(
    `SELECT e.id, e.first_name, e.last_name FROM job_assignments ja
     JOIN employees e ON e.id = ja.employee_id WHERE ja.job_id = ?`
  );
  return rows.map((r) => ({ ...r, techs: techQ.all(r.id) }));
}

/** One ET day's active jobs grouped by tech (plus unassigned). */
export function getScheduleDay(dateStr) {
  const dayStartUtc = etToUtc(dateStr, 0);
  const dayEndUtc = etToUtc(addDays(dateStr, 1), 0);
  const rows = db
    .prepare(`${jobSelect}
      WHERE j.work_status IN ('scheduled','in progress')
        AND j.scheduled_start >= ? AND j.scheduled_start < ?
      ORDER BY j.scheduled_start`)
    .all(dayStartUtc, dayEndUtc);
  const withTechs = attachTechs(rows);
  const byTech = {};
  const unassigned = [];
  for (const job of withTechs) {
    if (job.techs.length === 0) {
      unassigned.push(job);
      continue;
    }
    for (const t of job.techs) {
      const name = `${t.first_name} ${t.last_name}`.trim();
      (byTech[name] ??= { employee_id: t.id, tech: name, jobs: [] }).jobs.push(job);
    }
  }
  return { date: dateStr, techs: Object.values(byTech), unassigned };
}

/** Week view: 7 ET days starting at `startStr` (defaults to today ET). */
export function getScheduleWeek(startStr = null) {
  const start = startStr && isValidDateStr(startStr) ? startStr : todayEt();
  const days = [];
  for (let i = 0; i < 7; i++) {
    days.push(getScheduleDay(addDays(start, i)));
  }
  return { start, days };
}
