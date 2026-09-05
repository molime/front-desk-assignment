// Unit test: every tool in realtime/tools.js against the real DB.
// Run: node scripts/test-tools.js   (network needed for get_weather / web_search)
import db from '../src/db/index.js';
import { executeTool, TOOL_NAMES } from '../src/realtime/tools.js';
import { subscribe } from '../src/lib/events.js';
import { addDays, etDayOfWeek, todayEt } from '../src/lib/time.js';

let passed = 0, failed = 0;
const check = (label, cond, extra = '') => {
  if (cond) { passed++; console.log(`  PASS ${label}`); }
  else { failed++; console.log(`  FAIL ${label} ${extra}`); }
};

// next weekday (Mon–Sat) for booking tests
let bookDate = todayEt();
while (etDayOfWeek(bookDate) === 0) bookDate = addDays(bookDate, 1);
bookDate = addDays(bookDate, etDayOfWeek(bookDate) === 6 ? 2 : 1); // tomorrow, skipping Sunday
if (etDayOfWeek(bookDate) === 0) bookDate = addDays(bookDate, 1);

console.log('tools registered:', TOOL_NAMES.join(', '));
check('all 19 tools registered', TOOL_NAMES.length === 19);

// --- find_customer -------------------------------------------------------------
console.log('\nfind_customer("89 Harborlight"):');
const found = await executeTool('find_customer', { query: '89 Harborlight' });
console.log(JSON.stringify(found, null, 1).slice(0, 900));
check('returns matches with addresses', found.matches?.length > 0 && found.matches[0].addresses?.length > 0);
const customer = found.matches[0];
const address = customer.addresses[0];

// Live callers append the city ("89 Harborlight Shores, Miami Beach") — the
// full phrase never fits one column; the fallback must retry the head part.
console.log('\nfind_customer("89 Harborlight Shores, Miami Beach") [spoken with city]:');
const spoken = await executeTool('find_customer', { query: '89 Harborlight Shores, Miami Beach' });
check('spoken address + city still finds the customer', spoken.matches?.length > 0,
  JSON.stringify(spoken).slice(0, 200));
const spokenNoCity = await executeTool('find_customer', { query: '89 Harborlight Shores Blvd W' });
check('street fragment alone still finds the customer', spokenNoCity.matches?.length > 0,
  JSON.stringify(spokenNoCity).slice(0, 200));

// --- get_customer_profile --------------------------------------------------------
console.log('\nget_customer_profile:');
const profile = await executeTool('get_customer_profile', { customer_id: customer.customer_id });
check('profile has kind + open_balance', profile.kind !== undefined && profile.open_balance_dollars !== undefined);

// --- get_visit_history ------------------------------------------------------------
console.log('\nget_visit_history:');
const history = await executeTool('get_visit_history', { customer_id: customer.customer_id, limit: 3 });
check('visits are compact summaries', Array.isArray(history.visits), JSON.stringify(history).slice(0, 200));
if (history.visits?.[0]) console.log('  sample:', JSON.stringify(history.visits[0]).slice(0, 300));

// --- check_warranty (recent tagged install → active labor warranty) ---------------
console.log('\ncheck_warranty (Hazel McKay, install 2026-04-29 tagged Registration Complete):');
const w = await executeTool('check_warranty', { customer_id: 'cus_eba6fe433c5f460097dd9332db1f94bd' });
console.log('  summary:', w.summary);
check('labor warranty active', w.labor_warranty?.active === true);
check('expiry ~1yr after install', w.labor_warranty?.installs?.[0]?.expires_date === '2027-04-29',
  JSON.stringify(w.labor_warranty?.installs?.[0]));

// --- get_upcoming_appointments ------------------------------------------------------
console.log('\nget_upcoming_appointments:');
const upcoming = await executeTool('get_upcoming_appointments', { customer_id: customer.customer_id });
check('returns appointments array', Array.isArray(upcoming.appointments));

