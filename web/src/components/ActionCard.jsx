// Renders agent tool calls readably — used by the live action feed and the
// call-detail audit trail. Pure presentation over {tool, args, result}.
import { fmtTime, fmtDate } from '../lib/format.js';

const TOOL_LABELS = {
  find_customer: 'Found customer',
  get_customer_profile: 'Pulled profile',
  get_visit_history: 'Checked visit history',
  check_warranty: 'Checked warranty',
  get_upcoming_appointments: 'Checked upcoming appointments',
  check_availability: 'Checked availability',
  book_appointment: 'Booked appointment',
  reschedule_appointment: 'Rescheduled appointment',
  cancel_appointment: 'Canceled appointment',
  add_job_note: 'Left a job note',
  get_weather: 'Checked weather',
  web_search: 'Searched the web',
  request_handoff: 'Requested handoff',
};

/** One-line human summary: "book_appointment → Tue 10–12, assigned Elise Gilbert". */
export function actionHeadline(action) {
  const { tool, args = {}, result } = action;
  const label = TOOL_LABELS[tool] ?? tool;
  const r = result && typeof result === 'object' ? result : {};
  switch (tool) {
    case 'find_customer': {
      const n = r.results?.length ?? r.matches?.length;
      return `${label} "${args.query ?? ''}"${n != null ? ` — ${n} match${n === 1 ? '' : 'es'}` : ''}`;
    }
    case 'check_availability':
      return `${label} ${args.date ?? ''}${args.window_pref ? ` (${args.window_pref})` : ''}`;
    case 'book_appointment': {
      const tech = r.techs?.[0] ? `, assigned ${r.techs[0].first_name} ${r.techs[0].last_name}` : '';
      const when = r.scheduled_start
        ? `${fmtDate(r.scheduled_start)} ${fmtTime(r.scheduled_start)}–${fmtTime(r.scheduled_end)}`
        : `${args.date ?? ''} ${args.window ?? ''}`;
      return `${label} → ${when}${tech}`;
    }
    case 'reschedule_appointment':
      return `${label} → ${args.date ?? r.scheduled_start ?? ''} ${args.window ?? ''}`.trim();
    case 'cancel_appointment':
      return `${label}${args.reason ? ` — ${args.reason}` : ''}`;
    case 'add_job_note':
      return `${label} on ${args.job_id ?? ''}`;
    case 'get_weather':
      return `${label} for ${args.city_or_zip ?? ''}`;
    case 'web_search':
      return `${label}: "${args.query ?? ''}"`;
    case 'request_handoff':
      return `${label}${args.reason ? ` — ${args.reason}` : ''}`;
    default:
      return label;
  }
}

function KeyValues({ obj }) {
  const entries = Object.entries(obj ?? {}).filter(([, v]) => v != null && v !== '');
  if (entries.length === 0) return null;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-slate-400">{k}</dt>
          <dd className="truncate text-slate-700" title={typeof v === 'object' ? JSON.stringify(v) : String(v)}>
            {typeof v === 'object' ? JSON.stringify(v) : String(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Full audit-trail row: headline + args + result (collapsible JSON fallback). */
export function ActionCard({ action, live = false }) {
  return (
    <div className={`rounded-lg border p-2.5 ${live ? 'border-brand-200 bg-brand-50/50' : 'border-slate-200 bg-white'}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium text-slate-800">{actionHeadline(action)}</span>
        <span className="shrink-0 text-[10px] text-slate-400">{fmtTime(action.created_at)}</span>
      </div>
      <div className="mt-1.5 grid gap-2 text-[11px] sm:grid-cols-2">
        <div>
          <div className="mb-0.5 font-semibold uppercase tracking-wide text-slate-400">Args</div>
          <KeyValues obj={action.args} />
        </div>
        <div>
          <div className="mb-0.5 font-semibold uppercase tracking-wide text-slate-400">Result</div>
          <ResultSummary result={action.result} />
        </div>
      </div>
    </div>
  );
}

function ResultSummary({ result }) {
  if (result == null) return <span className="text-slate-400">—</span>;
  if (typeof result !== 'object') return <span className="text-slate-700">{String(result)}</span>;
  if (result.error) return <span className="text-rose-600">{result.error}</span>;

  // common shapes: job detail, availability, warranty, search results
  if (result.id && result.work_status) {
    return <KeyValues obj={{ job: result.id, status: result.work_status, window: `${fmtTime(result.scheduled_start)}–${fmtTime(result.scheduled_end)}`, techs: (result.techs ?? []).map((t) => `${t.first_name} ${t.last_name}`).join(', ') || null }} />;
  }
  if (result.windows) {
    return (
      <div className="flex flex-wrap gap-1">
        {result.windows.map((w) => (
          <span key={w.label} className={`rounded px-1.5 py-0.5 ring-1 ring-inset ${w.open ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : 'bg-slate-100 text-slate-400 ring-slate-200'}`}>
            {w.label} · {w.slots} free
          </span>
        ))}
      </div>
    );
  }
  if (result.summary) return <span className="text-slate-700">{result.summary}</span>;
  if (result.results) return <span className="text-slate-700">{result.results.length} result{result.results.length === 1 ? '' : 's'}</span>;
  return (
    <pre className="max-h-28 overflow-auto rounded bg-slate-50 p-1.5 text-[10px] text-slate-600">
      {JSON.stringify(result, null, 2)}
    </pre>
  );
}
