// Small hand-rolled UI primitives shared across pages.

const STATUS_STYLES = {
  scheduled: 'bg-sky-100 text-sky-800 ring-sky-200',
  'in progress': 'bg-amber-100 text-amber-800 ring-amber-200',
  'complete rated': 'bg-emerald-100 text-emerald-800 ring-emerald-200',
  'complete unrated': 'bg-emerald-100 text-emerald-800 ring-emerald-200',
  canceled: 'bg-slate-200 text-slate-600 ring-slate-300',
};

export function StatusBadge({ status }) {
  const key = (status ?? '').toLowerCase();
  const style = STATUS_STYLES[key] ?? 'bg-slate-100 text-slate-700 ring-slate-200';
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${style}`}>
      {status ?? 'unknown'}
    </span>
  );
}

const OUTCOME_STYLES = {
  booked: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
  rescheduled: 'bg-sky-100 text-sky-800 ring-sky-200',
  canceled: 'bg-slate-200 text-slate-600 ring-slate-300',
  handoff: 'bg-rose-100 text-rose-800 ring-rose-200',
  info: 'bg-brand-100 text-brand-800 ring-brand-200',
};

export function OutcomeBadge({ outcome }) {
  if (!outcome) return <span className="text-slate-400 text-xs">—</span>;
  const style = OUTCOME_STYLES[outcome.toLowerCase()] ?? 'bg-violet-100 text-violet-800 ring-violet-200';
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${style}`}>
      {outcome}
    </span>
  );
}

export function Tag({ children, tone = 'slate' }) {
  const tones = {
    slate: 'bg-slate-100 text-slate-600 ring-slate-200',
    brand: 'bg-brand-100 text-brand-800 ring-brand-200',
    green: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
    amber: 'bg-amber-100 text-amber-800 ring-amber-200',
  };
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function EmptyState({ title, hint }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 py-10 text-center">
      <div className="text-sm font-medium text-slate-500">{title}</div>
      {hint && <div className="text-xs text-slate-400">{hint}</div>}
    </div>
  );
}

export function Spinner({ label = 'Loading…' }) {
  return (
    <div className="flex items-center gap-2 py-8 justify-center text-slate-400 text-sm">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" />
      {label}
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  return (
    <div className="flex flex-col items-center gap-2 py-10 text-center">
      <div className="text-sm font-medium text-rose-600">{error?.message ?? 'Something went wrong'}</div>
      {onRetry && (
        <button onClick={onRetry} className="text-xs text-brand-700 hover:underline">Retry</button>
      )}
    </div>
  );
}

export function Card({ title, action, children, className = '' }) {
  return (
    <section className={`rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}>
      {title && (
        <header className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
          <h2 className="text-[13px] font-semibold text-slate-700">{title}</h2>
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}
