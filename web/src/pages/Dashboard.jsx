import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useApi } from '../lib/useApi.js';
import { useLiveEvent } from '../lib/live.jsx';
import { Card, EmptyState, Spinner, ErrorState, Tag } from '../components/ui.jsx';
import JobCard from '../components/JobCard.jsx';
import { ActionCard } from '../components/ActionCard.jsx';
import { fmtDate, fmtElapsed, fmtPhone, relTime } from '../lib/format.js';

export default function Dashboard() {
  return (
    <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr_0.9fr] lg:grid-cols-2">
      <TodaySchedule />
      <LiveCallPanel />
      <HandoffPanel />
    </div>
  );
}

// --- (a) today's schedule: one column per tech -------------------------------
function TodaySchedule() {
  const { data, error, loading, reload } = useApi(() => api.getTodaySchedule());
  // live: an agent booking during a call lands here without refresh
  useLiveEvent('job.created', reload);
  useLiveEvent('job.updated', reload);

  return (
    <Card
      title={`Today's schedule${data?.date ? ` · ${fmtDate(data.date)}` : ''}`}
      action={<Link to="/schedule" className="text-[11px] font-medium text-brand-700 hover:underline">Week view →</Link>}
      className="xl:row-span-1"
    >
      {loading && <Spinner />}
      {error && <ErrorState error={error} onRetry={reload} />}
      {data && data.techs.length === 0 && data.unassigned.length === 0 && (
        <EmptyState title="Nothing scheduled today" hint="Agent bookings will appear here live." />
      )}
      {data && (
        <div className="grid gap-3 sm:grid-cols-2">
          {data.techs.map((t) => (
            <div key={t.employee_id}>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[12px] font-semibold text-slate-700">{t.tech}</span>
                <span className="text-[10px] text-slate-400">{t.jobs.length} job{t.jobs.length === 1 ? '' : 's'}</span>
              </div>
              <div className="flex flex-col gap-1.5">
                {t.jobs.map((j) => <JobCard key={j.id} job={j} />)}
              </div>
            </div>
          ))}
          {data.unassigned.length > 0 && (
            <div>
              <div className="mb-1.5 text-[12px] font-semibold text-amber-700">Unassigned</div>
              <div className="flex flex-col gap-1.5">
                {data.unassigned.map((j) => <JobCard key={j.id} job={j} />)}
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// --- (b) live call panel ------------------------------------------------------
function LiveCallPanel() {
  const [liveCall, setLiveCall] = useState(null); // {call, transcripts[], actions[]}
  const [now, setNow] = useState(Date.now());
  const transcriptRef = useRef(null);
  const recent = useApi(() => api.getCalls());

  useLiveEvent('call.started', (e) => {
    setLiveCall({ call: e.payload.call ?? e.payload, transcripts: [], actions: [] });
  });
  useLiveEvent('call.transcript', (e) => {
    setLiveCall((c) => c ? { ...c, transcripts: [...c.transcripts, e.payload] } : c);
  });
  useLiveEvent('call.action', (e) => {
    setLiveCall((c) => c ? { ...c, actions: [...c.actions, e.payload] } : c);
  });
  useLiveEvent('call.ended', (e) => {
    setLiveCall((c) => c ? { ...c, call: { ...c.call, ...(e.payload.call ?? e.payload), ended: true } } : c);
    recent.reload();
  });

  useEffect(() => {
    if (!liveCall || liveCall.call.ended) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [liveCall]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' });
  }, [liveCall?.transcripts?.length]);

  const lastCall = recent.data?.calls?.[0];
  const active = liveCall && !liveCall.call.ended;

  return (
    <Card
      title="Marina · phone line"
      action={active && (
        <span className="on-air inline-flex items-center gap-1.5 rounded-full bg-rose-600 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest text-white">
          <span className="h-1.5 w-1.5 rounded-full bg-white" /> On air
        </span>
      )}
    >
      {liveCall ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[15px] font-semibold text-slate-900">{fmtPhone(liveCall.call.from_number)}</div>
              <div className="text-[11px] text-slate-400">
                {active ? `elapsed ${fmtElapsed(liveCall.call.started_at, now)}` : `call ended · ${relTime(liveCall.call.ended_at)}`}
              </div>
            </div>
            <Link to={`/calls/${liveCall.call.id}`} className="text-[11px] font-medium text-brand-700 hover:underline">
              Full record →
            </Link>
          </div>

          <div ref={transcriptRef} className="flex max-h-56 flex-col gap-1.5 overflow-y-auto rounded-lg bg-slate-50 p-2.5">
            {liveCall.transcripts.length === 0 && (
              <div className="py-4 text-center text-[12px] text-slate-400">
                {active ? 'Listening…' : 'No transcript captured.'}
              </div>
            )}
            {liveCall.transcripts.map((t, i) => (
              <div
                key={t.id ?? i}
                className={`max-w-[85%] rounded-lg px-2.5 py-1.5 text-[12px] leading-snug ${
                  t.speaker === 'agent'
                    ? 'self-start bg-brand-100 text-brand-900'
                    : 'self-end bg-white text-slate-700 ring-1 ring-slate-200'
                }`}
              >
                <span className="mb-0.5 block text-[9px] font-bold uppercase tracking-wider opacity-60">
                  {t.speaker === 'agent' ? 'Marina' : 'Caller'}
                </span>
                {t.text}
              </div>
            ))}
          </div>

          {liveCall.actions.length > 0 && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-slate-400">Actions</div>
              <div className="flex max-h-44 flex-col gap-1.5 overflow-y-auto">
                {liveCall.actions.map((a, i) => <ActionCard key={a.id ?? i} action={a} live />)}
              </div>
            </div>
          )}
          {liveCall.call.ended && liveCall.call.summary && (
            <p className="rounded-lg bg-slate-50 p-2.5 text-[12px] text-slate-600">{liveCall.call.summary}</p>
          )}
        </div>
      ) : (
        // idle: most recent call summary
        <div>
          {recent.loading && <Spinner />}
          {!recent.loading && !lastCall && (
            <EmptyState title="No calls yet" hint="When Marina answers, the live transcript shows up here." />
          )}
          {lastCall && (
            <div>
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-slate-400">Most recent call</div>
              <div className="flex items-center justify-between">
                <span className="text-[14px] font-semibold text-slate-800">{fmtPhone(lastCall.from_number)}</span>
                <span className="text-[11px] text-slate-400">{relTime(lastCall.started_at)}</span>
              </div>
              {lastCall.outcome && <div className="mt-1"><Tag tone="brand">{lastCall.outcome}</Tag></div>}
              <p className="mt-2 text-[12px] leading-relaxed text-slate-600">{lastCall.summary ?? 'No summary recorded.'}</p>
              <Link to={`/calls/${lastCall.id}`} className="mt-2 inline-block text-[11px] font-medium text-brand-700 hover:underline">
                Full record →
              </Link>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// --- (c) open handoffs / tasks -------------------------------------------------
function HandoffPanel() {
  const { data, error, loading, reload, setData } = useApi(() => api.getTasks('open'));
  useLiveEvent('task.created', reload);

  const done = async (id) => {
    setData((d) => ({ tasks: d.tasks.filter((t) => t.id !== id) }));
    try { await api.completeTask(id); } catch { reload(); }
  };

  return (
    <Card
      title="Open handoffs & follow-ups"
      action={<Link to="/tasks" className="text-[11px] font-medium text-brand-700 hover:underline">All tasks →</Link>}
    >
      {loading && <Spinner />}
      {error && <ErrorState error={error} onRetry={reload} />}
      {data && data.tasks.length === 0 && <EmptyState title="Queue is clear" hint="Handoffs from Marina land here." />}
      <div className="flex flex-col gap-2">
        {data?.tasks.slice(0, 8).map((t) => (
          <div key={t.id} className="flex items-start gap-2 rounded-lg border border-slate-200 bg-white p-2.5">
            <button
              onClick={() => done(t.id)}
              title="Mark done"
              className="mt-0.5 h-4 w-4 shrink-0 rounded border border-slate-300 transition hover:border-emerald-500 hover:bg-emerald-50"
            />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <Tag tone={t.kind === 'handoff' ? 'amber' : 'slate'}>{t.kind}</Tag>
                <span className="text-[10px] text-slate-400">{relTime(t.created_at)}</span>
              </div>
              <div className="mt-0.5 text-[12px] font-medium text-slate-800">{t.title}</div>
              {t.detail && <div className="text-[11px] text-slate-500">{t.detail}</div>}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
