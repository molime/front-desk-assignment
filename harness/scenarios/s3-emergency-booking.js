// S3 — property-manager emergency booking (DESIGN.md §5 scenario 3).
// No cooling, guests checking in at 4 PM. The agent must check availability,
// book the soonest window, and read the booking (date + tech) back aloud.
import { utcToEtDate, todayEt, addDays } from '../../server/src/lib/time.js';
import { mentionsDate } from '../util.js';

export default {
  name: 's3-emergency-booking',
  description: 'Property manager emergency: no cooling, guests checking in at 4 PM — book soonest slot',

  callerTurns: [
    "Hi, this is Dana at Lighthouse Hospitality. The AC is completely out at our property and we've got guests checking in at 4 PM today. We need someone out as soon as humanly possible.",
    "It's 5245 Harborlight Cay Road, Unit A. The earliest window you have is fine — please book it.",
    "Yes, that's correct — go ahead and book it. Thanks so much!",
  ],

  async validate({ db }) {
    const problems = [];
    const pm = db
      .prepare(`SELECT * FROM customers WHERE company LIKE '%Lighthouse Hospitality%' OR (first_name = 'Lighthouse' AND last_name = 'Hospitality')`)
      .get();
    if (!pm) problems.push('customer "Lighthouse Hospitality" not found');
    else {
      const addr = db
        .prepare(`SELECT * FROM customer_addresses WHERE customer_id = ? AND street LIKE '5245 Harborlight%' AND street_line_2 LIKE '%Unit A%'`)
        .get(pm.id);
      if (!addr) problems.push('5245 Harborlight Cay Rd Unit A not found for Lighthouse Hospitality');
    }
    const techs = db.prepare(`SELECT COUNT(*) n FROM employees WHERE role = 'field tech'`).get();
    if (techs.n === 0) problems.push('no field techs available for booking');
    return problems;
  },

  async assert(ctx) {
    ctx.check('find_customer called', ctx.toolCalled('find_customer'));
    ctx.check('check_availability called', ctx.toolCalled('check_availability'));
    ctx.check('book_appointment called', ctx.toolCalled('book_appointment'));

    const calls = ctx.toolCalls.map((t) => t.name);
    ctx.check(
      'availability checked before booking',
      calls.indexOf('check_availability') >= 0 && calls.indexOf('check_availability') < calls.lastIndexOf('book_appointment')
    );

    const booking = ctx.lastTool('book_appointment');
    const jobId = booking?.result?.job_id;
    ctx.check('booking returned a job id', !!jobId, String(JSON.stringify(booking?.result ?? booking?.args ?? null)).slice(0, 160));
    if (!jobId) return;

    const job = ctx.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(jobId);
    ctx.check('job row exists with source "agent" and status "scheduled"', job?.source === 'agent' && job?.work_status === 'scheduled', JSON.stringify(job));

    const today = todayEt();
    const jobDate = utcToEtDate(job.scheduled_start);
    ctx.check(
      'arrival window is today or within 2 days (emergency = soonest)',
      jobDate >= today && jobDate <= addDays(today, 2),
      `booked ${jobDate}, today is ${today}`
    );
    ctx.check('a tech was assigned', ctx.db.prepare(`SELECT COUNT(*) n FROM job_assignments WHERE job_id = ?`).get(jobId).n > 0);

    // Same-day emergency bookings are naturally confirmed as "today from 8 to
    // 10" — accept relative-day words when they match the booked date.
    const relativeOk =
      (booking.result.date === today && /today|tonight|this (morning|afternoon|evening)/i.test(ctx.agentText)) ||
      (booking.result.date === addDays(today, 1) && /tomorrow/i.test(ctx.agentText));
    ctx.check(
      'reply confirms the booked date aloud (absolute or correct relative day)',
      mentionsDate(ctx.agentText, booking.result.date) || relativeOk,
      `booked ${booking.result.date} (today is ${today}) but never said in agent messages`
    );
    const techName = booking.result.techs?.[0];
    if (techName) {
      ctx.check(
        'reply names the tech aloud',
        ctx.agentText.toLowerCase().includes(techName.split(' ')[0].toLowerCase()),
        `tech ${techName} not mentioned in agent messages`
      );
    }
  },
};
