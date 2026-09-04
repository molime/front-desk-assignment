import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useApi } from '../lib/useApi.js';
import { Card, EmptyState, Spinner, ErrorState, StatusBadge, Tag } from '../components/ui.jsx';
import {
  customerName, fmtDate, fmtDateTime, fmtWindow, fullAddress, money,
} from '../lib/format.js';

// Customer 360: header + warranty badge, addresses, upcoming, visit history,
// invoices (DESIGN.md §4).
export default function CustomerDetail() {
  const { id } = useParams();
  const profile = useApi(() => api.getCustomer(id), [id]);
  const history = useApi(() => api.getCustomerHistory(id, 25), [id]);
  const upcoming = useApi(() => api.getCustomerUpcoming(id), [id]);
  const warranty = useApi(() => api.getCustomerWarranty(id), [id]);
  const invoices = useApi(() => api.getCustomerInvoices(id), [id]);

  if (profile.loading) return <Spinner label="Loading customer…" />;
  if (profile.error) return <ErrorState error={profile.error} onRetry={profile.reload} />;
  const c = profile.data;

  const labor = warranty.data?.labor_warranty;
  const activeInstall = labor?.installs?.find((i) => i.active);

  return (
    <div className="flex flex-col gap-4">
      <div className="text-[12px] text-slate-400">
        <Link to="/customers" className="text-brand-700 hover:underline">Customers</Link> / {customerName(c)}
      </div>

      {/* header */}
      <Card>
        <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-slate-900">{customerName(c)}</h1>
              <Tag tone={c.kind === 'commercial' ? 'amber' : 'slate'}>{c.kind ?? 'residential'}</Tag>
            </div>
            {c.company && <div className="text-[13px] text-slate-500">{c.company}</div>}
            {(c.phone || c.email) && (
              <div className="text-[13px] text-slate-500">
                {[c.phone, c.email].filter(Boolean).join(' · ')}
              </div>
            )}
            <div className="mt-1 flex flex-wrap gap-1">
              {(c.tags ?? []).map((t) => <Tag key={t}>{t}</Tag>)}
            </div>
          </div>
          <Stat label="Jobs" value={c.job_count} />
          <Stat label="First visit" value={fmtDate(c.first_job)} />
          <Stat label="Last visit" value={fmtDate(c.last_job)} />
          <Stat
            label="Open balance"
            value={money(c.open_balance)}
            tone={c.open_balance > 0 ? 'text-rose-600' : 'text-slate-900'}
          />
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">Labor warranty</div>
            {warranty.loading ? (
              <span className="text-[12px] text-slate-400">checking…</span>
            ) : labor?.active ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-800 ring-1 ring-inset ring-emerald-200">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                Active · expires {fmtDate(activeInstall?.labor_warranty_expires)}
              </span>
            ) : (
              <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-medium text-slate-500 ring-1 ring-inset ring-slate-200">
                {labor?.installs?.length ? 'Expired' : 'None on record'}
              </span>
            )}
          </div>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* left column: addresses + upcoming */}
        <div className="flex flex-col gap-4">
          <Card title={`Addresses (${c.addresses.length})`}>
            {c.addresses.length === 0 && <EmptyState title="No addresses on file" />}
            <div className="flex flex-col gap-2">
              {c.addresses.map((a) => (
                <div key={a.id} className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-[12px] text-slate-700">
                  {fullAddress(a)}
                </div>
              ))}
            </div>
          </Card>

          <Card title="Upcoming appointments">
            {upcoming.loading && <Spinner />}
            {upcoming.data?.appointments.length === 0 && <EmptyState title="Nothing scheduled" />}
            <div className="flex flex-col gap-2">
              {upcoming.data?.appointments.map((j) => (
                <Link key={j.id} to={`/jobs/${j.id}`} className="rounded-lg border border-slate-200 p-2.5 transition hover:border-brand-400">
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] font-semibold text-brand-700">{fmtDateTime(j.scheduled_start)}</span>
                    <StatusBadge status={j.work_status} />
                  </div>
                  <div className="mt-0.5 text-[12px] text-slate-600">{j.description ?? 'Service visit'}</div>
                  <div className="text-[11px] text-slate-400">{fullAddress(j.address)}</div>
                </Link>
              ))}
            </div>
          </Card>

          {warranty.data && (warranty.data.warranty_claims.length > 0 || warranty.data.warranty_line_items.length > 0) && (
            <Card title="Warranty record">
              <p className="mb-2 text-[12px] text-slate-600">{warranty.data.summary}</p>
              {warranty.data.warranty_claims.map((cl) => (
                <div key={cl.job_id} className="mb-1 text-[11px] text-slate-500">
                  <Link to={`/jobs/${cl.job_id}`} className="text-brand-700 hover:underline">#{cl.invoice_number ?? cl.job_id}</Link>
                  {' '}· {cl.tags.join(', ')} · {fmtDate(cl.completed_at ?? cl.scheduled_start)}
                </div>
              ))}
              {warranty.data.warranty_line_items.map((li) => (
                <div key={li.id} className="text-[11px] text-slate-500">
                  {li.name} · {money(li.amount)} · inv #{li.invoice_number}
                </div>
              ))}
            </Card>
          )}
        </div>

        {/* middle: visit history timeline */}
        <Card title="Visit history" className="lg:col-span-1">
          {history.loading && <Spinner />}
          {history.data && history.data.length === 0 && <EmptyState title="No visits on record" />}
          <div className="relative flex max-h-[80vh] flex-col gap-2 overflow-y-auto pl-3 before:absolute before:left-1 before:top-1 before:bottom-1 before:w-px before:bg-slate-200">
            {history.data?.map((j) => <HistoryJob key={j.id} job={j} />)}
          </div>
        </Card>

        {/* right: invoices */}
        <Card title={`Invoices${invoices.data ? ` (${invoices.data.invoices.length})` : ''}`}>
          {invoices.loading && <Spinner />}
          {invoices.data?.invoices.length === 0 && <EmptyState title="No invoices" />}
          <div className="flex max-h-[80vh] flex-col gap-2 overflow-y-auto">
            {invoices.data?.invoices.map((inv) => (
              <div key={inv.id} className="rounded-lg border border-slate-200 p-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-semibold text-slate-700">#{inv.invoice_number}</span>
                  <Tag tone={inv.status === 'paid' ? 'green' : inv.status === 'open' ? 'amber' : 'slate'}>{inv.status}</Tag>
                </div>
                <div className="mt-1 flex items-baseline justify-between">
                  <span className="text-[11px] text-slate-400">{fmtDate(inv.service_date ?? inv.invoice_date)}</span>
                  <span className="text-[13px] font-semibold text-slate-800">{money(inv.amount)}</span>
                </div>
                {inv.due_amount > 0 && (
                  <div className="text-right text-[11px] font-medium text-rose-600">{money(inv.due_amount)} due</div>
                )}
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
      <div className={`text-[15px] font-semibold ${tone}`}>{value ?? '—'}</div>
    </div>
  );
}

/** Timeline entry: status, techs, note snippets — expandable. */
function HistoryJob({ job }) {
  const [open, setOpen] = useState(false);
  const when = job.completed_at ?? job.scheduled_start;
  return (
    <div className="relative rounded-lg border border-slate-200 bg-white p-2.5 before:absolute before:-left-[11px] before:top-3.5 before:h-2 before:w-2 before:rounded-full before:bg-brand-400">
      <button onClick={() => setOpen(!open)} className="flex w-full items-start justify-between gap-2 text-left">
        <div className="min-w-0">
          <div className="text-[11px] text-slate-400">{fmtDateTime(when)}</div>
          <div className="truncate text-[12px] font-medium text-slate-800">{job.description ?? 'Service visit'}</div>
        </div>
        <StatusBadge status={job.work_status} />
      </button>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
        {job.techs.length > 0 && <span>{job.techs.map((t) => `${t.first_name} ${t.last_name}`).join(', ')}</span>}
        {job.address?.street && <span className="text-slate-400">· {job.address.street}</span>}
        {job.source === 'agent' && <Tag tone="brand">Marina</Tag>}
        {job.notes.length > 0 && (
          <span className="text-slate-400">· {job.notes.length} note{job.notes.length === 1 ? '' : 's'}</span>
        )}
      </div>
      {open && (
        <div className="mt-2 flex flex-col gap-1.5 border-t border-slate-100 pt-2">
          <Link to={`/jobs/${job.id}`} className="text-[11px] font-medium text-brand-700 hover:underline">
            Open job detail →
          </Link>
          {job.notes.map((n) => (
            <div key={n.id} className={`rounded px-2 py-1.5 text-[11px] ${n.author === 'agent' ? 'bg-brand-50 text-brand-900' : 'bg-slate-50 text-slate-600'}`}>
              <span className="mr-1 font-semibold uppercase tracking-wide text-[9px] opacity-60">
                {n.author === 'agent' ? 'Marina' : n.author} · {fmtDate(n.created_at)}
              </span>
              {n.summary}
            </div>
          ))}
          {job.notes.length === 0 && <div className="text-[11px] text-slate-400">No notes.</div>}
        </div>
      )}
    </div>
  );
}
