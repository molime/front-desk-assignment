import { useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { useApi } from '../lib/useApi.js';
import { useLiveEvent } from '../lib/live.jsx';
import { Card, EmptyState, Spinner, ErrorState } from '../components/ui.jsx';
import JobCard from '../components/JobCard.jsx';
import { addDays, fmtDay, todayEt } from '../lib/format.js';

// Week view: tech rows × day columns (Mon–Sat emphasis, Sunday dimmed).
export default function Schedule() {
  const [start, setStart] = useState(() => weekStart(todayEt()));
  const { data, error, loading, reload } = useApi(() => api.getWeekSchedule(start), [start]);
  useLiveEvent('job.created', reload);
  useLiveEvent('job.updated', reload);

  const today = todayEt();

  // pivot: day-major payload -> tech rows
  const techRows = useMemo(() => {
    if (!data) return [];
    const rows = new Map();
    for (const day of data.days) {
      for (const t of day.techs) {
        if (!rows.has(t.employee_id)) rows.set(t.employee_id, { tech: t.tech, byDate: {} });
        rows.get(t.employee_id).byDate[day.date] = t.jobs;
      }
      for (const j of day.unassigned) {
        if (!rows.has('__unassigned')) rows.set('__unassigned', { tech: 'Unassigned', byDate: {} });
        (rows.get('__unassigned').byDate[day.date] ??= []).push(j);
      }
    }
    return [...rows.values()];
  }, [data]);

  return (
    <Card
      title="Week schedule"
      action={
        <div className="flex items-center gap-1">
          <NavBtn onClick={() => setStart(addDays(start, -7))}>← Prev</NavBtn>
          <NavBtn onClick={() => setStart(weekStart(todayEt()))} disabled={start === weekStart(today)}>This week</NavBtn>
          <NavBtn onClick={() => setStart(addDays(start, 7))}>Next →</NavBtn>
        </div>
      }
      className="overflow-x-auto"
    >
      {loading && <Spinner label="Loading week…" />}
      {error && <ErrorState error={error} onRetry={reload} />}
      {data && techRows.length === 0 && (
        <EmptyState title="Nothing scheduled this week" hint="Agent bookings appear here live." />
      )}
      {data && techRows.length > 0 && (
        <table className="w-full min-w-[1100px] border-collapse">
          <thead>
            <tr>
              <th className="w-36 p-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400">Tech</th>
              {data.days.map((d, i) => (
                <th
                  key={d.date}
                  className={`p-1.5 text-left text-[11px] font-semibold ${
                    d.date === today ? 'text-brand-700' : i === 6 ? 'text-slate-300' : 'text-slate-500'
                  }`}
                >
                  {fmtDay(d.date)}
                  {d.date === today && <span className="ml-1 rounded bg-brand-100 px-1 text-[9px] font-bold uppercase">today</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {techRows.map((row) => (
              <tr key={row.tech} className="align-top">
                <td className="border-t border-slate-100 p-1.5 text-[12px] font-medium text-slate-700">{row.tech}</td>
                {data.days.map((d, i) => (
                  <td
                    key={d.date}
                    className={`border-t border-slate-100 p-1 ${i === 6 ? 'bg-slate-50/60' : ''} ${d.date === today ? 'bg-brand-50/40' : ''}`}
                  >
                    <div className="flex min-h-[2rem] flex-col gap-1">
                      {(row.byDate[d.date] ?? []).map((j) => <JobCard key={j.id} job={j} dense />)}
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function NavBtn({ children, onClick, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/** Monday of the week containing dateStr (YYYY-MM-DD). */
function weekStart(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const dow = d.getUTCDay(); // 0 Sun … 6 Sat
  return addDays(dateStr, dow === 0 ? -6 : 1 - dow);
}
