import { useRecorder } from '../stores/recorder';
import { formatClock } from '../lib/format';
import { cx } from './ui';

/** Always-visible capture indicator (privacy: capture is never silent). */
export function CaptureStatus({ compact = false }: { compact?: boolean }) {
  const state = useRecorder((s) => s.state);
  const engine = state?.engine;
  const source = state?.captureSource?.type === 'monitor' ? 'Desktop' : 'Game';
  if (!state || state.init.state === 'initializing') {
    return <Pill dot="bg-fg-subtle" label="Starting…" compact={compact} />;
  }
  if (state.init.state === 'failed') return <Pill dot="bg-warn" label="Recorder unavailable" compact={compact} />;
  if (engine?.recording) {
    return (
      <Pill
        dot={engine.recording.paused ? 'bg-warn' : 'bg-rec animate-pulse-rec'}
        label={engine.recording.paused ? 'Paused' : 'Recording'}
        detail={`${source} · ${formatClock(engine.recording.elapsedSecs)}`}
        compact={compact}
      />
    );
  }
  if (engine?.replay) {
    return <Pill dot="bg-rec" label={source} detail={`${engine.replay.seconds}s replay`} compact={compact} />;
  }
  return <Pill dot="bg-fg-subtle" label="Not capturing" compact={compact} />;
}

function Pill({ dot, label, detail, compact }: { dot: string; label: string; detail?: string; compact: boolean }) {
  return (
    <div
      className={cx(
        'flex items-center gap-2 rounded-md border border-line bg-surface-2 text-xs',
        compact ? 'h-7 px-2' : 'h-8 px-2.5',
      )}
    >
      <span className={cx('size-2 rounded-full', dot)} />
      <span className="font-medium text-fg">{label}</span>
      {detail && <span className="tabular-nums text-fg-muted">{detail}</span>}
    </div>
  );
}
