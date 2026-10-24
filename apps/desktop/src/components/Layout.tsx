import { NavLink, Outlet } from 'react-router-dom';
import { CircleDot, CloudUpload, Film, House, Settings, UserRound } from 'lucide-react';
import { CaptureStatus } from './CaptureStatus';
import { Toasts } from './Toasts';
import { cx } from './ui';
import logo from '@cliplock/ui/logo.svg';

const NAV = [
  { to: '/', label: 'Home', icon: House, end: true },
  { to: '/library', label: 'Library', icon: Film },
  { to: '/record', label: 'Record', icon: CircleDot },
  { to: '/uploads', label: 'Uploads', icon: CloudUpload },
  { to: '/settings', label: 'Settings', icon: Settings },
  { to: '/account', label: 'Account', icon: UserRound },
];

export function Layout() {
  return (
    <div className="flex h-screen overflow-hidden">
      <nav aria-label="Main" className="flex w-56 shrink-0 flex-col border-r border-line bg-surface px-3 py-4">
        <div className="mb-6 flex items-center gap-2.5 px-2">
          <img src={logo} alt="" className="size-7" />
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight">ClipLock</div>
            <div className="text-[11px] text-fg-subtle">Capture it. Keep it.</div>
          </div>
        </div>
        <ul className="flex flex-col gap-0.5">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={end}
                className={({ isActive }) =>
                  cx(
                    'flex h-9 items-center gap-3 rounded-md px-2.5 text-sm transition-colors',
                    isActive ? 'bg-surface-3 font-medium text-fg' : 'text-fg-muted hover:bg-surface-2 hover:text-fg',
                  )
                }
              >
                <Icon className="size-4" strokeWidth={1.8} />
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="mt-auto px-1">
          <CaptureStatus compact />
        </div>
      </nav>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
      <Toasts />
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <header className="sticky top-0 z-10 flex items-end justify-between gap-4 border-b border-line bg-canvas/90 px-8 pb-4 pt-6 backdrop-blur">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-fg-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}
