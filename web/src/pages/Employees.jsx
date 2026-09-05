import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useApi } from '../lib/useApi.js';
import { Card, EmptyState, Spinner, ErrorState, Tag } from '../components/ui.jsx';

// Crew roster (office tool — PINs shown intentionally; the platform has no auth).
export default function Employees() {
  const { data, error, loading, reload } = useApi(() => api.getEmployees());

  return (
    <Card title="Crew">
      {loading && <Spinner />}
      {error && <ErrorState error={error} onRetry={reload} />}
      {data && data.employees.length === 0 && <EmptyState title="No employees on file" />}
      {data && data.employees.length > 0 && (
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-100 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              <th className="pb-2 pr-4">Name</th>
              <th className="pb-2 pr-4">Role</th>
              <th className="pb-2 pr-4 text-right">Jobs today</th>
              <th className="pb-2 text-right">Total jobs</th>
            </tr>
          </thead>
          <tbody>
            {data.employees.map((e) => (
              <tr key={e.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
                <td className="py-2.5 pr-4">
                  <Link to={`/employees/${e.id}`} className="text-[13px] font-medium text-brand-700 hover:underline">
                    {e.name}
                  </Link>
                </td>
                <td className="py-2.5 pr-4">
                  <Tag tone={e.role === 'field tech' ? 'brand' : 'slate'}>{e.role}</Tag>
                </td>
                <td className="py-2.5 pr-4 text-right text-[13px] text-slate-700">{e.jobs_today}</td>
                <td className="py-2.5 text-right text-[12px] text-slate-400">{e.job_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
