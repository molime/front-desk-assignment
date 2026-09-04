// Agent tool implementations (DESIGN.md §3). Each tool calls the Stage-1
// service layer directly — no HTTP hop. Every tool returns a compact,
// voice-friendly JSON object; errors are returned as {error} so the model can
// apologize and offer a handoff instead of the call crashing.
import * as customers from '../services/customerService.js';
import * as jobs from '../services/jobService.js';
import * as schedule from '../services/scheduleService.js';
import * as warranty from '../services/warrantyService.js';
import * as calls from '../services/callService.js';
import * as employees from '../services/employeeService.js';
import { getWeather, webSearch } from './webtools.js';
import { utcToEtDate, todayEt } from '../lib/time.js';

// --- compact, voice-friendly mappers ------------------------------------------

const fmtDate = (iso) => (iso ? utcToEtDate(iso) : null);

// Human date with weekday ("Wednesday, September 9, 2026") — the model must
// never compute weekdays itself; tool results carry them (real call bug).
const dtfLongEt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
});
const dtfLongUtc = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
});
const fmtDateLong = (isoOrDate) => {
  if (!isoOrDate) return null;
  // Date-only strings are calendar days: anchor at UTC noon so no timezone
  // shift can move the weekday. Full timestamps format in ET.
  if (/^\d{4}-\d{2}-\d{2}$/.test(isoOrDate)) return dtfLongUtc.format(new Date(`${isoOrDate}T12:00:00Z`));
  return dtfLongEt.format(new Date(isoOrDate));
};

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
    invoice_number: j.invoice_number ?? null, // the short number staff use — shareable with the caller
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
    date_long: fmtDateLong(detail.scheduled_start), // e.g. "Wednesday, September 9, 2026"
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

  create_customer({ first_name, last_name, company, kind, phone, email, address }, ctx) {
    // Default the callback number to the number the caller is phoning from
    // (phone calls only — browser calls have no caller number).
    let contactPhone = phone ?? null;
    if (!contactPhone && ctx?.callId) {
      const row = calls.getCall(ctx.callId);
      if (row?.from_number && row.from_number !== 'web-call') contactPhone = row.from_number;
    }
    const created = customers.createCustomer({ first_name, last_name, company, kind, phone: contactPhone, email, address });
    return {
      created: true,
      customer_id: created.customer_id,
      address_id: created.address_id,
      name: [first_name, last_name].filter(Boolean).join(' ') || company || null,
      address: oneLine(address),
      phone: contactPhone,
      email: email ?? null,
      note: 'new customer registered — proceed with booking using these ids',
    };
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
    const date_long = fmtDateLong(avail.date); // weekday included — quote this to callers
    if (avail.closed) return { date: avail.date, date_long, closed: true, reason: avail.reason, open_windows: [] };
    const open = avail.windows
      .filter((w) => w.open)
      .map((w) => ({ window: w.label, slots_free: w.slots }));
    return open.length
      ? { date: avail.date, date_long, closed: false, open_windows: open }
      : { date: avail.date, date_long, closed: false, open_windows: [], note: 'fully booked that day — suggest another day or a handoff' };
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

  // --- crew line (employees calling in) ----------------------------------------

  identify_employee({ name, pin }, ctx) {
    employees.ensureEmployeePins(); // lazy seed: first PIN need, survives reseeds
    const matches = employees.matchEmployee(name);
    if (matches.length === 0) return { error: `no employee matching "${name}" — if this is a customer call, use find_customer` };
    const exact = matches.filter((m) => employees.fullName(m).toLowerCase() === String(name).trim().toLowerCase());
    const emp = exact[0] ?? (matches.length === 1 ? matches[0] : null);
    if (!emp) {
      return { error: `multiple employees match "${name}"`, matches: matches.map((m) => employees.fullName(m)) };
    }
    if (!ctx?.callId) return { error: 'no call context' };
    const empName = employees.fullName(emp);
    if (pin == null || String(pin).trim() === '') {
      employees.setCallAuth(ctx.callId, { employeeId: emp.id, scope: 'read' });
      return { employee_id: emp.id, name: empName, role: emp.role, scope: 'read', note: 'read-only access — ask for their 4-digit PIN to make changes' };
    }
    if (!employees.verifyPin(emp.id, pin)) return { error: 'PIN does not match' };
    employees.setCallAuth(ctx.callId, { employeeId: emp.id, scope: 'full' });
    return { employee_id: emp.id, name: empName, role: emp.role, scope: 'full' };
  },

  get_my_schedule({ date }, ctx) {
    const auth = employees.getCallAuth(ctx?.callId);
    if (!auth) return { error: 'identify yourself first with identify_employee (your name is enough for read-only info)' };
    const dateEt = date ?? todayEt();
    const emp = employees.getEmployee(auth.employeeId);
    const dayJobs = employees.scheduleFor(auth.employeeId, dateEt);
    return {
      employee: employees.fullName(emp),
      date: dateEt,
      jobs: dayJobs,
      note: dayJobs.length ? null : 'no jobs scheduled that day',
    };
  },

  complete_job({ job_id }, ctx) {
    const auth = employees.getCallAuth(ctx?.callId);
    if (!auth) return { error: 'identify yourself first with identify_employee' };
    if (auth.scope !== 'full') {
      return { error: 'marking a job complete changes records — ask for their 4-digit PIN and call identify_employee again with it' };
    }
    return employees.completeJobAs(job_id, auth.employeeId);
  },

  leave_message({ to, message }, ctx) {
    const auth = employees.getCallAuth(ctx?.callId);
    if (!auth) return { error: 'identify yourself first with identify_employee so the office knows who left the message' };
    const from = employees.getEmployee(auth.employeeId);
    let assignee = null;
    if (String(to).trim().toLowerCase() !== 'office') {
      const matches = employees.matchEmployee(to);
      const exact = matches.filter((m) => employees.fullName(m).toLowerCase() === String(to).trim().toLowerCase());
      assignee = exact[0] ?? (matches.length === 1 ? matches[0] : null);
      if (!assignee) {
        return matches.length === 0
          ? { error: `no employee matching "${to}" — say "office" to leave it with the office` }
          : { error: `multiple employees match "${to}"`, matches: matches.map((m) => employees.fullName(m)) };
      }
    }
    const task = calls.createTask({
      kind: 'message',
      title: `Message from ${employees.fullName(from)}`,
      detail: String(message ?? '').trim(),
      call_id: ctx?.callId ?? null,
      assigned_employee_id: assignee?.id ?? null,
    });
    return { message_left: true, task_id: task.id, to: assignee ? employees.fullName(assignee) : 'the office' };
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
    case 'create_customer':
      return `Created customer ${result.name ?? ''} (${result.customer_id})`.trim();
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
    case 'identify_employee':
      return `Identified ${result.name ?? args.name} (${result.scope} access)`;
    case 'get_my_schedule':
      return `Read ${result.employee ?? 'crew member'}'s schedule for ${result.date} (${result.jobs?.length ?? 0} job(s))`;
    case 'complete_job':
      return `Marked ${result.job_id} complete`;
    case 'leave_message':
      return `Message left for ${result.to}`;
    case 'request_handoff':
      return `Handoff requested: ${args.reason}`;
    default:
      return name;
  }
}
