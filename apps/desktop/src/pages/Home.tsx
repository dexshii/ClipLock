import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CircleDot, Cpu, Film, HardDrive, Pause, Play, Power, Save, Square } from 'lucide-react';
import { PageHeader } from '../components/Layout';
import { ClipCard } from '../components/ClipCard';
import { GamePicker } from '../components/GamePicker';
import { Badge, Button, Card, CardHeader, EmptyState, Kbd, ProgressBar, Spinner } from '../components/ui';
import { api, type StorageInfo } from '../lib/ipc';
import { formatBytes, formatClock, ENCODER_LABELS } from '../lib/format';
import { useLibrary } from '../stores/library';
import { useRecorder } from '../stores/recorder';
import { useSettings } from '../stores/settings';
import { UploadsSummary } from './Uploads';
import { CaptureSourcePicker, QualityPresets } from '../components/CaptureControls';
import { quickReplayDurations } from '../lib/capture';

export function Home() {
  const desktop = useSettings((s) => s.settings?.recording.captureTarget === 'display');
  return (
    <>
      <PageHeader title="Capture studio" subtitle="Choose your source. Keep the moment." actions={desktop ? <Badge>Desktop capture</Badge> : <GamePicker />} />
      <div className="grid grid-cols-1 gap-5 px-8 py-6 xl:grid-cols-3">
        <div className="space-y-5 xl:col-span-2">
          <ReplayCard />
          <RecentClips />
        </div>
        <div className="flex flex-col gap-5">
          <RecorderHealth />
          <StorageCard />
          <UploadsSummary />
        </div>
      </div>
    </>
  );
}

