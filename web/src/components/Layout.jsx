import { NavLink, Outlet } from 'react-router-dom';
import { useLive } from '../lib/live.jsx';
import CallMarinaButton from './CallMarina.jsx';

const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/schedule', label: 'Schedule' },
  { to: '/calls', label: 'Calls' },
  { to: '/customers', label: 'Customers' },
  { to: '/employees', label: 'Crew' },
  { to: '/tasks', label: 'Tasks' },
];

export default function Layout() {
  const { connected } = useLive();
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-6 px-4">
          <NavLink to="/" className="flex items-baseline gap-2">
            <span className="text-[15px] font-bold tracking-tight text-slate-900">
              Gulf Breeze <span className="text-brand-600">Air</span>
            </span>
            <span className="text-[11px] font-medium uppercase tracking-widest text-slate-400">Front Desk</span>
          </NavLink>
          <nav className="flex items-center gap-1">
            {NAV.map(({ to, label, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  `rounded-lg px-3 py-1.5 text-[13px] font-medium transition ${
                    isActive ? 'bg-brand-50 text-brand-800' : 'text-slate-600 hover:bg-slate-100'
                  }`
                }
              >
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500" title={connected ? 'Live updates connected' : 'Reconnecting…'}>
              <span className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-slate-300 animate-pulse'}`} />
              {connected ? 'Live' : 'Offline'}
            </span>
            <CallMarinaButton />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-5">
        <Outlet />
      </main>
    </div>
  );
}