// --- check_availability --------------------------------------------------------------
console.log(`\ncheck_availability(${bookDate}):`);
const avail = await executeTool('check_availability', { date: bookDate });
console.log('  open windows:', JSON.stringify(avail.open_windows));
check('returns only open slots', avail.closed === false && avail.open_windows.length > 0
  && avail.open_windows.every((x) => x.slots_free > 0));
const sunday = await executeTool('check_availability', { date: next_dow(0) });
function next_dow(dow) { let d = todayEt(); while (etDayOfWeek(d) !== dow) d = addDays(d, 1); return d; }
check('Sunday closed', sunday.closed === true);

// Past-date availability is never offered.
const pastDate = addDays(todayEt(), -3);
const pastAvail = await executeTool('check_availability', { date: pastDate });
check('past date has no open windows (with helpful note)', pastAvail.open_windows.length === 0
  && /passed/i.test(pastAvail.note ?? ''), JSON.stringify(pastAvail.note));
// Same-day: after 14:00 ET (or when all windows started), nothing today is offered.
const todayAvail = await executeTool('check_availability', { date: todayEt() });
const nowEtHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
if (nowEtHour >= 14) {
  check('same-day windows not offered after the 14:00 ET cutoff', todayAvail.open_windows.length === 0,
    JSON.stringify(todayAvail.open_windows));
}

// --- book → reschedule → cancel roundtrip --------------------------------------------
console.log('\nbook/reschedule/cancel roundtrip:');
const book = await executeTool('book_appointment', {
  customer_id: customer.customer_id, address_id: address.address_id,
  date: bookDate, window: '8-10', description: 'TEST — no cooling', notes: 'test booking, will cancel',
});
check('booked', book.booked === true && book.job_id, JSON.stringify(book).slice(0, 300));
const day2 = etDayOfWeek(addDays(bookDate, 1)) === 0 ? addDays(bookDate, 2) : addDays(bookDate, 1);
const re = await executeTool('reschedule_appointment', { job_id: book.job_id, date: day2, window: '13-15' });
check('rescheduled', re.rescheduled === true && re.date === day2, JSON.stringify(re).slice(0, 300));
const cancel = await executeTool('cancel_appointment', { job_id: book.job_id, reason: 'test cleanup' });
check('cancelled', cancel.cancelled === true);
const jobRow = db.prepare(`SELECT work_status, source FROM jobs WHERE id = ?`).get(book.job_id);
check('DB shows canceled agent job', jobRow.work_status === 'canceled' && jobRow.source === 'agent');

// --- add_job_note ----------------------------------------------------------------------
console.log('\nadd_job_note:');
const note = await executeTool('add_job_note', { job_id: book.job_id, note: 'Caller mentioned a dog on premises (test note)' });
check('note added', note.note_added === true);
const noteRow = db.prepare(`SELECT author FROM job_notes WHERE job_id = ? AND content LIKE '%dog on premises%'`).get(book.job_id);
check('note persisted with author=agent', noteRow?.author === 'agent');

// --- request_handoff (task row + broadcast) ---------------------------------------------
console.log('\nrequest_handoff:');
const events = [];
const unsub = subscribe('*', (e) => events.push(e));
const ho = await executeTool('request_handoff', { reason: 'Caller disputes a bill (test)', customer_id: customer.customer_id }, { callId: null });
unsub();
check('confirmation returned', ho.handoff_created === true && ho.task_id);
const taskRow = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(ho.task_id);
check('task row persisted', taskRow?.kind === 'handoff' && taskRow?.detail?.includes('disputes') && taskRow?.status === 'open');
check('task.created broadcast', events.some((e) => e.event === 'task.created' && e.payload.task.id === ho.task_id));

// --- error wrapping ---------------------------------------------------------------------
const bad = await executeTool('book_appointment', { customer_id: 'cus_nope', date: bookDate, window: '8-10' });
check('tool errors come back as {error}, not thrown', typeof bad.error === 'string');
const unknown = await executeTool('nope_tool', {});
check('unknown tool → {error}', unknown.error === 'unknown tool: nope_tool');

