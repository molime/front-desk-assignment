// Agent tool implementations (DESIGN.md §3). Each tool calls the Stage-1
// service layer directly — no HTTP hop. Every tool returns a compact,
// voice-friendly JSON object; errors are returned as {error} so the model can
// apologize and offer a handoff instead of the call crashing.
import * as customers from '../services/customerService.js';
import * as jobs from '../services/jobService.js';
import * as schedule from '../services/scheduleService.js';
import * as warranty from '../services/warrantyService.js';
import * as calls from '../services/callService.js';
import { getWeather, webSearch } from './webtools.js';
import { utcToEtDate } from '../lib/time.js';

// --- compact, voice-friendly mappers ------------------------------------------

const fmtDate = (iso) => (iso ? utcToEtDate(iso) : null);

const oneLine = (a) =>
  a ? [a.street, a.street_line_2, a.city, a.state, a.zip].filter(Boolean).join(', ') : null;

function customerSummary(c) {
  return {
    customer_id: c.id,
    name: [c.first_name, c.last_name].filter(Boolean).join(' ') || null,
    company: c.company,
    kind: c.kind,
    job_count: c.job_count,
    addresses: (c.addresses ?? []).map((a) => ({ address_id: a.id, address: oneLine(a) })),
  };
}

function visitSummary(j) {
  return {
    job_id: j.id,
    date: fmtDate(j.scheduled_start),
    completed: fmtDate(j.completed_at),
    status: j.work_status,
    description: j.description,
    address: oneLine(j.address),
    techs: (j.techs ?? []).map((t) => `${t.first_name} ${t.last_name}`.trim()),
    notes: (j.notes ?? []).slice(0, 2).map((n) => n.summary ?? n.content),
  };
}

function bookingConfirmation(detail) {
  return {
    job_id: detail.id,
    status: detail.work_status,
    date: fmtDate(detail.scheduled_start),
    scheduled_start: detail.scheduled_start,
    scheduled_end: detail.scheduled_end,
    customer: detail.customer
      ? [detail.customer.first_name, detail.customer.last_name].filter(Boolean).join(' ') || detail.customer.company
      : null,
    address: oneLine(detail.address),
    techs: (detail.techs ?? []).map((t) => `${t.first_name} ${t.last_name}`.trim()),
    description: detail.description,
  };
}

// --- dispatch table ------------------------------------------------------------

