import { useCallback, useEffect, useState } from 'react';
import { Gamepad2, RefreshCw } from 'lucide-react';
import { api, type RunningApp } from '../lib/ipc';
import { useRecorder } from '../stores/recorder';
import { IconButton } from './ui';

const AUTO = '__auto__';
const keyOf = (a: { name: string; hwnd: number | null }) => `${a.hwnd ?? 'x'}|${a.name}`;

/**
 * Chooses what to capture / tag clips with. Only lists what is running right now:
 * detected games first, then other open apps. "Auto-detect" follows the active game.
 */
export function GamePicker() {
  const state = useRecorder((s) => s.state);
  const setManualGame = useRecorder((s) => s.setManualGame);
  const [apps, setApps] = useState<RunningApp[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setApps(await api.runningApps());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const detected = state?.detectedGame?.name;
  const manual = state?.manualGame ? { name: state.manualGame, hwnd: state.manualHwnd } : null;
  const games = apps.filter((a) => a.gameId);
  const others = apps.filter((a) => !a.gameId);
  // Keep the current pick visible even if its app just closed.
  const manualMissing = manual && !apps.some((a) => keyOf(a) === keyOf(manual));
  const value = manual ? keyOf(manual) : AUTO;

  return (
    <div className="flex items-center gap-1.5">
      <Gamepad2 className="size-4 shrink-0 text-fg-muted" />
      <select
        aria-label="Capture target"
        value={value}
        onFocus={() => void refresh()}
        onChange={(e) => {
          const v = e.target.value;
          if (v === AUTO) return void setManualGame(null, null);
          const app = apps.find((a) => keyOf(a) === v);
          if (app) void setManualGame(app.name, app.hwnd);
        }}
        className="h-9 w-64 rounded-md border border-line bg-surface-2 px-2.5 pr-8 text-sm text-fg outline-none transition-colors hover:border-line-strong focus:border-accent"
      >
        <option value={AUTO}>{detected ? `Auto-detect · ${detected}` : 'Auto-detect · no game running'}</option>
        {manualMissing && <option value={keyOf(manual)}>{manual.name} (closed)</option>}
        {games.length > 0 && (
          <optgroup label="Running games">
            {games.map((a) => (
              <option key={keyOf(a)} value={keyOf(a)}>
                {a.name}
              </option>
            ))}
          </optgroup>
        )}
        {others.length > 0 && (
          <optgroup label="Open apps">
            {others.map((a) => (
              <option key={keyOf(a)} value={keyOf(a)} title={a.executable}>
                {a.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <IconButton label="Refresh running apps" onClick={() => void refresh()}>
        <RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
      </IconButton>
    </div>
  );
}
