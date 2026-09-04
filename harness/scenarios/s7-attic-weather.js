// S7 — weather check for an attic job (DESIGN.md §5 scenario 7).
// The agent must call get_weather and ground its advice in the actual forecast
// numbers the tool returned (not generic heat talk).
export default {
  name: 's7-attic-weather',
  description: 'Should the crew start in the attic tomorrow morning? — must check the real forecast',

  callerTurns: [
    "Hi, quick scheduling question — we've got that attic job tomorrow morning. Should the guys plan to start up in the attic first thing, or is it going to be brutal up there?",
    "Makes sense, that's what I needed. Thanks!",
  ],

  async validate() {
    return []; // no DB fixtures needed; get_weather is keyless (Open-Meteo)
  },

  async assert(ctx) {
    ctx.check('get_weather called', ctx.toolCalled('get_weather'));

    const w = ctx.lastTool('get_weather')?.result;
    ctx.check('weather tool returned a forecast (no error)', !!w?.forecast, JSON.stringify(w).slice(0, 160));
    if (!w?.forecast) return;

    // The reply must reference at least one actual number from the forecast.
    const nums = [w.forecast.high_f, w.forecast.low_f, w.forecast.rain_chance_pct, w.forecast.max_wind_mph]
      .filter((n) => typeof n === 'number')
      .map((n) => String(Math.round(n)));
    ctx.check(
      'reply references the actual forecast numbers',
      nums.some((n) => ctx.finalReply.includes(n)),
      `none of [${nums.join(', ')}] found in: "${ctx.finalReply.slice(0, 160)}"`
    );
  },
};
