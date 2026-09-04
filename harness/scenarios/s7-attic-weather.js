// S7 — weather check for an attic job (DESIGN.md §5 scenario 7).
// The agent must call get_weather and ground its advice in the actual forecast
// numbers the tool returned (not generic heat talk). General weather questions
// aren't customer-specific, so no identity is required — but if the agent asks,
// the caller answers naturally with a real tech name and address.
export default {
  name: 's7-attic-weather',
  description: 'Should the crew start in the attic tomorrow morning? — must check the real forecast',

  callerTurns: [
    "Hi, quick scheduling question — we've got an attic job at 932 Jacaranda Hollow tomorrow morning. Should the guys plan to start up in the attic first thing, or is it going to be brutal up there?",
    "It's Mike, one of the techs. The address is 932 Jacaranda Hollow in Miami Beach.",
    "No need to book anything — the crew just wanted the weather. Thanks!",
  ],

  async validate({ db }) {
    const problems = [];
    if (!db.prepare(`SELECT * FROM customer_addresses WHERE street LIKE '932 Jacaranda%'`).get()) {
      problems.push('no address matching "932 Jacaranda%"');
    }
    return problems;
  },

  async assert(ctx) {
    ctx.check('get_weather called', ctx.toolCalled('get_weather'));

    const w = ctx.lastTool('get_weather')?.result;
    ctx.check('weather tool returned a forecast (no error)', !!w?.forecast, JSON.stringify(w).slice(0, 160));
    if (!w?.forecast) return;

    // The reply must reference at least one actual number from the tool result
    // (forecast OR current conditions). Accept the forms a voice agent would
    // speak: rounded ("88") or one decimal ("87.8").
    const raw = [
      w.forecast.high_f, w.forecast.low_f, w.forecast.rain_chance_pct, w.forecast.max_wind_mph,
      w.current?.temp_f, w.current?.feels_like_f, w.current?.humidity_pct, w.current?.wind_mph,
    ].filter((n) => typeof n === 'number');
    const nums = [...new Set(raw.flatMap((n) => [String(Math.round(n)), Number(n.toFixed(1)).toString()]))];
    ctx.check(
      'reply references the actual weather numbers returned',
      nums.some((n) => ctx.agentText.includes(n)),
      `none of [${nums.join(', ')}] found in the agent messages`
    );
  },
};
