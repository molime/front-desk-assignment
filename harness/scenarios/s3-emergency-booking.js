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
    "It's the main property you have on file for us. The earliest window you have is fine — please book it.",
    "Perfect, thank you. Goodbye.",
  ],

  async validate({ db }) {
    const problems = [];
    const pm = db.prepare(`SELECT * FROM customers WHERE company LIKE '%Lighthouse Hospitality%'`).get();
    if (!pm) problems.push('customer "Lighthouse Hospitality" not found');
    else {
      const addr = db.prepare(`SELECT COUNT(*) n FROM customer_addresses WHERE customer_id = ?`).get(pm.id);
      if (addr.n === 0) problems.push('Lighthouse Hospitality has no addresses on file');
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
    ctx.check('booking returned a job id', !!jobId, JSON.stringify(booking?.result).slice(0, 160));
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

    ctx.check(
      'reply confirms the booked date aloud',
      mentionsDate(ctx.finalReply, booking.result.date),
      `booked ${booking.result.date} but reply was: "${ctx.finalReply.slice(0, 160)}"`
    );
    const techName = booking.result.techs?.[0];
    if (techName) {
      ctx.check(
        'reply names the tech aloud',
        ctx.finalReply.toLowerCase().includes(techName.split(' ')[0].toLowerCase()),
        `tech ${techName} not mentioned in: "${ctx.finalReply.slice(0, 160)}"`
      );
    }
  },
};
