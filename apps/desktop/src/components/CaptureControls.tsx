import { useEffect, useState } from 'react';
import { AppWindow, Check, Monitor } from 'lucide-react';
import { Button, cx, Select, TextInput } from './ui';
import { useSettings } from '../stores/settings';
import { useRecorder } from '../stores/recorder';
import { CAPTURE_PROFILES, applyCaptureProfile, estimatedBytesPerHour, selectedCaptureProfile } from '../lib/capture';
import { formatBytes } from '../lib/format';

export function CaptureSourcePicker() {
  const { settings, saving, update } = useSettings();
  const state = useRecorder((s) => s.state);
  const recorderBusy = useRecorder((s) => !!s.busy.save || !!s.busy.replay || !!s.busy.record);
  const [display, setDisplay] = useState(String((settings?.recording.monitorIndex ?? 0) + 1));
  useEffect(() => setDisplay(String((settings?.recording.monitorIndex ?? 0) + 1)), [settings?.recording.monitorIndex]);
  if (!settings) return null;
  const locked = saving || recorderBusy || !!state?.engine?.recording || !!state?.saving;
  const desktop = settings.recording.captureTarget === 'display';
  const gameAvailable = !!state?.capabilities?.hasGfxcapture;
  const fallback = !desktop && state?.captureSource?.type === 'monitor';
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium">Capture source</span>
        {state?.engine?.recording && <span className="text-[10px] text-fg-subtle">Locked during recording</span>}
      </div>
      <div
        role="group"
        aria-label="Capture source"
        className="grid grid-cols-2 rounded-md border border-line bg-canvas p-0.5"
      >
        {(
          [
            { id: 'display', title: 'Desktop', Icon: Monitor },
            { id: 'gameWindow', title: 'Game window', Icon: AppWindow },
          ] as const
        ).map(({ id, title, Icon }) => (
          <button
            key={id}
            aria-pressed={settings.recording.captureTarget === id}
            disabled={locked || (id === 'gameWindow' && !gameAvailable)}
            title={
              id === 'gameWindow' && !gameAvailable ? 'Window capture is unavailable with this FFmpeg build' : undefined
            }
            onClick={() =>
              void update((s) => {
                s.recording.captureTarget = id;
              })
            }
            className={cx(
              'flex h-8 items-center justify-center gap-2 rounded-sm text-xs transition-colors disabled:opacity-40',
              settings.recording.captureTarget === id ? 'bg-surface-3 text-fg' : 'text-fg-subtle hover:text-fg',
            )}
          >
            <Icon className="size-3.5" strokeWidth={1.6} />
            {title}
          </button>
        ))}
      </div>
      {desktop && (
        <form
          className="flex items-center justify-between gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const number = Number(display);
            if (Number.isInteger(number) && number >= 1 && number <= 16)
              void update((s) => {
                s.recording.monitorIndex = number - 1;
              });
          }}
        >
          <label htmlFor="capture-display" className="text-xs text-fg-muted">
            Display
          </label>
          <div className="flex items-center gap-1.5">
            <TextInput
              id="capture-display"
              aria-label="Display number"
              type="number"
              min={1}
              max={16}
              value={display}
              disabled={locked}
              onChange={(e) => setDisplay(e.target.value)}
              className="h-7! w-16 font-mono text-xs!"
            />
            <Button
              size="sm"
              type="submit"
              aria-label="Apply display"
              title="Apply display"
              icon={<Check className="size-3.5" />}
              disabled={locked || Number(display) === settings.recording.monitorIndex + 1}
            />
          </div>
        </form>
      )}
      {fallback && (
        <p role="status" className="border-l-2 border-warn pl-2 text-[11px] leading-relaxed text-warn">
          No game window available. Currently capturing the selected display.
        </p>
      )}
      <p className="text-[11px] leading-relaxed text-fg-subtle">
        {desktop
          ? 'Includes visible windows on the selected display.'
          : 'Uses the selected display when no game window is available.'}
      </p>
    </div>
  );
}

export function QualityPresets() {
  const { settings, saving, update } = useSettings();
  const state = useRecorder((s) => s.state);
  const recorderBusy = useRecorder((s) => !!s.busy.save || !!s.busy.replay || !!s.busy.record);
  if (!settings) return null;
  const selected = selectedCaptureProfile(settings);
  const locked = saving || recorderBusy || !!state?.engine?.recording || !!state?.saving;
  const profile = CAPTURE_PROFILES.find((p) => p.id === selected);
  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium">Quality</span>
        <Select
          label="Quality profile"
          value={selected}
          disabled={locked}
          className="h-7! max-w-40 text-xs!"
          onChange={(id) => {
            if (id !== 'custom') void update((s) => applyCaptureProfile(s, id));
          }}
          options={[
            ...CAPTURE_PROFILES.map((p) => ({ value: p.id, label: p.name })),
            ...(selected === 'custom' ? [{ value: 'custom' as const, label: 'Custom' }] : []),
          ]}
        />
      </div>
      <div className="flex flex-wrap justify-between gap-2 font-mono text-[10px] text-fg-subtle">
        <span>
          {profile?.detail ??
            `${settings.video.outputHeight ? settings.video.outputHeight + 'p' : 'Native'} · ${settings.video.fps} fps · ${settings.video.bitrateKbps / 1000} Mbps`}
        </span>
        <span>~{formatBytes(estimatedBytesPerHour(settings))}/h</span>
      </div>
      <p className="text-[10px] leading-relaxed text-fg-subtle">Changing source or quality clears the replay buffer.</p>
    </div>
  );
}
