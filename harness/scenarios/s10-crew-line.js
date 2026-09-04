// S10 — crew line (DESIGN: employees call Marina as their assistant).
// A field tech asks for tomorrow's schedule (read-only by name), tries to
// complete a job WITHOUT a PIN (must be refused), then gives the PIN (must
// succeed), then leaves a message routed to a coworker.
// Tech, PIN, and coworker are read from the throwaway DB copy at module load
// (run-one.js imports the scenario with GBA_DB_PATH already set), so the
// scripted caller turns carry the real values.
import { todayEt, addDays, etToUtc } from '../../server/src/lib/time.js';

const { default: db } = await import('../../server/src/db/index.js');
const empSvc = await import('../../server/src/services/employeeService.js');

empSvc.ensureEmployeePins();

const tomorrow = addDays(todayEt(), 1);

// Pick the nearest day (today first) where some field tech has active jobs —
// the imported data's scheduled jobs cluster around "now", so a hardcoded
// "tomorrow" can be empty after a reseed.
function pickCrewDay() {
  for (let i = 0; i < 7; i++) {
    const date = addDays(todayEt(), i);
    const tech = db
      .prepare(
        `SELECT e.id, e.first_name, e.last_name, COUNT(*) AS n
         FROM employees e
         JOIN job_assignments ja ON ja.employee_id = e.id
         JOIN jobs j ON j.id = ja.job_id
         WHERE e.role = 'field tech' AND j.work_status IN ('scheduled','in progress')
           AND j.scheduled_start >= ? AND j.scheduled_start < ?
         GROUP BY e.id ORDER BY n DESC, e.last_name LIMIT 1`
      )
      .get(etToUtc(date, 0), etToUtc(addDays(date, 1), 0));
    if (tech) return { date, tech, dayWord: i === 0 ? 'today' : i === 1 ? 'tomorrow' : `on ${date}` };
  }
  return { date: tomorrow, tech: null, dayWord: 'tomorrow' };
}

const { date: crewDate, tech, dayWord } = pickCrewDay();

const coworker = db
  .prepare(`SELECT id, first_name, last_name FROM employees WHERE id != ? AND first_name != 'Team' ORDER BY last_name LIMIT 1`)
  .get(tech?.id ?? '');

const techName = tech ? `${tech.first_name} ${tech.last_name}` : 'UNKNOWN TECH';
const coworkerName = coworker ? `${coworker.first_name} ${coworker.last_name}` : 'UNKNOWN COWORKER';
const pin = tech ? empSvc.getPin(tech.id) : null;
const firstJob = tech ? empSvc.scheduleFor(tech.id, crewDate)[0] : null;

export default {
  name: 's10-crew-line',
  description: 'Crew line: tech asks for their day (read by name), job completion refused without PIN, succeeds with PIN, message routed to coworker',

  callerTurns: [
    `Hi, this is ${techName} — what's my day look like ${dayWord}?`,
    'Can you mark my first job done?',
    `My PIN is ${pin}.`,
    `Leave a message for ${coworkerName}: the capacitor came in.`,
  ],

  async validate({ db }) {
    const problems = [];
    if (!tech) problems.push('no field tech with active jobs in the next 7 days found');
    if (!pin) problems.push('no PIN in employee_auth for the chosen tech');
    if (!firstJob) problems.push(`chosen tech has no jobs on ${crewDate}`);
    if (!coworker) problems.push('no coworker found for message routing');
    if (pin && !/^\d{4}$/.test(pin)) problems.push(`PIN ${pin} is not 4 digits`);
    return problems;
  },

  async assert(ctx) {
    ctx.check('identify_employee called', ctx.toolCalled('identify_employee'));

    const sched = ctx.lastTool('get_my_schedule');
    ctx.check(`schedule returned for ${crewDate} with jobs`, sched?.result?.jobs?.length > 0, JSON.stringify(sched?.result ?? sched?.args ?? null).slice(0, 160));

    const completes = ctx.toolCalls.filter((t) => t.name === 'complete_job');
    const success = completes.find((t) => !t.result?.error && t.result?.completed);
    const successGlobalIdx = success ? ctx.toolCalls.indexOf(success) : -1;
    const pinIdx = ctx.toolCalls.findIndex((t) => t.name === 'identify_employee' && t.args?.pin && !t.result?.error);
    ctx.check('complete_job succeeded after PIN', !!success, JSON.stringify(completes.map((c) => c.result)).slice(0, 200));
    ctx.check(
      'no completion before the PIN was given',
      pinIdx >= 0 && successGlobalIdx > pinIdx,
      `PIN identify at tool index ${pinIdx}, successful complete at ${successGlobalIdx}`
    );
    // "Refused politely" can be a verbal PIN ask (agent never calls the tool) or
    // a tool-level {error} denial — both are correct; what matters is the job
    // was NOT completed pre-PIN and the caller was asked for the PIN.
    ctx.check(
      'mutation refused politely pre-PIN (PIN requested or tool denial)',
      /\bpin\b/i.test(ctx.agentText) || completes.some((t) => t.result?.error),
      completes[0] ? JSON.stringify(completes[0].result).slice(0, 120) : 'no pre-PIN complete_job attempt'
    );

    if (success) {
      const jobId = success.result.job_id;
      const job = ctx.db.prepare(`SELECT work_status, completed_at FROM jobs WHERE id = ?`).get(jobId);
      ctx.check('job is complete unrated with completed_at set', job?.work_status === 'complete unrated' && !!job.completed_at, JSON.stringify(job));
      ctx.check('completed job is the one from the schedule read', jobId === firstJob?.job_id, `${jobId} vs ${firstJob?.job_id}`);
    }

    ctx.check('leave_message called', ctx.toolCalled('leave_message'));
    const msgTask = ctx.db
      .prepare(`SELECT * FROM tasks WHERE call_id = ? AND kind = 'message' ORDER BY created_at DESC LIMIT 1`)
      .get(ctx.callId);
    ctx.check('message task exists, routed to the coworker', !!msgTask && msgTask.assigned_employee_id === coworker?.id, JSON.stringify(msgTask));
    ctx.check('message detail carried', !!msgTask && /capacitor/i.test(msgTask.detail ?? ''), JSON.stringify(msgTask?.detail));
    ctx.check('message title names the sender', !!msgTask && new RegExp(tech.first_name, 'i').test(msgTask.title ?? ''), JSON.stringify(msgTask?.title));
  },
};
