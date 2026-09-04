// S5 — tech asks what was done last time at an address with rich notes
// (DESIGN.md §5 scenario 5). The agent must resolve the address to a customer,
// pull visit history, and repeat the actual work from the notes.
import { keywordsOf } from '../util.js';

export default {
  name: 's5-visit-notes',
  description: 'Tech heading to 932 Jacaranda Hollow asks what was done there last time',

  callerTurns: [
    "Hey, it's Mike — one of the techs. I'm about to head out to 932 Jacaranda Hollow. What did we do there last time? Anything in the notes I should know?",
    'Got it, thanks.',
  ],

  async validate({ db }) {
    const problems = [];
    const addr = db.prepare(`SELECT * FROM customer_addresses WHERE street LIKE '932 Jacaranda%'`).get();
    if (!addr) problems.push('no address matching "932 Jacaranda%"');
    else {
      // several address rows can share the street (dupes/units) — any will do
      const note = db
        .prepare(
          `SELECT n.content FROM job_notes n JOIN jobs j ON j.id = n.job_id
           JOIN customer_addresses a ON a.id = j.address_id
           WHERE a.street LIKE '932 Jacaranda%' AND (n.content LIKE '%attic%' OR n.content LIKE '%condensate%') LIMIT 1`
        )
        .get();
      if (!note) problems.push('no attic/condensate notes on record for 932 Jacaranda Hollow');
    }
    return problems;
  },

  async assert(ctx) {
    ctx.check('find_customer called', ctx.toolCalled('find_customer'));
    ctx.check('get_visit_history called', ctx.toolCalled('get_visit_history'));

    const hist = ctx.lastTool('get_visit_history')?.result;
    const visits = hist?.visits ?? [];
    ctx.check('visit history returned visits', visits.length > 0);

    // The reply must repeat real work from the notes the tool returned —
    // derive the expected keywords from the tool result itself, not hardcoded.
    const noteText = visits.flatMap((v) => v.notes ?? []).join(' ');
    const keys = keywordsOf(noteText);
    const reply = ctx.finalReply.toLowerCase();
    ctx.check(
      'reply mentions actual work from the notes',
      keys.some((k) => reply.includes(k)),
      `expected one of [${keys.slice(0, 8).join(', ')}] in: "${ctx.finalReply.slice(0, 160)}"`
    );
  },
};
