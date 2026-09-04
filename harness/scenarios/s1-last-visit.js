// S1 — "when were you last at 89 Harborlight Shores?" (DESIGN.md §5 scenario 1).
// Caller identifies as a property manager; the agent must find the customer by
// address, pull visit history, and answer with the real last visit.
import { mentionsDate, keywordsOf } from '../util.js';

export default {
  name: 's1-last-visit',
  description: 'Property manager asks when we were last at 89 Harborlight Shores and what we did',

  callerTurns: [
    "Hi, this is Dana calling from Windward Hospitality. Quick question — when were you guys last out at 89 Harborlight Shores, and what did you do there?",
    "That's all I needed, thanks so much.",
  ],

  async validate({ db }) {
    const problems = [];
    const addr = db.prepare(`SELECT * FROM customer_addresses WHERE street LIKE '89 Harborlight%'`).get();
    if (!addr) problems.push('no address matching "89 Harborlight%"');
    else {
      const jobs = db.prepare(`SELECT COUNT(*) n FROM jobs WHERE address_id = ? AND completed_at IS NOT NULL`).get(addr.id);
      if (jobs.n === 0) problems.push('89 Harborlight address has no completed jobs');
    }
    return problems;
  },

  async assert(ctx) {
    ctx.check('find_customer called', ctx.toolCalled('find_customer'));
    ctx.check('get_visit_history called', ctx.toolCalled('get_visit_history'));

    // history must be for the customer that actually owns 89 Harborlight
    const found = ctx.toolResults('find_customer').flatMap((r) => r.matches ?? []);
    const owner = found.find((m) => (m.addresses ?? []).some((a) => /89\s+Harborlight/i.test(a.address ?? '')));
    ctx.check('find_customer surfaced the owner of 89 Harborlight Shores', !!owner, JSON.stringify(found).slice(0, 200));
    const hist = ctx.lastTool('get_visit_history');
    ctx.check(
      'get_visit_history queried for that customer',
      owner && hist?.args?.customer_id === owner.customer_id,
      `queried ${hist?.args?.customer_id}, owner is ${owner?.customer_id}`
    );

    const last = hist?.result?.visits?.[0];
    ctx.check('visit history returned at least one visit', !!last);
    if (last) {
      const mentionedDate = mentionsDate(ctx.agentText, last.date);
      const mentionedWork = keywordsOf(last.description).some((w) => ctx.agentText.toLowerCase().includes(w));
      ctx.check(
        'reply references the actual last visit (date or work performed)',
        mentionedDate || mentionedWork,
        `last visit ${last.date} "${last.description}" not reflected in agent messages`
      );
    }
  },
};
