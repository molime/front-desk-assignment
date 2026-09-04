// S8 — unknown model number → web search (DESIGN.md §5 scenario 8).
// The system has no equipment database; the agent must call web_search instead
// of inventing specs. Assertions are structural: search happened with the model
// number, and the reply actually engages with the model/brand. (DuckDuckGo
// sometimes returns localized spam for part-number queries — the agent is
// allowed to fall back on general knowledge, so no keyword overlap with the
// raw search snippets is required.)
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

    ctx.check(
      'reply actually addresses the model (brand/model/equipment type)',
      /trane|4twr5|heat pump|air condition|model/i.test(ctx.agentText),
      'agent messages never engaged with the Trane 4TWR5 question'
    );
  },
};
