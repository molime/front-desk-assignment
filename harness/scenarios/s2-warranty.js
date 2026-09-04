// S2 — warranty question on a recent install (DESIGN.md §5 scenario 2).
// Felix Anders had a system install tagged "Registration Complete" completed
// 2026-07-31 → the 1-year labor warranty is active. The agent must call
// check_warranty and answer consistently with the verdict.
export default {
  name: 's2-warranty',
  description: 'Caller with a recent "Registration Complete" install asks if they are still under warranty',

  callerTurns: [
    'Hi, this is Felix Anders. You folks installed a new system at my place earlier this year — are we still under warranty if something goes wrong?',
    'The house on Glasswort Road. So if the compressor quits next month, labor is covered?',
    "Great, that's all I needed. Thanks!",
  ],

  async validate({ db }) {
    const problems = [];
    const customer = db.prepare(`SELECT * FROM customers WHERE first_name = 'Felix' AND last_name = 'Anders'`).get();
    if (!customer) problems.push('customer "Felix Anders" not found');
    else {
      const install = db
        .prepare(
          `SELECT * FROM jobs WHERE customer_id = ? AND tags LIKE '%"Registration Complete"%'
           AND description LIKE '%nstall%' AND completed_at IS NOT NULL ORDER BY completed_at DESC`
        )
        .get(customer.id);
      if (!install) problems.push('no "Registration Complete" install for Felix Anders');
      else if (Date.now() - new Date(install.completed_at) > 330 * 86400e3) {
        problems.push(`install ${install.completed_at} is nearly a year old — warranty verdict no longer reliably active`);
      }
    }
    return problems;
  },

  async assert(ctx) {
    ctx.check('find_customer called', ctx.toolCalled('find_customer'));
    ctx.check('check_warranty called', ctx.toolCalled('check_warranty'));

    const w = ctx.lastTool('check_warranty')?.result;
    ctx.check('check_warranty returned a verdict (no error)', w && !w.error, JSON.stringify(w).slice(0, 160));
    if (!w || w.error) return;

    // Reply must be consistent with the verdict the tool actually returned.
    const reply = ctx.finalReply.toLowerCase();
    if (w.labor_warranty.active) {
      ctx.check(
        'verdict is ACTIVE and reply says covered',
        /covered|active|under warranty|yes|good news/.test(reply) && !/not covered|no longer covered|has expired|warranty expired/.test(reply),
        `verdict active but reply was: "${ctx.finalReply.slice(0, 160)}"`
      );
    } else {
      ctx.check(
        'verdict is INACTIVE and reply says not covered',
        /not covered|no longer|expired/.test(reply),
        `verdict inactive but reply was: "${ctx.finalReply.slice(0, 160)}"`
      );
    }
  },
};
