import { AlertTriangle, CircleDot, Cpu, Pause, Play, Power, Save, Square } from 'lucide-react';
import { Link } from 'react-router-dom';
import { CaptureSourcePicker, QualityPresets } from './CaptureControls';
import { Button, ProgressBar, Select, Spinner } from './ui';
import { api, errorMessage } from '../lib/ipc';
import { ENCODER_LABELS, formatClock } from '../lib/format';
import { quickReplayDurations } from '../lib/capture';
import { useRecorder } from '../stores/recorder';
import { useSettings } from '../stores/settings';
import { toast } from '../stores/toasts';

export function RecorderPanel() {
  const { state, busy, toggleReplay, saveReplay, toggleRecording, togglePause } = useRecorder();
  const { settings, saving, update } = useSettings();
  const engine = state?.engine;
  const replay = engine?.replay;
  const recording = engine?.recording;
  const ready = state?.init.state === 'ready';
  const unavailable = state?.init.state === 'failed';
  const encoder = engine?.encoder ?? state?.capabilities?.encoders[0];
  const lengths = [...new Set([15, 30, 60, 120, 300, settings?.recording.replaySeconds ?? 30])].sort((a, b) => a - b);
  const saveLocked = !!busy.save || !!busy.replay || !!busy.record || saving || !!state?.saving;
  const locked = !!recording || saveLocked;
  return (
    <aside aria-label="Recorder" className="self-start border border-line bg-surface lg:sticky lg:top-[102px]">
      <div className="flex h-11 items-center justify-between border-b border-line px-4">
        <h2 className="text-xs font-semibold">Recorder</h2>
        <span className="flex items-center gap-1.5 text-[10px] text-fg-subtle">
          <span
            className={
              unavailable
                ? 'size-1.5 rounded-full bg-warn'
                : engine?.running
                  ? 'size-1.5 rounded-full bg-rec'
                  : 'size-1.5 rounded-full bg-fg-subtle'
            }
          />
          {unavailable ? 'Unavailable' : !ready ? 'Preparing' : engine?.running ? 'Capturing' : 'Standby'}
        </span>
      </div>
      {state?.init.state === 'failed' && (
        <div role="alert" className="border-b border-line p-4">
          <div className="flex items-start gap-2 text-xs text-warn">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <p className="break-words leading-relaxed">{state.init.message}</p>
          </div>
          <Button
            size="sm"
            className="mt-3"
            onClick={() => void api.reprobeHardware().catch((e) => toast.error('Recorder', errorMessage(e)))}
          >
            Try again
          </Button>
        </div>
      )}
      <div className="space-y-4 border-b border-line p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-medium">Instant Replay</h3>
          <Button
            size="sm"
            variant="ghost"
            icon={<Power className="size-3" />}
            onClick={() => void toggleReplay()}
            disabled={!ready || !!recording || !!busy.save || !!state?.saving}
            loading={busy.replay}
          >
            {replay ? 'On' : 'Off'}
          </Button>
        </div>
        {settings && (
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-fg-muted">Buffer length</span>
            <Select
              label="Replay length"
              value={settings.recording.replaySeconds}
              disabled={locked}
              className="h-7! text-xs!"
              options={lengths.map((s) => ({
                value: s,
                label: s < 60 ? `${s} seconds` : `${s / 60} minute${s === 60 ? '' : 's'}`,
              }))}
              onChange={(seconds) =>
                void update((s) => {
                  s.recording.replaySeconds = seconds;
                })
              }
            />
          </div>
        )}
        {replay ? (
          <div>
            <div className="mb-2 flex justify-between font-mono text-[10px] text-fg-subtle">
              <span>BUFFERED</span>
              <span>
                {Math.floor(replay.bufferedSeconds)} / {replay.seconds}s
              </span>
            </div>
            <ProgressBar
              value={replay.bufferedSeconds / replay.seconds}
              tone="accent"
              className="h-0.5! rounded-none!"
            />
          </div>
        ) : (
          <p className="text-[11px] leading-relaxed text-fg-subtle">
            Keeps recent footage ready to save. No clip is created until you save one.
          </p>
        )}
        <Button
          className="w-full justify-between!"
          variant="primary"
          icon={<Save className="size-3.5" />}
          loading={busy.save || state?.saving}
          disabled={!replay || replay.bufferedSeconds < 1 || !!busy.replay || !!busy.record || saving}
          onClick={() => void saveReplay()}
        >
          <span className="mr-auto">Save clip</span>
          {settings?.hotkeys.saveReplay && (
            <span className="font-mono text-[10px] opacity-70">{settings.hotkeys.saveReplay}</span>
          )}
        </Button>
        {replay && (
          <div className="flex items-center gap-1.5">
            <span className="mr-auto text-[10px] text-fg-subtle">Last</span>
            {quickReplayDurations(replay.seconds).map((seconds) => (
              <button
                key={seconds}
                className="rounded-sm border border-line px-2 py-1 font-mono text-[10px] text-fg-muted transition-colors hover:border-line-strong hover:text-fg disabled:opacity-30"
                disabled={saveLocked || replay.bufferedSeconds < seconds}
                title={
                  replay.bufferedSeconds < seconds
                    ? `Waiting for ${seconds} seconds of footage`
                    : `Save the last ${seconds} seconds`
                }
                onClick={() => void saveReplay(seconds)}
              >
                {seconds < 60 ? `${seconds}s` : `${seconds / 60}m`}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2 border-t border-line pt-3">
          <Button
            className="flex-1"
            variant={recording ? 'record' : 'secondary'}
            icon={recording ? <Square className="size-3 fill-current" /> : <CircleDot className="size-3.5" />}
            disabled={!ready || !!busy.save || !!busy.replay || !!state?.saving || saving}
            loading={busy.record}
            onClick={() => void toggleRecording()}
          >
            {recording ? `Stop · ${formatClock(recording.elapsedSecs)}` : 'Record manually'}
          </Button>
          {recording && (
            <Button
              aria-label={recording.paused ? 'Resume' : 'Pause'}
              title={recording.paused ? 'Resume' : 'Pause'}
              icon={recording.paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
              loading={busy.pause}
              onClick={() => void togglePause()}
            />
          )}
        </div>
      </div>
      <div className="border-b border-line p-4">
        <CaptureSourcePicker />
      </div>
      <div className="border-b border-line p-4">
        <QualityPresets />
      </div>
      <div className="space-y-2.5 p-4 text-[11px]">
        {!ready && !unavailable ? (
          <div className="flex items-center gap-2 text-fg-muted">
            <Spinner /> Detecting encoders
          </div>
        ) : unavailable ? null : (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-fg-subtle">
                <Cpu className="size-3" />
                Encoder
              </span>
              <span className="text-fg-muted">
                {encoder ? (ENCODER_LABELS[encoder.kind] ?? encoder.ffmpegName) : 'Not available'}
              </span>
            </div>
            {engine?.stats && engine.running && (
              <div className="flex justify-between gap-2">
                <span className="text-fg-subtle">Encoding / dropped</span>
                <span
                  className={
                    engine.stats.speed > 0 && engine.stats.speed < 0.95
                      ? 'font-mono text-warn'
                      : 'font-mono text-fg-muted'
                  }
                >
                  {engine.stats.speed.toFixed(2)}× / {engine.stats.droppedFrames}
                </span>
              </div>
            )}
            <Link to="/settings/video" className="inline-flex text-fg-subtle hover:text-accent">
              Advanced recording settings →
            </Link>
          </>
        )}
        {engine?.audioWarning && <p className="leading-relaxed text-warn">{engine.audioWarning}</p>}
        {engine?.lastError && !engine.running && <p className="break-words text-rec">{engine.lastError}</p>}
      </div>
    </aside>
  );
}
