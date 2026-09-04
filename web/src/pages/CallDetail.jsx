import { useParams, Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useApi } from '../lib/useApi.js';
import { Card, EmptyState, Spinner, ErrorState, OutcomeBadge, Tag } from '../components/ui.jsx';
import { ActionCard } from '../components/ActionCard.jsx';
import { fmtDateTime, fmtDuration, fmtPhone, fmtTime } from '../lib/format.js';

// Call record: transcript side-by-side with the ACTION AUDIT TRAIL — every
// tool Marina called, with args + result ("what did it promise anyone?").
export default function CallDetail() {
  const { id } = useParams();
  const { data: call, error, loading, reload } = useApi(() => api.getCall(id), [id]);

  if (loading) return <Spinner label="Loading call…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!call) return null;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-[12px] text-slate-400">
        <Link to="/calls" className="text-brand-700 hover:underline">Calls</Link> / {fmtPhone(call.from_number)}
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div>
            <div className="text-lg font-semibold text-slate-900">{fmtPhone(call.from_number)}</div>
            <div className="text-[12px] text-slate-400">
              {fmtDateTime(call.started_at)} · {fmtDuration(call.started_at, call.ended_at)}
            </div>
          </div>
          <OutcomeBadge outcome={call.outcome} />
          {call.handoff_reason && <Tag tone="amber">handoff: {call.handoff_reason}</Tag>}
          {call.summary && <p className="w-full text-[13px] leading-relaxed text-slate-600">{call.summary}</p>}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`Transcript (${call.transcripts.length})`}>
          {call.transcripts.length === 0 && <EmptyState title="No transcript captured" />}
          <div className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto">
            {call.transcripts.map((t, i) => (
              <div
                key={i}
                className={`max-w-[85%] rounded-lg px-3 py-2 text-[13px] leading-snug ${
                  t.speaker === 'agent'
                    ? 'self-start bg-brand-100 text-brand-900'
                    : 'self-end bg-slate-100 text-slate-700'
                }`}
              >
                <span className="mb-0.5 flex items-center gap-2 text-[9px] font-bold uppercase tracking-wider opacity-60">
                  {t.speaker === 'agent' ? 'Marina' : 'Caller'} · {fmtTime(t.created_at)}
                </span>
                {t.text}
              </div>
            ))}
          </div>
        </Card>

        <Card title={`Action audit trail (${call.agent_actions.length})`} className="ring-1 ring-brand-100">
          {call.agent_actions.length === 0 && (
            <EmptyState title="No tools used on this call" hint="Everything Marina does is logged here." />
          )}
          <div className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto">
            {call.agent_actions.map((a, i) => <ActionCard key={i} action={a} />)}
          </div>
        </Card>
      </div>
    </div>
  );
}
