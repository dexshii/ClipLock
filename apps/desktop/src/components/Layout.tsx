import { NavLink, Outlet } from 'react-router-dom';
import { CircleDot, CloudUpload, Film, Grid2X2, Settings, UserRound } from 'lucide-react';
import { CaptureStatus } from './CaptureStatus';
import { Toasts } from './Toasts';
import { cx } from './ui';
import { useSettings } from '../stores/settings';
import logo from '@cliplock/ui/logo.svg';

const NAV = [
  { to: '/', label: 'Workspace', icon: Grid2X2, end: true },
  { to: '/library', label: 'Library', icon: Film },
  { to: '/record', label: 'Recording', icon: CircleDot },
  { to: '/uploads', label: 'Uploads', icon: CloudUpload },
  { to: '/settings', label: 'Settings', icon: Settings },
  { to: '/account', label: 'Account', icon: UserRound },
];

export function Layout() {
  const saveKey = useSettings((s) => s.settings?.hotkeys.saveReplay);
  return (
    <div className="flex h-screen overflow-hidden">
      <nav aria-label="Main" className="flex w-[188px] shrink-0 flex-col border-r border-line bg-surface py-5">
        <div className="mb-8 flex items-center gap-2.5 px-5">
          <img src={logo} alt="" className="size-6" />
          <span className="text-[15px] font-semibold tracking-[-0.4px]">ClipLock</span>
        </div>
        <div className="mb-2 px-5 text-[10px] font-medium uppercase tracking-[0.1em] text-fg-subtle">Workspace</div>
        <ul className="space-y-0.5 px-2">
          {NAV.map(({ to, label, icon: Icon, end }, index) => (
            <li key={to} className={index === 3 ? 'mt-6! border-t border-line pt-4' : ''}>
              <NavLink
                to={to}
                end={end}
                className={({ isActive }) =>
                  cx(
                    'flex h-9 items-center gap-2.5 rounded-sm border-l-2 px-3 text-[12px] transition-colors',
                    isActive
                      ? 'border-accent bg-surface-3 font-medium text-fg'
                      : 'border-transparent text-fg-muted hover:bg-surface-2 hover:text-fg',
                  )
                }
              >
                <Icon className="size-[15px]" strokeWidth={1.6} />
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="mt-auto space-y-3 px-3">
          <CaptureStatus compact />
          {saveKey && (
            <div className="flex items-center justify-between px-1 text-[10px] text-fg-subtle">
              <span>Save replay</span>
              <span className="font-mono text-fg-muted">{saveKey}</span>
            </div>
          )}
          <div className="border-t border-line px-1 pt-3 text-[10px] text-fg-subtle">Local workspace</div>
        </div>
      </nav>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
      <Toasts />
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="sticky top-0 z-10 flex min-h-[78px] items-center justify-between gap-4 border-b border-line bg-canvas px-6 py-4">
      <div>
        <h1 className="text-[18px] font-semibold tracking-[-0.4px]">{title}</h1>
        {subtitle && <p className="mt-1 text-xs text-fg-subtle">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}
