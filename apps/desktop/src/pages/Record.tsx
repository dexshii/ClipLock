import { CircleDot, Mic, MicOff, Monitor, Pause, Play, Square, AppWindow } from 'lucide-react';
import { PageHeader } from '../components/Layout';
import { GamePicker } from '../components/GamePicker';
import { Badge, Button, Card, CardHeader, Kbd, Segmented, Select, SettingRow, Toggle } from '../components/ui';
import { formatClock } from '../lib/format';
import { useRecorder } from '../stores/recorder';
import { useSettings } from '../stores/settings';
import { RESOLUTIONS, FRAME_RATES } from './Settings';

export function Record() {
  const { state, busy, toggleRecording, togglePause, setMicMuted } = useRecorder();
  const { settings, update } = useSettings();
  const engine = state?.engine;
  const recording = engine?.recording;
  const ready = state?.init.state === 'ready';
  if (!settings) return null;
  const locked = !!recording;
  const windowCapture = state?.capabilities?.hasGfxcapture ?? false;

  return (
    <>
      <PageHeader title="Record" subtitle="Manual recording of everything until you press stop." actions={<GamePicker />} />
      <div className="mx-auto grid max-w-5xl grid-cols-1 gap-5 px-8 py-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card className="flex flex-col items-center justify-center px-6 py-12 text-center">
          <div className={recording && !recording.paused ? 'text-rec' : 'text-fg-muted'}>
            <div className="font-mono text-6xl font-light tabular-nums tracking-tight">{formatClock(recording?.elapsedSecs ?? 0)}</div>
          </div>
          <div className="mt-3 flex items-center gap-2 text-sm text-fg-muted">
            {recording ? (
              recording.paused ? (
                <Badge tone="warn">Paused</Badge>
              ) : (
                <Badge tone="rec">
                  <span className="size-1.5 rounded-full bg-rec animate-pulse-rec" /> Recording
                </Badge>
              )
            ) : (
              'Ready'
            )}
            {engine?.replay && !recording && <span>· shares the encoder with Instant Replay</span>}
          </div>
          <div className="mt-8 flex items-center gap-3">
            <Button
              size="lg"
              variant={recording ? 'record' : 'primary'}
              icon={recording ? <Square className="size-4 fill-current" /> : <CircleDot className="size-4" />}
              onClick={() => void toggleRecording()}
              loading={busy.record}
              disabled={!ready}
            >
              {recording ? 'Stop & save' : 'Start recording'}
            </Button>
            {recording && (
              <Button size="lg" icon={recording.paused ? <Play className="size-4" /> : <Pause className="size-4" />} onClick={() => void togglePause()} loading={busy.pause}>
                {recording.paused ? 'Resume' : 'Pause'}
              </Button>
            )}
            {settings.audio.micEnabled && engine?.running && (
              <Button size="lg" variant={engine.micMuted ? 'danger' : 'secondary'} icon={engine.micMuted ? <MicOff className="size-4" /> : <Mic className="size-4" />} onClick={() => void setMicMuted(!engine.micMuted)}>
                {engine.micMuted ? 'Mic muted' : 'Mute mic'}
              </Button>
            )}
          </div>
          <div className="mt-6 flex flex-wrap justify-center gap-4 text-xs text-fg-subtle">
            {settings.hotkeys.toggleRecording && (
              <span>
                <Kbd>{settings.hotkeys.toggleRecording}</Kbd> start/stop
              </span>
            )}
            {settings.hotkeys.pauseRecording && (
              <span>
                <Kbd>{settings.hotkeys.pauseRecording}</Kbd> pause/resume
              </span>
            )}
          </div>
          <p className="mt-6 max-w-sm text-xs text-fg-subtle">Pausing cuts at keyframes, so each pause is accurate to about half a second.</p>
        </Card>

        <Card>
          <CardHeader title="Capture" subtitle={locked ? 'Locked while recording' : 'Changes restart Instant Replay'} />
          <div className="mt-2">
            <SettingRow title="Source">
              <Segmented
                label="Capture source"
                value={settings.recording.captureTarget}
                onChange={(v) => void update((s) => void (s.recording.captureTarget = v))}
                options={[
                  { value: 'display', label: <><Monitor className="size-3.5" /> Display</> },
                  ...(windowCapture ? [{ value: 'gameWindow' as const, label: <><AppWindow className="size-3.5" /> Game</>, title: 'Capture only the detected game window' }] : []),
                ]}
              />
            </SettingRow>
            {settings.recording.captureTarget === 'display' && (
              <SettingRow title="Display">
                <Select
                  label="Display"
                  value={settings.recording.monitorIndex}
                  disabled={locked}
                  onChange={(v) => void update((s) => void (s.recording.monitorIndex = v))}
                  options={[0, 1, 2, 3].map((i) => ({ value: i, label: i === 0 ? 'Display 1 (primary)' : `Display ${i + 1}` }))}
                />
              </SettingRow>
            )}
            <SettingRow title="Resolution">
              <Select label="Resolution" value={settings.video.outputHeight ?? 0} disabled={locked} onChange={(v) => void update((s) => void (s.video.outputHeight = v || null))} options={RESOLUTIONS} />
            </SettingRow>
            <SettingRow title="Frame rate">
              <Select label="Frame rate" value={settings.video.fps} disabled={locked} onChange={(v) => void update((s) => void (s.video.fps = v))} options={FRAME_RATES} />
            </SettingRow>
            <SettingRow title="Game & system audio">
              <Toggle label="System audio" checked={settings.audio.systemEnabled} disabled={locked} onChange={(v) => void update((s) => void (s.audio.systemEnabled = v))} />
            </SettingRow>
            <SettingRow title="Microphone" description="Only recorded when turned on.">
              <Toggle label="Microphone" checked={settings.audio.micEnabled} disabled={locked} onChange={(v) => void update((s) => void (s.audio.micEnabled = v))} />
            </SettingRow>
          </div>
        </Card>
      </div>
    </>
  );
}
