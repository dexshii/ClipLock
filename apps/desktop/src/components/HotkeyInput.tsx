import { useState } from 'react';
import { X } from 'lucide-react';
import { cx } from './ui';
import { acceleratorFromEvent } from '../lib/hotkeys';

export function HotkeyInput({ value, onChange, label }: { value: string | null; onChange: (v: string | null) => void; label: string }) {
  const [listening, setListening] = useState(false);
  return (
    <div className="flex items-center gap-1.5">
      <button
        aria-label={`${label} hotkey`}
        onClick={() => setListening(true)}
        onBlur={() => setListening(false)}
        onKeyDown={(e) => {
          if (!listening) return;
          e.preventDefault();
          if (e.key === 'Escape') return setListening(false);
          const accel = acceleratorFromEvent(e);
          if (accel) {
            onChange(accel);
            setListening(false);
          }
        }}
        className={cx(
          'h-8 min-w-36 rounded-md border px-3 text-left font-mono text-xs transition-colors',
          listening ? 'border-accent bg-accent-soft text-fg' : 'border-line bg-surface-2 text-fg-muted hover:border-line-strong',
        )}
      >
        {listening ? 'Press keys…' : value ?? 'Not set'}
      </button>
      {value && (
        <button aria-label={`Clear ${label} hotkey`} onClick={() => onChange(null)} className="text-fg-subtle hover:text-fg">
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