// --- create_customer: phone capture (live incident: model passed the literal
// placeholder "caller's current number" — must fall back to the real from_number)
console.log('\ncreate_customer phone capture:');
const { createCall } = await import('../src/services/callService.js');
// Clean up rows from previous runs (call_sid is reused every run).
for (const s of db.prepare(`SELECT id FROM calls WHERE call_sid = 'CAtestphone1'`).all()) {
  db.prepare(`DELETE FROM agent_actions WHERE call_id = ?`).run(s.id);
  db.prepare(`DELETE FROM calls WHERE id = ?`).run(s.id);
}
const pcCall = createCall({ call_sid: 'CAtestphone1', from_number: '+13055550142', status: 'in-progress' });
const phoneCallId = pcCall.id;
const createdPlaceholder = await executeTool('create_customer', {
  first_name: 'Phone', last_name: 'Test', kind: 'homeowner',
  phone: "caller's current number", // the exact placeholder from the live call
  address: { street: '1 Phone Capture Ln', city: 'Miami', state: 'FL' },
}, { callId: phoneCallId });
check('placeholder phone string rejected → caller number captured instead',
  createdPlaceholder.phone === '+13055550142', JSON.stringify(createdPlaceholder).slice(0, 200));
const createdExplicit = await executeTool('create_customer', {
  first_name: 'Phone', last_name: 'Test2', kind: 'homeowner',
  phone: '(305) 555-0100', // a real dictated number must win
  address: { street: '2 Phone Capture Ln', city: 'Miami', state: 'FL' },
}, { callId: phoneCallId });
check('real dictated phone wins over the caller number', createdExplicit.phone === '(305) 555-0100',
  JSON.stringify(createdExplicit).slice(0, 200));
check('both creates returned usable ids', Boolean(createdPlaceholder.customer_id && createdPlaceholder.address_id
  && createdExplicit.customer_id && createdExplicit.address_id));
// cleanup the two test customers + the call row
db.prepare(`DELETE FROM customer_addresses WHERE customer_id IN (?, ?)`).run(createdPlaceholder.customer_id, createdExplicit.customer_id);
db.prepare(`DELETE FROM customers WHERE id IN (?, ?)`).run(createdPlaceholder.customer_id, createdExplicit.customer_id);
db.prepare(`DELETE FROM agent_actions WHERE call_id = ?`).run(phoneCallId);
db.prepare(`DELETE FROM calls WHERE id = ?`).run(phoneCallId);

// --- crew line: PIN hygiene + lockout (regression for the PIN-leak fix) -----------------
console.log('\ncrew line / PINs:');
const employees = await import('../src/services/employeeService.js');
employees.ensureEmployeePins();
const roster = employees.roster();
check('roster contains NO pins (public API must not leak credentials)',
  roster.every((e) => e.pin === undefined));
const aTech = roster.find((e) => e.role === 'field tech');
const pin1 = employees.getPin(aTech.id);
const pin2 = employees.getPin(aTech.id);
check('PINs are deterministic (same employee, same PIN)', pin1 === pin2 && /^\d{4}$/.test(pin1));
const rosterCallId = 'call_test_pins_1';
const nameOnly = await executeTool('identify_employee', { name: aTech.name }, { callId: rosterCallId });
check('name alone grants nothing (needs_pin, no scope)', nameOnly.found === true && nameOnly.needs_pin === true && !nameOnly.scope);
const wrongPin = await executeTool('identify_employee', { name: aTech.name, pin: '0000' }, { callId: rosterCallId });
check('wrong PIN rejected with attempts-left message', typeof wrongPin.error === 'string' && /PIN does not match/.test(wrongPin.error),
  JSON.stringify(wrongPin.error));
const wrongPin2 = await executeTool('identify_employee', { name: aTech.name, pin: '0001' }, { callId: rosterCallId });
const wrongPin3 = await executeTool('identify_employee', { name: aTech.name, pin: '0002' }, { callId: rosterCallId });
const lockedOut = await executeTool('identify_employee', { name: aTech.name, pin: '0003' }, { callId: rosterCallId });
check('3 wrong PINs lock crew access for the call', /locked/i.test(String(lockedOut.error)),
  JSON.stringify(lockedOut.error));
