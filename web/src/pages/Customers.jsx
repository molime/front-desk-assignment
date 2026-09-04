import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { Card, EmptyState, Spinner, Tag } from '../components/ui.jsx';
import { customerName, fullAddress, money } from '../lib/format.js';

// Search-as-you-type customer lookup (name, company, or address fragment).
export default function Customers() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const query = q.trim();
    if (!query) { setResults(null); setError(null); return undefined; }
    setSearching(true);
    const t = setTimeout(() => {
      api.searchCustomers(query)
        .then((d) => { setResults(d.results); setError(null); setSearching(false); })
        .catch((e) => { setError(e.message); setSearching(false); });
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <Card title="Customers">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search by name, company, or address…"
        autoFocus
        className="mb-3 w-full max-w-lg rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
      />
      {!q.trim() && <EmptyState title="Start typing to search" hint="732 customers on file — name, company, street, city, or zip." />}
      {searching && q.trim() && <Spinner label="Searching…" />}
      {error && <div className="py-4 text-[13px] text-rose-600">{error}</div>}
      {results && !searching && results.length === 0 && (
        <EmptyState title={`No matches for "${q.trim()}"`} />
      )}
      {results && results.length > 0 && (
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {results.map((c) => (
            <Link
              key={c.id}
              to={`/customers/${c.id}`}
              className="rounded-lg border border-slate-200 bg-white p-3 transition hover:border-brand-400 hover:shadow"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[13px] font-semibold text-slate-800">{customerName(c)}</span>
                <Tag tone={c.kind === 'commercial' ? 'amber' : 'slate'}>{c.kind ?? 'residential'}</Tag>
              </div>
              {c.company && <div className="truncate text-[12px] text-slate-500">{c.company}</div>}
              <div className="mt-1 truncate text-[11px] text-slate-400">
                {c.addresses[0] ? fullAddress(c.addresses[0]) : 'no address'}
                {c.addresses.length > 1 && ` · +${c.addresses.length - 1} more`}
              </div>
              <div className="mt-1 text-[11px] text-slate-400">{c.job_count} job{c.job_count === 1 ? '' : 's'} on file</div>
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}
