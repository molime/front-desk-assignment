// S8 — unknown model number → web search (DESIGN.md §5 scenario 8).
// The system has no equipment database; the agent must admit that implicitly
// by calling web_search and grounding its answer in the results.
import { keywordsOf } from '../util.js';

export default {
  name: 's8-unknown-model',
  description: 'Caller reads an unknown Trane model number — must web_search, not invent specs',

  callerTurns: [
    "Hi — I'm looking at our unit and the model plate says Trane 4TWR5. Do you know anything about that model? I can't find it anywhere.",
    "That's helpful, thanks.",
  ],

  async validate() {
    return []; // no DB fixtures needed; web_search is keyless (DuckDuckGo)
  },

  async assert(ctx) {
    ctx.check('web_search called', ctx.toolCalled('web_search'));

    const q = ctx.lastTool('web_search')?.args?.query ?? '';
    ctx.check('search query references the model number', /trane|4twr5/i.test(q), `query was "${q}"`);

    const results = ctx.lastTool('web_search')?.result?.results ?? [];
    if (results.length > 0) {
      // Reply must share real vocabulary with what the search returned.
      const keys = keywordsOf(`${results[0].title ?? ''} ${results[0].snippet ?? ''}`);
      const reply = ctx.finalReply.toLowerCase();
      ctx.check(
        'reply is grounded in the search results',
        /trane|4twr5/i.test(ctx.finalReply) && keys.some((k) => reply.includes(k)),
        `expected overlap with [${keys.slice(0, 8).join(', ')}] in: "${ctx.finalReply.slice(0, 160)}"`
      );
    }
  },
};
