import { useParams, Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useApi } from '../lib/useApi.js';
import { useLiveEvent } from '../lib/live.jsx';
import { Card, EmptyState, Spinner, ErrorState, StatusBadge, Tag } from '../components/ui.jsx';
import { customerName, fmtDateTime, fmtWindow, fullAddress, money } from '../lib/format.js';

export default function JobDetail() {
  const { id } = useParams();
  const { data: job, error, loading, reload } = useApi(() => api.getJob(id), [id]);
  useLiveEvent('note.added', (e) => { if (e.payload?.job_id === id) reload(); });
  useLiveEvent('job.updated', (e) => { if (e.payload?.job?.id === id) reload(); });

  if (loading) return <Spinner label="Loading job…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!job) return null;

  const notes = [...(job.notes ?? [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  return (
    <div className="flex flex-col gap-4">
      <div className="text-[12px] text-slate-400">
        <Link to="/schedule" className="text-brand-700 hover:underline">Schedule</Link> / Job {job.invoice_number ?? job.id.slice(0, 12)}
      </div>

      <Card>
        <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
          <div className="min-w-0 max-w-xl">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-bold text-slate-900">{job.description ?? 'Service visit'}</h1>
              <StatusBadge status={job.work_status} />
              {job.source === 'agent' && <Tag tone="brand">booked by Marina</Tag>}
            </div>
            <div className="mt-1 text-[13px] text-slate-500">
              <Link to={`/customers/${job.customer?.id}`} className="font-medium text-brand-700 hover:underline">
                {customerName(job.customer)}
              </Link>
              {job.customer?.company && ` · ${job.customer.company}`}
            </div>
            <div className="text-[12px] text-slate-400">{fullAddress(job.address)}</div>
          </div>
          <Stat label="Scheduled" value={job.scheduled_start ? `${fmtDateTime(job.scheduled_start)} · ${fmtWindow(job)}` : 'unscheduled'} />
          <Stat label="Techs" value={job.techs.length ? job.techs.map((t) => `${t.first_name} ${t.last_name}`).join(', ') : 'unassigned'} />
          <Stat label="Total" value={money(job.total_amount)} />
          {job.outstanding_balance > 0 && <Stat label="Outstanding" value={money(job.outstanding_balance)} tone="text-rose-600" />}
          {job.tags?.length > 0 && (
            <div className="flex flex-wrap gap-1">{job.tags.map((t) => <Tag key={t}>{t}</Tag>)}</div>
          )}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* notes thread */}
        <Card title={`Notes (${notes.length})`}>
          {notes.length === 0 && <EmptyState title="No notes yet" hint="Marina's notes show up here, flagged as agent-authored." />}
          <div className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto">
            {notes.map((n) => (
              <div
                key={n.id}
                className={`rounded-lg border p-2.5 text-[12px] leading-relaxed ${
                  n.author === 'agent'
                    ? 'border-brand-200 bg-brand-50/60 text-brand-950'
                    : 'border-slate-100 bg-slate-50 text-slate-700'
                }`}
              >
                <div className="mb-1 flex items-center gap-2 text-[9px] font-bold uppercase tracking-wider">
                  <span className={n.author === 'agent' ? 'text-brand-700' : 'text-slate-400'}>
                    {n.author === 'agent' ? 'Marina (agent)' : n.author}
                  </span>
                  <span className="font-normal normal-case text-slate-400">{fmtDateTime(n.created_at)}</span>
                </div>
                <p className="whitespace-pre-wrap">{n.content}</p>
              </div>
            ))}
          </div>
        </Card>

        {/* invoices */}
        <Card title={`Invoices (${job.invoices.length})`}>
          {job.invoices.length === 0 && <EmptyState title="No invoices on this job" />}
          <div className="flex flex-col gap-3">
            {job.invoices.map((inv) => (
              <div key={inv.id} className="rounded-lg border border-slate-200">
                <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
                  <span className="text-[13px] font-semibold text-slate-700">Invoice #{inv.invoice_number}</span>
                  <div className="flex items-center gap-2">
                    <Tag tone={inv.status === 'paid' ? 'green' : inv.status === 'open' ? 'amber' : 'slate'}>{inv.status}</Tag>
                    <span className="text-[13px] font-semibold text-slate-900">{money(inv.amount)}</span>
                  </div>
                </div>
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                      <th className="px-3 pt-2">Item</th>
                      <th className="px-2 pt-2">Type</th>
                      <th className="px-2 pt-2 text-right">Qty</th>
                      <th className="px-2 pt-2 text-right">Unit</th>
                      <th className="px-3 pt-2 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inv.items.map((it) => (
                      <tr key={it.id} className="border-t border-slate-50">
                        <td className="px-3 py-1.5 text-slate-700">{it.name}</td>
                        <td className="px-2 py-1.5 text-slate-400">{it.type}</td>
                        <td className="px-2 py-1.5 text-right text-slate-500">{(it.qty_in_hundredths / 100).toFixed(2).replace(/\.00$/, '')}</td>
                        <td className="px-2 py-1.5 text-right text-slate-500">{money(it.unit_price)}</td>
                        <td className="px-3 py-1.5 text-right font-medium text-slate-700">{money(it.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-slate-100 text-[12px]">
                      <td colSpan={4} className="px-3 py-2 text-right text-slate-400">
                        {inv.due_amount > 0 ? 'due' : inv.paid_at ? `paid ${fmtDateTime(inv.paid_at)}` : 'total'}
                      </td>
                      <td className={`px-3 py-2 text-right font-semibold ${inv.due_amount > 0 ? 'text-rose-600' : 'text-slate-900'}`}>
                        {money(inv.due_amount > 0 ? inv.due_amount : inv.amount)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value, tone = 'text-slate-900' }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">{label}</div>
      <div className={`text-[13px] font-semibold ${tone}`}>{value ?? '—'}</div>
    </div>
  );
}
