import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useApi } from '../lib/useApi.js';
import { useLiveEvent } from '../lib/live.jsx';
import { Card, EmptyState, Spinner, ErrorState, Tag } from '../components/ui.jsx';
import { relTime } from '../lib/format.js';

// Handoff / follow-up queue (DESIGN.md §4).
export default function Tasks() {
  const [filter, setFilter] = useState('open');
  const { data, error, loading, reload, setData } = useApi(() => api.getTasks(filter), [filter]);
  useLiveEvent('task.created', () => { if (filter === 'open') reload(); });

  const done = async (id) => {
    if (filter === 'open') setData((d) => ({ tasks: d.tasks.filter((t) => t.id !== id) }));
    try { await api.completeTask(id); } catch { reload(); }
  };

  return (
    <Card
      title="Tasks"
      action={
        <div className="flex gap-1">
          {['open', 'done', 'all'].map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-lg px-2.5 py-1 text-[11px] font-medium capitalize transition ${
                filter === f ? 'bg-brand-100 text-brand-800' : 'text-slate-500 hover:bg-slate-100'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      }
    >
      {loading && <Spinner />}
      {error && <ErrorState error={error} onRetry={reload} />}
      {data && data.tasks.length === 0 && (
        <EmptyState
          title={filter === 'open' ? 'Queue is clear' : 'No tasks'}
          hint="Marina opens a handoff task whenever a call needs a human."
        />
      )}
      <div className="flex flex-col gap-2">
        {data?.tasks.map((t) => (
          <div key={t.id} className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-3">
            {t.status === 'open' ? (
              <button
                onClick={() => done(t.id)}
                title="Mark done"
                className="mt-0.5 h-[18px] w-[18px] shrink-0 rounded border border-slate-300 transition hover:border-emerald-500 hover:bg-emerald-50"
              />
            ) : (
              <span className="mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded bg-emerald-100 text-[10px] text-emerald-700">✓</span>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Tag tone={t.kind === 'handoff' ? 'amber' : 'slate'}>{t.kind}</Tag>
                <span className={`text-[13px] font-medium ${t.status === 'done' ? 'text-slate-400 line-through' : 'text-slate-800'}`}>
                  {t.title}
                </span>
                <span className="text-[10px] text-slate-400">{relTime(t.created_at)}</span>
              </div>
              {t.detail && <p className="mt-0.5 text-[12px] text-slate-500">{t.detail}</p>}
              <div className="mt-1 flex gap-3 text-[11px]">
                {t.call_id && <Link to={`/calls/${t.call_id}`} className="text-brand-700 hover:underline">call →</Link>}
                {t.job_id && <Link to={`/jobs/${t.job_id}`} className="text-brand-700 hover:underline">job →</Link>}
                {t.customer_id && <Link to={`/customers/${t.customer_id}`} className="text-brand-700 hover:underline">customer →</Link>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