const handlers = {
  find_customer({ query }) {
    const results = customers.search(query, 5).map(customerSummary);
    return results.length ? { matches: results } : { matches: [], note: `no customers matching "${query}"` };
  },

  get_customer_profile({ customer_id }) {
    const p = customers.getProfile(customer_id);
    if (!p) return { error: 'customer not found' };
    return {
      ...customerSummary(p),
      open_balance_dollars: (p.open_balance ?? 0) / 100,
      tags: p.tags,
    };
  },

  get_visit_history({ customer_id, limit }) {
    const history = customers.getVisitHistory(customer_id, Math.min(limit ?? 5, 10));
    if (!history) return { error: 'customer not found' };
    return history.length
      ? { visits: history.map(visitSummary) }
      : { visits: [], note: 'no visits on record' };
  },

  check_warranty({ customer_id }) {
    const v = warranty.checkWarranty(customer_id);
    if (!v) return { error: 'customer not found' };
    return {
      summary: v.summary,
      labor_warranty: {
        active: v.labor_warranty.active,
        basis: v.labor_warranty.basis,
        installs: v.labor_warranty.installs.map((i) => ({
          installed_date: fmtDate(i.installed_at),
          expires_date: fmtDate(i.labor_warranty_expires),
          active: i.active,
          description: i.description,
          address: i.address,
        })),
      },
      warranty_claims: v.warranty_claims.map((c) => ({
        date: fmtDate(c.scheduled_start ?? c.completed_at),
        description: c.description,
        status: c.work_status,
      })),
      warranty_line_items: v.warranty_line_items.map((li) => ({
        name: li.name,
        service_date: li.service_date,
        invoice_number: li.invoice_number,
      })),
    };
  },

  get_upcoming_appointments({ customer_id }) {
    const appts = customers.getUpcomingAppointments(customer_id);
    return appts.length
      ? { appointments: appts.map(visitSummary) }
      : { appointments: [], note: 'no upcoming appointments' };
  },

  check_availability({ date, window }) {
    const avail = schedule.getAvailability(date, window ?? null);
    if (avail.closed) return { date: avail.date, closed: true, reason: avail.reason, open_windows: [] };
    const open = avail.windows
      .filter((w) => w.open)
      .map((w) => ({ window: w.label, slots_free: w.slots }));
    return open.length
      ? { date: avail.date, closed: false, open_windows: open }
      : { date: avail.date, closed: false, open_windows: [], note: 'fully booked that day — suggest another day or a handoff' };
  },

  book_appointment(args) {
    const detail = jobs.createJob(args);
    return { booked: true, ...bookingConfirmation(detail) };
  },

  reschedule_appointment({ job_id, date, window }) {
    const detail = jobs.rescheduleJob(job_id, { date, window });
    return { rescheduled: true, ...bookingConfirmation(detail) };
  },

  cancel_appointment({ job_id, reason }) {
    const detail = jobs.cancelJob(job_id, { reason });
    return { cancelled: true, job_id: detail.id, status: detail.work_status, reason: reason ?? null };
  },

  add_job_note({ job_id, note }) {
    const n = jobs.addNote(job_id, note, 'agent');
    return { note_added: true, job_id, note: n.content };
  },

  async get_weather(args) {
    return getWeather(args);
  },

  async web_search(args) {
    return webSearch(args);
  },

  request_handoff({ reason, customer_id }, ctx) {
    const customer = customer_id ? customers.getById(customer_id) : null;
    const who = customer
      ? [customer.first_name, customer.last_name].filter(Boolean).join(' ') || customer.company
      : null;
    const task = calls.createTask({
      kind: 'handoff',
      title: `Callback requested${who ? ` — ${who}` : ''}`,
      detail: reason,
      call_id: ctx?.callId ?? null,
      customer_id: customer ? customer.id : null,
    });
    if (ctx?.callId) calls.setHandoffReason(ctx.callId, reason);
    return { handoff_created: true, task_id: task.id, message: 'A human from the office will call back.' };
  },
};

export const TOOL_NAMES = Object.keys(handlers);

/**
 * Execute one tool call. ctx: { callId } — used for handoff linkage and the
 * agent_actions audit row (written by the bridge, not here).
 * Never throws: failures come back as {error}.
 */
export async function executeTool(name, args = {}, ctx = {}) {
  const handler = handlers[name];
  if (!handler) return { error: `unknown tool: ${name}` };
  try {
    return await handler(args, ctx);
  } catch (err) {
    return { error: err.message ?? String(err) };
  }
}

/** One-line human summary of a tool call, for the call.action dashboard feed. */
export function summarizeAction(name, args, result) {
  if (result?.error) return `${name} failed: ${result.error}`;
  switch (name) {
    case 'find_customer':
      return `Searched customer "${args.query}" → ${result.matches?.length ?? 0} match(es)`;
    case 'get_customer_profile':
      return `Pulled profile for ${result.name ?? result.company ?? args.customer_id}`;
    case 'get_visit_history':
      return `Checked visit history (${result.visits?.length ?? 0} visit(s))`;
    case 'check_warranty':
      return `Warranty check: ${result.summary ?? 'done'}`;
    case 'get_upcoming_appointments':
      return `Checked upcoming appointments (${result.appointments?.length ?? 0})`;
    case 'check_availability':
      return `Checked availability for ${args.date}: ${(result.open_windows ?? []).map((w) => w.window).join(', ') || 'none open'}`;
    case 'book_appointment':
      return `Booked ${result.date} window ${args.window} (${result.job_id})`;
    case 'reschedule_appointment':
      return `Rescheduled ${args.job_id} → ${result.date} ${args.window}`;
    case 'cancel_appointment':
      return `Cancelled ${args.job_id}`;
    case 'add_job_note':
      return `Added note to ${args.job_id}`;
    case 'get_weather':
      return `Checked weather for ${result.location ?? args.city_or_zip}`;
    case 'web_search':
      return `Web search: "${args.query}"`;
    case 'request_handoff':
      return `Handoff requested: ${args.reason}`;
    default:
      return name;
  }
}
