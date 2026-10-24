import { useEffect, useState } from 'react';
import { Gamepad2 } from 'lucide-react';
import { api } from '../lib/ipc';
import { useRecorder } from '../stores/recorder';
import { Select } from './ui';

const AUTO = '__auto__';

/** Shows the detected game and lets the user override it for new clips. */
export function GamePicker() {
  const state = useRecorder((s) => s.state);
  const setManualGame = useRecorder((s) => s.setManualGame);
  const [games, setGames] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    void api.listGames().then(setGames);
  }, []);
  const detected = state?.detectedGame?.name;
  const value = state?.manualGame ?? AUTO;
  return (
    <div className="flex items-center gap-2">
      <Gamepad2 className="size-4 text-fg-muted" />
      <Select
        label="Game for new clips"
        value={value}
        onChange={(v) => void setManualGame(v === AUTO ? null : v)}
        className="w-60"
        options={[
          { value: AUTO, label: detected ? `Auto-detect · ${detected}` : 'Auto-detect · no game found' },
          ...games.map((g) => ({ value: g.name, label: g.name })),
        ]}
      />
    </div>
  );
}
