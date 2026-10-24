import { CheckCircle2, Info, TriangleAlert, X } from 'lucide-react';
import { useToasts } from '../stores/toasts';
import { cx } from './ui';

export function Toasts() {
  const { toasts, dismiss } = useToasts();
  return (
    <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex gap-3 rounded-lg border border-line bg-surface-2 p-3 shadow-pop animate-fade-in"
        >
          {t.tone === 'success' && <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" />}
          {t.tone === 'error' && <TriangleAlert className="mt-0.5 size-4 shrink-0 text-rec" />}
          {t.tone === 'info' && <Info className="mt-0.5 size-4 shrink-0 text-accent" />}
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{t.title}</div>
            {t.body && <div className={cx('mt-0.5 break-words text-xs text-fg-muted')}>{t.body}</div>}
          </div>
          <button aria-label="Dismiss" onClick={() => dismiss(t.id)} className="text-fg-subtle hover:text-fg">
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
