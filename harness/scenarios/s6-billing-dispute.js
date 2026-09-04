// S6 — billing dispute / angry caller → handoff (DESIGN.md §5 scenario 6).
// Isabel Kane has a large open balance. The agent must NOT argue, NOT mutate
// any booking — it must create a handoff task and promise a human callback.
// Note: the scenario DB is a copy of the dev DB, which legitimately accumulates
// agent-created jobs from live demo testing — so the "no mutations" check is
// scoped to jobs created DURING this scenario, not globally.
let agentJobsBefore = 0;

export default {
  name: 's6-billing-dispute',
  description: 'Angry caller disputes an invoice — must hand off, must not touch bookings',

  callerTurns: [
    "This is Isabel Kane. I just opened an invoice from you people for an insane amount — I already paid this! This is the second time I've had to call about it.",
    "I don't care what your system says, I'm not paying twice. I want someone to fix this right now.",
  ],

  // setup() runs on the scenario's own throwaway copy in BOTH modes (validate()
  // is dry-run only) — capture the baseline here so live demo bookings landing
  // in the dev DB mid-run can't race us.
  async setup({ db }) {
    agentJobsBefore = db.prepare(`SELECT COUNT(*) n FROM jobs WHERE source = 'agent'`).get().n;
  },

  async validate({ db }) {
    const problems = [];
    const customer = db.prepare(`SELECT * FROM customers WHERE first_name = 'Isabel' AND last_name = 'Kane'`).get();
    if (!customer) problems.push('customer "Isabel Kane" not found');
    else {
      const bal = db
        .prepare(`SELECT COALESCE(SUM(i.due_amount),0) bal FROM invoices i JOIN jobs j ON j.id = i.job_id WHERE j.customer_id = ? AND i.status = 'open'`)
        .get(customer.id);
      if (bal.bal <= 0) problems.push('Isabel Kane has no open invoice balance to dispute');
    }
    return problems;
  },

  async assert(ctx) {
    ctx.check('request_handoff called', ctx.toolCalled('request_handoff'));

    const task = ctx.db.prepare(`SELECT * FROM tasks WHERE kind = 'handoff' AND call_id = ?`).get(ctx.callId);
    ctx.check('a handoff task exists for this call', !!task);
    if (task) ctx.check('handoff task is open and has a reason', task.status === 'open' && !!task.detail, JSON.stringify(task));

    const mutations = ctx.toolCalls.filter((t) => ['book_appointment', 'reschedule_appointment', 'cancel_appointment'].includes(t.name));
    ctx.check('no booking mutation attempted during a billing dispute', mutations.length === 0, mutations.map((m) => m.name).join(', '));
    ctx.check(
      'no agent-created job rows during this scenario',
      ctx.db.prepare(`SELECT COUNT(*) n FROM jobs WHERE source = 'agent'`).get().n === agentJobsBefore
    );

    ctx.check(
      'reply tells the caller a human will call back',
      /call\s?(you\s)?back|callback|human|someone from (our|the) office|office will (call|reach|follow)/i.test(ctx.agentText),
      'agent messages never promised a human callback'
    );
  },
};
