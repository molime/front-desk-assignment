import { useParams, Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useApi } from '../lib/useApi.js';
import { Card, EmptyState, Spinner, ErrorState, StatusBadge, Tag } from '../components/ui.jsx';
import { relTime } from '../lib/format.js';

// Crew member view: today's schedule + message inbox (crew-line messages).
export default function EmployeeDetail() {
  const { id } = useParams();
  const schedule = useApi(() => api.getEmployeeSchedule(id), [id]);
  const messages = useApi(() => api.getEmployeeMessages(id), [id]);

  if (schedule.loading) return <Spinner label="Loading crew member…" />;
  if (schedule.error) return <ErrorState error={schedule.error} onRetry={schedule.reload} />;
  const emp = schedule.data.employee;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-[12px] text-slate-400">
        <Link to="/employees" className="text-brand-700 hover:underline">Crew</Link> / {emp.name}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`Today's schedule · ${schedule.data.date}`}>
          {schedule.data.jobs.length === 0 && <EmptyState title="No jobs scheduled today" />}
          <div className="flex flex-col gap-2">
            {schedule.data.jobs.map((j) => (
              <Link key={j.job_id} to={`/jobs/${j.job_id}`} className="rounded-lg border border-slate-200 p-2.5 transition hover:border-brand-400">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-semibold text-brand-700">{j.window}</span>
                  <StatusBadge status={j.status} />
                </div>
                <div className="mt-0.5 text-[12px] text-slate-700">{j.description || 'Service visit'}</div>
                <div className="text-[11px] text-slate-400">{j.address}</div>
                {j.latest_note && <div className="mt-1 text-[11px] italic text-slate-500">“{j.latest_note}”</div>}
              </Link>
            ))}
          </div>
        </Card>

        <Card title={`Message inbox${messages.data ? ` (${messages.data.messages.length})` : ''}`}>
          {messages.loading && <Spinner />}
          {messages.data?.messages.length === 0 && (
            <EmptyState title="No messages" hint="Messages left via Marina's crew line land here." />
          )}
          <div className="flex flex-col gap-2">
            {messages.data?.messages.map((m) => (
              <div key={m.id} className="rounded-lg border border-slate-200 p-2.5">
                <div className="flex items-center gap-2">
                  <Tag tone={m.status === 'done' ? 'green' : 'amber'}>{m.status}</Tag>
                  <span className="text-[12px] font-medium text-slate-800">{m.title}</span>
                  <span className="ml-auto text-[10px] text-slate-400">{relTime(m.created_at)}</span>
                </div>
                {m.detail && <p className="mt-1 text-[12px] text-slate-600">{m.detail}</p>}
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
