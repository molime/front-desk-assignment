import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useApi } from '../lib/useApi.js';
import { useLiveEvent } from '../lib/live.jsx';
import { Card, EmptyState, Spinner, ErrorState, OutcomeBadge } from '../components/ui.jsx';
import { fmtDateTime, fmtDuration, fmtPhone } from '../lib/format.js';

export default function Calls() {
  const { data, error, loading, reload } = useApi(() => api.getCalls());
  useLiveEvent('call.ended', reload);
  useLiveEvent('call.started', reload);

  return (
    <Card title="Agent calls">
      {loading && <Spinner />}
      {error && <ErrorState error={error} onRetry={reload} />}
      {data && data.calls.length === 0 && (
        <EmptyState title="No calls yet" hint="Every call Marina answers is recorded here with its full audit trail." />
      )}
      {data && data.calls.length > 0 && (
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-100 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              <th className="pb-2 pr-4">Time</th>
              <th className="pb-2 pr-4">Caller</th>
              <th className="pb-2 pr-4">Duration</th>
              <th className="pb-2 pr-4">Outcome</th>
              <th className="pb-2">Summary</th>
            </tr>
          </thead>
          <tbody>
            {data.calls.map((c) => (
              <tr key={c.id} className="border-b border-slate-50 align-top last:border-0 hover:bg-slate-50/60">
                <td className="py-2.5 pr-4 text-[12px] text-slate-500 whitespace-nowrap">{fmtDateTime(c.started_at)}</td>
                <td className="py-2.5 pr-4">
                  <Link to={`/calls/${c.id}`} className="text-[13px] font-medium text-brand-700 hover:underline whitespace-nowrap">
                    {fmtPhone(c.from_number)}
                  </Link>
                  {c.status === 'active' && (
                    <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-rose-100 px-1.5 text-[9px] font-bold uppercase text-rose-700">
                      <span className="h-1 w-1 rounded-full bg-rose-500" /> live
                    </span>
                  )}
                </td>
                <td className="py-2.5 pr-4 text-[12px] text-slate-500">{fmtDuration(c.started_at, c.ended_at)}</td>
                <td className="py-2.5 pr-4"><OutcomeBadge outcome={c.outcome} /></td>
                <td className="max-w-md py-2.5 text-[12px] text-slate-600">
                  <span className="line-clamp-2">{c.summary ?? '—'}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
