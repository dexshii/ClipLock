import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Loader2, X } from 'lucide-react';

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'record';

const buttonStyles: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-[#101626] hover:bg-accent-hover border border-transparent',
  secondary: 'bg-surface-2 text-fg hover:bg-surface-3 border border-line-strong',
  ghost: 'text-fg-muted hover:text-fg hover:bg-surface-3',
  danger: 'bg-rec-soft text-rec hover:bg-rec hover:text-white',
  record: 'bg-rec text-white hover:brightness-110',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest }: ButtonProps) {
  const sizes = { sm: 'h-7 px-2.5 text-xs gap-1.5', md: 'h-8 px-3 text-xs gap-2', lg: 'h-10 px-4 text-[13px] gap-2' };
  return (
    <button
      className={cx(
        'inline-flex shrink-0 select-none items-center justify-center rounded-md font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-45',
        buttonStyles[variant],
        sizes[size],
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

export function IconButton({ label, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex size-8 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg disabled:opacity-40',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={cx('rounded-lg border border-line bg-surface', className)}>{children}</section>;
}

export function CardHeader({ title, action, subtitle }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-5 pt-4">
      <div>
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-fg-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-150 disabled:opacity-40',
        checked ? 'bg-accent' : 'bg-line-strong',
      )}
    >
      <span className={cx('inline-block size-4 rounded-full transition-transform duration-150', checked ? 'translate-x-[18px] bg-[#101626]' : 'translate-x-0.5 bg-white')} />
    </button>
  );
}

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  label,
  className,
  disabled,
}: {
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (v: T) => void;
  label: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <select
      aria-label={label}
      value={String(value)}
      disabled={disabled}
      onChange={(e) => {
        const opt = options.find((o) => String(o.value) === e.target.value);
        if (opt) onChange(opt.value);
      }}
      className={cx(
        'h-9 rounded-md border border-line bg-surface-2 px-2.5 pr-8 text-sm text-fg outline-none transition-colors hover:border-line-strong focus:border-accent disabled:opacity-50',
        className,
      )}
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Slider({ value, min, max, step, onChange, label, format }: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  label: string;
  format?: (v: number) => string;
}) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 w-40 cursor-pointer accent-[var(--color-accent)]"
      />
      <span className="w-12 text-right text-xs tabular-nums text-fg-muted">{format ? format(value) : value}</span>
    </div>
  );
}

export function TextInput({ className, ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cx(
        'h-9 rounded-md border border-line bg-surface-2 px-3 text-sm text-fg outline-none transition-colors placeholder:text-fg-subtle hover:border-line-strong focus:border-accent',
        className,
      )}
      {...rest}
    />
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 items-center rounded border border-line-strong bg-surface-3 px-1.5 font-mono text-[11px] font-medium text-fg-muted">
      {children}
    </kbd>
  );
}

const badgeTones = {
  neutral: 'bg-surface-3 text-fg-muted',
  accent: 'bg-accent-soft text-accent',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  rec: 'bg-rec-soft text-rec',
};

export function Badge({ tone = 'neutral', children, className }: { tone?: keyof typeof badgeTones; children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex h-5 items-center gap-1 rounded px-1.5 text-[11px] font-medium', badgeTones[tone], className)}>
      {children}
    </span>
  );
}

export function ProgressBar({ value, tone = 'accent', className }: { value: number; tone?: 'accent' | 'warn' | 'rec' | 'ok'; className?: string }) {
  const color = { accent: 'bg-accent', warn: 'bg-warn', rec: 'bg-rec', ok: 'bg-ok' }[tone];
  return (
    <div className={cx('h-1.5 overflow-hidden rounded-full bg-surface-3', className)}>
      <div className={cx('h-full rounded-full transition-[width] duration-300', color)} style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }} />
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('size-4 animate-spin text-fg-muted', className)} />;
}

export function EmptyState({ icon, title, body, action }: { icon: ReactNode; title: string; body: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-4 flex size-10 items-center justify-center text-fg-subtle">{icon}</div>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-fg-muted">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-line bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cx(
            'inline-flex h-7 items-center gap-1.5 rounded px-2.5 text-xs font-medium transition-colors',
            value === o.value ? 'bg-surface-3 text-fg' : 'text-fg-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Dialog({ open, onClose, title, children, footer, width = 'max-w-md' }: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input, button[data-autofocus]')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 animate-fade-in" onMouseDown={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx('w-full rounded-lg border border-line bg-surface shadow-pop', width)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="px-5 py-4 text-sm text-fg-muted">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function SettingRow({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-line px-5 py-3.5 last:border-b-0">
      <div className="min-w-0">
        <div className="text-sm text-fg">{title}</div>
        {description && <div className="mt-0.5 text-xs text-fg-muted">{description}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}