function ReplayCard() {
  const { state, busy, toggleReplay, saveReplay, toggleRecording, togglePause } = useRecorder();
  const settings = useSettings((s) => s.settings);
  const engine = state?.engine;
  const ready = state?.init.state === 'ready';
  const replay = engine?.replay;
  const recording = engine?.recording;
  const saveKey = settings?.hotkeys.saveReplay;

  return (
    <Card className="xl:col-span-2">
      <div className="space-y-5 border-b border-line bg-surface-2/40 p-6">
        <CaptureSourcePicker />
        <QualityPresets />
      </div>
      <div className="flex items-start justify-between gap-6 p-6">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">Instant Replay</h2>
            {replay ? <Badge tone="rec">On</Badge> : <Badge>Off</Badge>}
          </div>
          <p className="mt-1 max-w-md text-sm text-fg-muted">
            {replay
              ? `ClipLock keeps the last ${replay.seconds} seconds in a rolling buffer. Nothing is saved until you ask.`
              : 'Turn on Instant Replay to buffer your desktop or game and save moments after they happen.'}
          </p>
          {replay && (
            <div className="mt-4 w-72">
              <div className="mb-1.5 flex justify-between text-xs text-fg-muted">
                <span>Buffer</span>
                <span className="tabular-nums">
                  {Math.floor(replay.bufferedSeconds)}s / {replay.seconds}s
                </span>
              </div>
              <ProgressBar value={replay.bufferedSeconds / replay.seconds} tone="rec" />
            </div>
          )}
        </div>
        <Button
          variant={replay ? 'secondary' : 'primary'}
          icon={<Power className="size-4" />}
          onClick={() => void toggleReplay()}
          loading={busy.replay}
          disabled={!ready || !!recording}
        >
          {replay ? 'Turn off' : 'Turn on'}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-line px-6 py-4">
        <Button
          variant="primary"
          size="lg"
          icon={<Save className="size-4" />}
          onClick={() => void saveReplay()}
          loading={busy.save || state?.saving}
          disabled={!replay || replay.bufferedSeconds < 1 || busy.replay || busy.record}
        >
          Save clip
        </Button>
        {saveKey && (
          <span className="flex items-center gap-1.5 text-xs text-fg-muted">
            or press <Kbd>{saveKey}</Kbd> anywhere
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {recording && (
            <>
              <span className="mr-1 text-sm tabular-nums text-fg-muted">{formatClock(recording.elapsedSecs)}</span>
              <Button icon={recording.paused ? <Play className="size-4" /> : <Pause className="size-4" />} onClick={() => void togglePause()} loading={busy.pause}>
                {recording.paused ? 'Resume' : 'Pause'}
              </Button>
            </>
          )}
          <Button
            variant={recording ? 'record' : 'secondary'}
            icon={recording ? <Square className="size-3.5 fill-current" /> : <CircleDot className="size-4" />}
            onClick={() => void toggleRecording()}
            loading={busy.record}
            disabled={!ready}
          >
            {recording ? 'Stop recording' : 'Record'}
          </Button>
        </div>
      </div>
      {replay && <div className="flex flex-wrap items-center gap-2 border-t border-line px-6 py-3">
        <span className="mr-1 text-xs text-fg-muted">Save last</span>
        {quickReplayDurations(replay.seconds).map((seconds) => <Button key={seconds} size="sm"
          disabled={!!busy.save || !!state?.saving || !!busy.replay || !!busy.record || replay.bufferedSeconds < seconds}
          title={replay.bufferedSeconds < seconds ? `Waiting for ${seconds} seconds of footage` : `Save the last ${seconds} seconds`}
          onClick={() => void saveReplay(seconds)}>{seconds < 60 ? `${seconds}s` : `${seconds / 60}m`}</Button>)}
        <Link to="/settings/recording" className="ml-auto text-xs text-accent hover:underline">Buffer settings</Link>
      </div>}
    </Card>
  );
}

function RecorderHealth() {
  const state = useRecorder((s) => s.state);
  if (!state || state.init.state === 'initializing') {
    return (
      <Card className="flex items-center gap-3 p-6">
        <Spinner />
        <div>
          <div className="text-sm font-medium">Preparing recorder</div>
          <div className="text-xs text-fg-muted">Detecting your GPU encoders…</div>
        </div>
      </Card>
    );
  }
  if (state.init.state === 'failed') {
    return (
      <Card className="p-6">
        <div className="flex items-center gap-2 text-sm font-medium text-warn">
          <AlertTriangle className="size-4" /> Recorder unavailable
        </div>
        <p className="mt-2 break-words text-xs text-fg-muted">{state.init.message}</p>
        <Button className="mt-4" size="sm" onClick={() => void api.reprobeHardware()}>
          Try again
        </Button>
      </Card>
    );
  }
  const engine = state.engine;
  const best = state.capabilities?.encoders[0];
  const encoder = engine?.encoder ?? best;
  const speed = engine?.stats?.speed ?? 0;
  const struggling = engine?.running && speed > 0 && speed < 0.95;
  return (
    <Card>
      <CardHeader title="Recording readiness" subtitle={engine?.running ? 'Capturing' : 'Ready to capture'} />
      <dl className="space-y-3 px-5 pb-5 pt-4 text-sm">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-fg-muted">Capture source</dt>
          <dd>{state.captureSource?.type === 'monitor' ? `Desktop · display ${state.captureSource.index + 1}`
            : state.captureSource?.type === 'window' ? 'Game window' : 'Not selected'}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="flex items-center gap-2 text-fg-muted">
            <Cpu className="size-4" /> Encoder
          </dt>
          <dd className="text-right">
            {encoder ? ENCODER_LABELS[encoder.kind] ?? encoder.ffmpegName : '—'}
            {encoder && <Badge className="ml-2" tone={encoder.hardware ? 'ok' : 'warn'}>{encoder.hardware ? 'GPU' : 'CPU'}</Badge>}
          </dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-fg-muted">Detected game</dt>
          <dd>{state.manualGame ?? state.detectedGame?.name ?? 'None'}</dd>
        </div>
        {engine?.running && engine.stats && (
          <div className="flex items-center justify-between">
            <dt className="text-fg-muted">Encoding speed</dt>
            <dd className={struggling ? 'text-warn' : ''}>
              {speed.toFixed(2)}× {engine.stats.droppedFrames > 0 && `· ${engine.stats.droppedFrames} dropped`}
            </dd>
          </div>
        )}
        {struggling && (
          <p className="rounded-md bg-warn-soft px-3 py-2 text-xs text-warn">
            The encoder can’t keep up. Lower the resolution, frame rate or bitrate in Settings → Video.
          </p>
        )}
        {engine?.audioWarning && <p className="rounded-md bg-warn-soft px-3 py-2 text-xs text-warn">{engine.audioWarning}</p>}
        {engine?.lastError && !engine.running && <p className="break-words text-xs text-rec">{engine.lastError}</p>}
      </dl>
    </Card>
  );
}

function RecentClips() {
  const clips = useLibrary((s) => s.clips);
  const recent = [...clips].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6);
  return (
    <Card className="xl:col-span-2">
      <CardHeader
        title="Recent clips"
        action={
          <Link to="/library" className="text-xs text-accent hover:underline">
            View library
          </Link>
        }
      />
      {recent.length === 0 ? (
        <EmptyState
          icon={<Film className="size-5" />}
          title="No clips yet"
          body="Turn on Instant Replay and press your save hotkey after a great play. Clips show up here instantly."
        />
      ) : (
        <div className="grid grid-cols-2 gap-4 p-5 lg:grid-cols-3">
          {recent.map((c) => (
            <ClipCard key={c.id} clip={c} />
          ))}
        </div>
      )}
    </Card>
  );
}

function StorageCard() {
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const clipCount = useLibrary((s) => s.clips.length);
  useEffect(() => {
    void api.storageInfo().then(setInfo).catch(() => undefined);
  }, [clipCount]);
  const used = info?.library.totalBytes ?? 0;
  const over = info ? used > info.warningBytes : false;
  return (
    <Card>
      <CardHeader title="Storage" subtitle={info?.clipsDir} />
      <div className="space-y-3 px-5 pb-5 pt-4 text-sm">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-fg-muted">
            <HardDrive className="size-4" /> Clips
          </span>
          <span className="tabular-nums">
            {formatBytes(used)} · {info?.library.clipCount ?? 0} clips
          </span>
        </div>
        {info && <ProgressBar value={info.warningBytes ? used / info.warningBytes : 0} tone={over ? 'warn' : 'accent'} />}
        <div className="flex justify-between text-xs text-fg-muted">
          <span>Replay buffer {formatBytes(info?.bufferBytes ?? 0)}</span>
          {info?.freeBytes != null && <span>{formatBytes(info.freeBytes)} free on disk</span>}
        </div>
        {over && <p className="text-xs text-warn">Your library is larger than the warning limit set in Settings → Storage.</p>}
      </div>
    </Card>
  );
}
