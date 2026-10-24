import { useEffect, useState } from 'react';
import { AppWindow, Check, Monitor, ShieldCheck } from 'lucide-react';
import { Badge, Button, cx, TextInput } from './ui';
import { useSettings } from '../stores/settings';
import { useRecorder } from '../stores/recorder';
import { CAPTURE_PROFILES, applyCaptureProfile, estimatedBytesPerHour, selectedCaptureProfile } from '../lib/capture';
import { formatBytes } from '../lib/format';

export function CaptureSourcePicker() {
  const { settings, saving, update } = useSettings();
  const state = useRecorder((s) => s.state);
  const [display, setDisplay] = useState(String((settings?.recording.monitorIndex ?? 0) + 1));
  useEffect(() => setDisplay(String((settings?.recording.monitorIndex ?? 0) + 1)), [settings?.recording.monitorIndex]);
  if (!settings) return null;
  const locked = saving || !!state?.engine?.recording || !!state?.saving;
  const desktop = settings.recording.captureTarget === 'display';
  const gameAvailable = !!state?.capabilities?.hasGfxcapture;
  const fallback = !desktop && state?.captureSource?.type === 'monitor';
  const choices = [
    { id: 'display' as const, title: 'Desktop', description: 'Your entire display, with or without a game.', Icon: Monitor },
    { id: 'gameWindow' as const, title: 'Game window', description: 'Follow the detected game window.', Icon: AppWindow },
  ];
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-muted">Capture source</h3>
        <Badge tone={state?.init.state === 'failed' ? 'warn' : state?.engine?.running ? 'rec' : 'neutral'}>
          {state?.init.state === 'failed' ? 'Unavailable' : !state || state.init.state === 'initializing' ? 'Preparing' : state.engine?.running ? 'Live' : 'Ready'}
        </Badge>
      </div>
      <div role="group" aria-label="Capture source" className="grid grid-cols-2 gap-2">
        {choices.map(({ id, title, description, Icon }) => (
          <button key={id} aria-pressed={settings.recording.captureTarget === id}
            disabled={locked || (id === 'gameWindow' && !gameAvailable)}
            onClick={() => void update((s) => { s.recording.captureTarget = id; })}
            className={cx('rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45',
              settings.recording.captureTarget === id ? 'border-accent bg-accent/10' : 'border-line bg-surface-2 hover:border-line-strong')}>
            <span className="flex items-center gap-2 text-sm font-semibold"><Icon className="size-4" />{title}
              {settings.recording.captureTarget === id && <Check className="ml-auto size-4 text-accent" />}</span>
            <span className="mt-1.5 block text-xs leading-relaxed text-fg-muted">{description}</span>
          </button>
        ))}
      </div>
      {desktop && <form className="flex items-center gap-2" onSubmit={(e) => {
        e.preventDefault();
        const number = Number(display);
        if (Number.isInteger(number) && number >= 1 && number <= 16)
          void update((s) => { s.recording.monitorIndex = number - 1; });
      }}>
        <label htmlFor="capture-display" className="text-xs text-fg-muted">Display number</label>
        <TextInput id="capture-display" type="number" min={1} max={16} value={display} disabled={locked}
          onChange={(e) => setDisplay(e.target.value)} className="w-20" />
        <Button size="sm" type="submit" disabled={locked || Number(display) === settings.recording.monitorIndex + 1}>Apply</Button>
      </form>}
      {fallback && <p role="status" className="rounded-md bg-warn-soft p-2.5 text-xs text-warn">
        No game window is selected. Display {state?.captureSource?.type === 'monitor' ? state.captureSource.index + 1 : settings.recording.monitorIndex + 1} is the current capture source.
        Choose Desktop to capture it explicitly, or focus a supported game.
      </p>}
      {!gameAvailable && <p className="text-xs text-fg-subtle">Game-window capture is unavailable with this FFmpeg build. Desktop capture is available.</p>}
      <p className="flex items-start gap-2 text-xs leading-relaxed text-fg-subtle"><ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
        {state?.engine?.recording ? 'Stop recording before changing the source.' : desktop
          ? 'Desktop clips include every visible window on the selected display. Changing the source clears the replay buffer.'
          : 'Source changes clear the replay buffer. If no game window is detected, the selected display is used.'}
      </p>
    </div>
  );
}

export function QualityPresets() {
  const { settings, saving, update } = useSettings();
  const state = useRecorder((s) => s.state);
  if (!settings) return null;
  const selected = selectedCaptureProfile(settings);
  const locked = saving || !!state?.engine?.recording || !!state?.saving;
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3 text-xs">
        <span className="font-semibold uppercase tracking-wider text-fg-muted">Quality profile</span>
        <span className="text-fg-subtle">{selected === 'custom' ? 'Custom · ' : ''}~{formatBytes(estimatedBytesPerHour(settings))}/hour</span>
      </div>
      <div className="grid grid-cols-3 gap-2" role="group" aria-label="Quality profile">
        {CAPTURE_PROFILES.map((p) => <button key={p.id} disabled={locked} aria-pressed={selected === p.id}
          onClick={() => void update((s) => applyCaptureProfile(s, p.id))}
          className={cx('rounded-lg border p-2.5 text-left transition-colors disabled:opacity-45',
            selected === p.id ? 'border-accent bg-accent/10' : 'border-line bg-surface-2 hover:border-line-strong')}>
          <span className="block text-xs font-semibold">{p.name}</span>
          <span className="mt-1 block text-[10px] text-fg-muted">{p.detail}</span>
        </button>)}
      </div>
      <p className="mt-2 text-[11px] text-fg-subtle">Applies H.264 with automatic encoder selection. Audio and privacy choices stay yours.</p>
    </div>
  );
}