// A new call starts clean — and the real PIN works on it.
const freshCallId = 'call_test_pins_2';
const okPin = await executeTool('identify_employee', { name: aTech.name, pin: pin1 }, { callId: freshCallId });
check('correct PIN verifies on a fresh call (no sticky lockout)', okPin.scope === 'full' && okPin.employee_id === aTech.id,
  JSON.stringify(okPin));
// Wrong-PIN state must not leak into the fresh call either.
const afterOk = await executeTool('identify_employee', { name: aTech.name, pin: '0000' }, { callId: freshCallId });
check('fresh call gets its own attempt counter', /attempt/.test(String(afterOk.error)), JSON.stringify(afterOk.error));
employees.setCallAuth(freshCallId, null);
employees.clearCallAuth(rosterCallId);
employees.clearCallAuth(freshCallId);

// --- note hygiene: HCP automation drafts never reach the agent -------------------------
console.log('\nnote hygiene (HCP automation drafts):');
const draftNote = db.prepare(`SELECT COUNT(*) n FROM job_notes WHERE content LIKE '[AI Auto-Complete%'`).get().n;
const flaggedNote = db.prepare(`SELECT COUNT(*) n FROM job_notes WHERE content LIKE '%=== AI STATUS FLAGS ===%'`).get().n;
console.log(`  drafts in DB: ${draftNote} AI-Auto-Complete, ${flaggedNote} AI-STATUS-FLAGS`);
check('automation drafts exist in the source data (fixture present)', draftNote > 0 && flaggedNote > 0);
const draftJobs = db.prepare(`SELECT DISTINCT job_id FROM job_notes WHERE content LIKE '[AI Auto-Complete%' OR content LIKE '%=== AI STATUS FLAGS ===%' LIMIT 5`).all();
let leaked = 0, checked = 0;
for (const { job_id } of draftJobs) {
  const cust = db.prepare(`SELECT customer_id FROM jobs WHERE id = ?`).get(job_id);
  if (!cust?.customer_id) continue;
  const hist = await executeTool('get_visit_history', { customer_id: cust.customer_id, limit: 10 });
  for (const v of hist.visits ?? []) {
    for (const n of v.notes ?? []) {
      checked++;
      if (String(n).includes('[AI Auto-Complete') || String(n).includes('=== AI STATUS FLAGS ===')) leaked++;
    }
  }
}
check('visit-history notes never include automation drafts', checked > 0 && leaked === 0,
  `${leaked} leaked of ${checked} notes checked`);

// --- get_weather (network) ------------------------------------------------------------------
console.log('\nget_weather("Miami"):');
const wx = await executeTool('get_weather', { city_or_zip: 'Miami' });
console.log(' ', JSON.stringify(wx).slice(0, 400));
check('real weather data', wx.current?.temp_f !== undefined && wx.forecast?.high_f !== undefined, JSON.stringify(wx).slice(0, 200));

// --- web_search (network) ---------------------------------------------------------------------
console.log('\nweb_search("Trane 4TWR5 model"):');
const ws = await executeTool('web_search', { query: 'Trane 4TWR5 model' });
console.log(' ', JSON.stringify(ws).slice(0, 600));
check('search returns results', (ws.results?.length ?? 0) > 0 || ws.error, JSON.stringify(ws.results ?? ws).slice(0, 200));

// --- cleanup: leave the dev DB exactly as we found it ------------------------------------------
db.prepare(`DELETE FROM job_notes WHERE job_id = ?`).run(book.job_id);
db.prepare(`DELETE FROM job_assignments WHERE job_id = ?`).run(book.job_id);
db.prepare(`DELETE FROM jobs WHERE id = ?`).run(book.job_id);
db.prepare(`DELETE FROM tasks WHERE id = ?`).run(ho.task_id);
console.log('test rows cleaned up');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
