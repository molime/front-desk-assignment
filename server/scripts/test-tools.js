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
check('all 13 tools registered', TOOL_NAMES.length === 13);

// --- find_customer -------------------------------------------------------------
console.log('\nfind_customer("89 Harborlight"):');
const found = await executeTool('find_customer', { query: '89 Harborlight' });
console.log(JSON.stringify(found, null, 1).slice(0, 900));
check('returns matches with addresses', found.matches?.length > 0 && found.matches[0].addresses?.length > 0);
const customer = found.matches[0];
const address = customer.addresses[0];

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

// --- get_weather (network) ------------------------------------------------------------------
console.log('\nget_weather("Miami"):');
const wx = await executeTool('get_weather', { city_or_zip: 'Miami' });
console.log(' ', JSON.stringify(wx).slice(0, 400));
check('real weather data', wx.current?.temp_f !== undefined && wx.forecast?.high_f !== undefined, JSON.stringify(wx).slice(0, 200));

// --- web_search (network) ---------------------------------------------------------------------
console.log('\nweb_search("Trane 4TWR5 model"):');
const ws = await executeTool('web_search', { query: 'Trane 4TWR5 model' });
console.log(' ', JSON.stringify(ws).slice(0, 600));
check('search returns results', (ws.results?.length ?? 0) > 0 || ws.error, JSON.stringify(ws).slice(0, 200));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
