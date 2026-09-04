// S9 — new-customer booking (web-call audit fix: book_appointment with
// customer_id "new" used to error and fall back to handoff). A caller who is
// NOT in the system must be registered with create_customer and then booked
// normally — no handoff.
import { utcToEtDate, todayEt, addDays } from '../../server/src/lib/time.js';
import { mentionsDate } from '../util.js';

const NEW_NAME = /Fontaine/i;
const NEW_STREET = '7700 Bayshore Colony';

export default {
  name: 's9-new-customer-booking',
  description: 'New customer (not in the system) books an appointment — create_customer, then book, no handoff',

  callerTurns: [
    "Hi, this is Rachel Fontaine — I'm pretty sure I'm not in your system, I've never used you before. The AC at my place is blowing warm air. It's 7700 Bayshore Colony Drive in Miami. Could someone come out tomorrow morning?",
    "Yes — tomorrow, the 8 to 10 window works great. Please book it. My callback number is 305-555-0142 and my email is rachel@fontaine.example.",
    "That's right. Thanks so much!",
  ],

  async validate({ db }) {
    const problems = [];
    const existing = db
      .prepare(`SELECT id FROM customers WHERE last_name LIKE 'Fontaine' OR company LIKE '%Fontaine%'`)
      .all();
    if (existing.length) problems.push('test name "Fontaine" already exists in customer data — pick another');
    const addr = db.prepare(`SELECT id FROM customer_addresses WHERE street LIKE '${NEW_STREET}%'`).all();
    if (addr.length) problems.push(`test street "${NEW_STREET}" already exists in address data — pick another`);
    const techs = db.prepare(`SELECT COUNT(*) n FROM employees WHERE role = 'field tech'`).get();
    if (techs.n === 0) problems.push('no field techs available for booking');
    return problems;
  },

  async assert(ctx) {
    // find_customer is optional here by design: when the caller states they're
    // new, going straight to create_customer is the DESIRED behavior (no wasted
    // search). Either path is fine — what matters is create then book.
    ctx.check('create_customer called', ctx.toolCalled('create_customer'));
    ctx.check('book_appointment called', ctx.toolCalled('book_appointment'));

    const names = ctx.toolCalls.map((t) => t.name);
    ctx.check(
      'create_customer before book_appointment',
      names.indexOf('create_customer') >= 0 && names.indexOf('create_customer') < names.lastIndexOf('book_appointment')
    );

    const created = ctx.lastTool('create_customer')?.result;
    ctx.check(
      'create_customer returned agent-provenance ids',
      /^cus_agent_/.test(created?.customer_id ?? '') && /^adr_agent_/.test(created?.address_id ?? ''),
      JSON.stringify(created ?? null)
    );

    const customer = created && ctx.db.prepare(`SELECT * FROM customers WHERE id = ?`).get(created.customer_id);
    ctx.check('customer row exists and matches the caller', !!customer && NEW_NAME.test(customer.last_name ?? ''), JSON.stringify(customer));
    ctx.check(
      'contact info captured (phone and email stored)',
      !!customer && /305.?555.?0142/.test(customer.phone ?? '') && /fontaine/i.test(customer.email ?? ''),
      `phone=${customer?.phone} email=${customer?.email}`
    );
    const address = created && ctx.db.prepare(`SELECT * FROM customer_addresses WHERE id = ?`).get(created.address_id);
    ctx.check(
      'address row exists and matches',
      !!address && address.street?.includes(NEW_STREET) && address.customer_id === created.customer_id,
      JSON.stringify(address)
    );

    const booking = ctx.lastTool('book_appointment');
    const jobId = booking?.result?.job_id;
    ctx.check('booking returned a job id', !!jobId, String(JSON.stringify(booking?.result ?? booking?.args ?? null)).slice(0, 160));
    if (jobId) {
      const job = ctx.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(jobId);
      ctx.check(
        'job row exists with source "agent", status "scheduled", linked to the new customer',
        job?.source === 'agent' && job?.work_status === 'scheduled' && job?.customer_id === created?.customer_id,
        JSON.stringify(job)
      );
      const jobDate = job && utcToEtDate(job.scheduled_start);
      ctx.check(
        'booked within the next 2 days',
        jobDate && jobDate >= todayEt() && jobDate <= addDays(todayEt(), 2),
        `booked ${jobDate}, today is ${todayEt()}`
      );
      ctx.check(
        'reply confirms the booked date aloud (absolute or correct relative day)',
        (booking.result.date === addDays(todayEt(), 1) && /tomorrow/i.test(ctx.agentText)) ||
          mentionsDate(ctx.agentText, booking.result.date),
        `booked ${booking.result.date} but never said in agent messages`
      );
    }

    ctx.check('no handoff requested', !ctx.toolCalled('request_handoff'));
    const handoffTasks = ctx.db
      .prepare(`SELECT COUNT(*) n FROM tasks WHERE call_id = ?`)
      .get(ctx.callId).n;
    ctx.check('no handoff task created for this call', handoffTasks === 0, `${handoffTasks} task(s)`);
  },
};
