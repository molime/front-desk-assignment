import { Link } from 'react-router-dom';
import { StatusBadge, Tag } from './ui.jsx';
import { customerName, fmtWindow, fullAddress } from '../lib/format.js';

/** Compact job card used on the dashboard and schedule grid. */
export default function JobCard({ job, dense = false }) {
  const name = customerName({
    first_name: job.customer_first ?? job.customer?.first_name,
    last_name: job.customer_last ?? job.customer?.last_name,
    company: job.customer_company ?? job.customer?.company,
  });
  const address = job.street
    ? [job.street, job.city].filter(Boolean).join(', ')
    : fullAddress(job.address);

  return (
    <Link
      to={`/jobs/${job.id}`}
      className="block rounded-lg border border-slate-200 bg-white p-2.5 text-left shadow-sm transition hover:border-brand-400 hover:shadow"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-brand-700">{fmtWindow(job)}</span>
        <StatusBadge status={job.work_status} />
      </div>
      <div className="mt-1 truncate text-[13px] font-medium text-slate-800">{name}</div>
      {!dense && <div className="truncate text-[11px] text-slate-500">{address}</div>}
      {job.description && (
        <div className="mt-0.5 line-clamp-2 text-[11px] text-slate-500">{job.description}</div>
      )}
      {job.source === 'agent' && (
        <div className="mt-1"><Tag tone="brand">booked by Marina</Tag></div>
      )}
    </Link>
  );
}
