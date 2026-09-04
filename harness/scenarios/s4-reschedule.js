// S4 — reschedule an existing upcoming appointment (DESIGN.md §5 scenario 4).
// setup() seeds a future appointment for Jasmine Harrington on the throwaway DB
// copy (imported data ages; a seeded booking keeps the scenario deterministic).
// The caller asks to move it; the agent must reschedule it and confirm aloud.
import * as jobs from '../../server/src/services/jobService.js';
import { utcToEtDate } from '../../server/src/lib/time.js';
import { businessDay, mentionsDate } from '../util.js';

export default {
  name: 's4-reschedule',
  description: 'Caller moves an existing upcoming appointment to a later afternoon slot',

  callerTurns: [
    'Hi, this is Jasmine Harrington. I have a maintenance visit booked with you early next week and something came up — I need to move it.',
    'The maintenance one, yes. Can we push it a few days later, in the afternoon? The 1 to 3 PM window if you have it.',
    "Yes, that works perfectly. Thanks!",
  ],

  async setup({ db, todayEt, addDays, etDayOfWeek }) {
    const customer = db.prepare(`SELECT * FROM customers WHERE first_name = 'Jasmine' AND last_name = 'Harrington'`).get();
    if (!customer) throw new Error('Jasmine Harrington not found');
    const addr = db.prepare(`SELECT * FROM customer_addresses WHERE customer_id = ?`).get(customer.id);
    const date = businessDay(todayEt(), addDays, etDayOfWeek, 3);
    const job = jobs.createJob({
      customer_id: customer.id,
      address_id: addr?.id,
      date,
      window: '10-12',
      description: 'Harness reschedule marker — maintenance visit',
    });
    return { jobId: job.id, customerId: customer.id, originalDate: date };
  },

  async validate({ db }) {
    const problems = [];
    if (!db.prepare(`SELECT * FROM customers WHERE first_name = 'Jasmine' AND last_name = 'Harrington'`).get()) {
      problems.push('customer "Jasmine Harrington" not found');
    }
    return problems;
  },

  async assert(ctx) {
    ctx.check('get_upcoming_appointments called', ctx.toolCalled('get_upcoming_appointments'));
    ctx.check('reschedule_appointment called', ctx.toolCalled('reschedule_appointment'));

    const rs = ctx.lastTool('reschedule_appointment');
    ctx.check('the seeded appointment was the one moved', rs?.args?.job_id === ctx.data.jobId, `moved ${rs?.args?.job_id}, seeded ${ctx.data.jobId}`);
    if (!rs || rs.result?.error) return;

    const job = ctx.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(ctx.data.jobId);
    const newEtDate = utcToEtDate(job.scheduled_start);
    ctx.check(
      'job scheduled_start moved to the requested day',
      newEtDate === rs.args.date,
      `job now ${newEtDate}, reschedule requested ${rs.args.date}`
    );
    ctx.check('job moved OFF the original date', newEtDate !== ctx.data.originalDate, `still on ${ctx.data.originalDate}`);
    ctx.check('job still scheduled (not cancelled)', job.work_status === 'scheduled', job.work_status);
    ctx.check('2-hour arrival window preserved', job.arrival_window === 120, `arrival_window=${job.arrival_window}`);

    ctx.check(
      'reply confirms the new date aloud',
      mentionsDate(ctx.agentText, newEtDate),
      `moved to ${newEtDate} but never said in agent messages`
    );
  },
};
