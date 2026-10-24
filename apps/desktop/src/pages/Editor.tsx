import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Pause, Play, Scissors, Volume2, VolumeX } from 'lucide-react';
import { Button, IconButton, Kbd, ProgressBar, Segmented, Slider, Spinner, TextInput, Toggle, cx } from '../components/ui';
import { api, errorMessage, fileUrl, on, type Clip } from '../lib/ipc';
import { formatDuration, formatTimecode } from '../lib/format';
import { toast } from '../stores/toasts';

const SPEEDS = ['0.25', '0.5', '1', '1.5', '2'] as const;
const FILMSTRIP_FRAMES = 12;
const MIN_LENGTH_MS = 500;

export function Editor() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [clip, setClip] = useState<Clip | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [duration, setDuration] = useState(0); // ms
  const [position, setPosition] = useState(0); // ms
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>('1');
  const [mute, setMute] = useState(false);
  const [volume, setVolume] = useState(1);
  const [lossless, setLossless] = useState(false);
  const [title, setTitle] = useState('');
  const [exporting, setExporting] = useState<number | null>(null);

  useEffect(() => {
    api
      .getClip(id)
      .then((c) => {
        setClip(c);
        setTitle(`${c.title} (edit)`);
        // Library duration first; refined from the video's metadata once it loads.
        setDuration(c.durationMs);
        setRange([0, c.durationMs]);
      })
      .catch((e) => toast.error('Clip not found', errorMessage(e)));
  }, [id]);

  const effectsChanged = speed !== '1' || mute || volume !== 1;
  useEffect(() => {
    if (effectsChanged) setLossless(false);
  }, [effectsChanged]);

  // Preview follows the chosen effects.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.playbackRate = Number(speed);
    v.muted = mute;
    v.volume = Math.min(1, volume);
  }, [speed, mute, volume]);

  const seek = useCallback((ms: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = ms / 1000;
    setPosition(ms);
  }, []);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      if (v.currentTime * 1000 >= range[1] - 50 || v.currentTime * 1000 < range[0]) v.currentTime = range[0] / 1000;
      void v.play();
    } else v.pause();
  }, [range]);

  // Playback stays inside the trimmed range.
  const onTimeUpdate = () => {
    const v = videoRef.current;
    if (!v) return;
    const ms = v.currentTime * 1000;
    setPosition(ms);
    if (!v.paused && ms >= range[1]) {
      v.pause();
      v.currentTime = range[1] / 1000;
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      const frame = clip && clip.fps > 0 ? 1000 / clip.fps : 1000 / 60;
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'i' || e.key === 'I') {
        setRange(([, end]) => [Math.min(position, end - MIN_LENGTH_MS), end]);
      } else if (e.key === 'o' || e.key === 'O') {
        setRange(([start]) => [start, Math.max(position, start + MIN_LENGTH_MS)]);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const step = e.shiftKey ? 1000 : frame;
        seek(Math.min(duration, Math.max(0, position + (e.key === 'ArrowLeft' ? -step : step))));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, position, duration, seek, clip]);

  useEffect(() => {
    const sub = on<{ clipId: string; progress: number }>('export-progress', (p) => {
      if (p.clipId === id) setExporting(p.progress);
    });
    return () => void sub.then((f) => f());
  }, [id]);

  const doExport = async () => {
    if (!clip) return;
    setExporting(0);
    try {
      const created = await api.exportEdit(clip.id, {
        trimStartMs: Math.round(range[0]),
        trimEndMs: Math.round(range[1]),
        speed: Number(speed),
        mute,
        volume,
        lossless,
        title,
      });
      toast.success('Edit exported', created.title);
      navigate(`/clips/${created.id}`, { replace: true });
    } catch (e) {
      toast.error('Export failed', errorMessage(e));
    } finally {
      setExporting(null);
    }
  };

  if (!clip) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const length = range[1] - range[0];
  const outputLength = length / Number(speed);

  return (
    <div className="mx-auto flex max-w-6xl flex-col px-8 py-6">
      <div className="mb-4 flex items-center gap-2">
        <IconButton label="Back" onClick={() => navigate(-1)}>
          <ArrowLeft className="size-4" />
        </IconButton>
        <h1 className="text-xl font-semibold tracking-tight">Edit clip</h1>
        <span className="text-sm text-fg-muted">· {clip.title}</span>
      </div>

      <div className="flex justify-center overflow-hidden rounded-lg border border-line bg-black">
        <video
          ref={videoRef}
          src={fileUrl(clip.filePath)}
          poster={fileUrl(clip.thumbnailPath)}
          className="aspect-video max-h-[52vh] w-full object-contain"
          preload="auto"
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration * 1000;
            if (!Number.isFinite(d) || d <= 0) return;
            setDuration(d);
            setRange(([start, end]) => [Math.min(start, d), end >= duration - 1 ? d : Math.min(end, d)]);
          }}
          onTimeUpdate={onTimeUpdate}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onClick={togglePlay}
        />
      </div>

      <div className="mt-4 flex items-center gap-3">
        <IconButton label={playing ? 'Pause' : 'Play'} onClick={togglePlay} className="size-9 bg-surface-3 text-fg">
          {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
        </IconButton>
        <span className="font-mono text-xs tabular-nums text-fg-muted">
          {formatTimecode(position)} / {formatTimecode(duration)}
        </span>
        <div className="ml-auto flex items-center gap-3 text-xs text-fg-subtle">
          <span><Kbd>Space</Kbd> play</span>
          <span><Kbd>I</Kbd>/<Kbd>O</Kbd> set in/out</span>
          <span><Kbd>←</Kbd>/<Kbd>→</Kbd> frame step</span>
        </div>
      </div>

      {duration > 0 && (
        <Timeline src={fileUrl(clip.filePath) ?? ''} duration={duration} position={position} range={range} onSeek={seek} onRange={setRange} />
      )}

      <div className="mt-6 grid grid-cols-1 gap-6 rounded-lg border border-line bg-surface p-5 md:grid-cols-2">
        <div className="space-y-4">
          <Field label="Title">
            <TextInput value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} className="w-full" aria-label="Title for the edited clip" />
          </Field>
          <Field label="Playback speed">
            <Segmented label="Playback speed" value={speed} onChange={setSpeed} options={SPEEDS.map((s) => ({ value: s, label: `${s}×` }))} />
          </Field>
        </div>
        <div className="space-y-4">
          <Field label="Audio">
            <div className="flex items-center gap-3">
              <IconButton label={mute ? 'Unmute' : 'Mute'} onClick={() => setMute(!mute)}>
                {mute ? <VolumeX className="size-4 text-rec" /> : <Volume2 className="size-4" />}
              </IconButton>
              <div className={cx(mute && 'pointer-events-none opacity-40')}>
                <Slider label="Volume" value={volume} min={0} max={2} step={0.05} onChange={setVolume} format={(v) => `${Math.round(v * 100)}%`} />
              </div>
            </div>
          </Field>
          <Field label="Fast export (no re-encode)">
            <div className="flex items-center gap-3">
              <Toggle checked={lossless} onChange={setLossless} label="Fast export" disabled={effectsChanged} />
              <span className="text-xs text-fg-muted">
                {effectsChanged ? 'Not available with speed or audio changes.' : 'Cuts snap to the nearest keyframe (~1 s).'}
              </span>
            </div>
          </Field>
        </div>
      </div>

      <div className="mt-5 flex items-center gap-4">
        <div className="text-sm text-fg-muted">
          Output length <span className="font-medium text-fg">{formatDuration(outputLength)}</span>
          <span className="ml-2 text-xs text-fg-subtle">The original clip is kept unchanged.</span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {exporting !== null && <ProgressBar value={exporting} className="w-48" />}
          <Button variant="primary" size="lg" icon={<Scissors className="size-4" />} onClick={() => void doExport()} loading={exporting !== null} disabled={length < MIN_LENGTH_MS}>
            Export clip
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-fg-muted">{label}</div>
      {children}
    </div>
  );
}

/** Filmstrip with draggable in/out handles and a scrubbable playhead. */
function Timeline({
  src,
  duration,
  position,
  range,
  onSeek,
  onRange,
}: {
  src: string;
  duration: number;
  position: number;
  range: [number, number];
  onSeek: (ms: number) => void;
  onRange: (r: [number, number]) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<'start' | 'end' | 'seek' | null>(null);

  const msAt = (clientX: number) => {
    const rect = trackRef.current!.getBoundingClientRect();
    return Math.min(duration, Math.max(0, ((clientX - rect.left) / rect.width) * duration));
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const ms = msAt(e.clientX);
    if (drag.current === 'start') onRange([Math.min(ms, range[1] - MIN_LENGTH_MS), range[1]]);
    else if (drag.current === 'end') onRange([range[0], Math.max(ms, range[0] + MIN_LENGTH_MS)]);
    if (drag.current !== 'seek') onSeek(drag.current === 'start' ? Math.min(ms, range[1] - MIN_LENGTH_MS) : Math.max(ms, range[0] + MIN_LENGTH_MS));
    else onSeek(ms);
  };

  const pct = (ms: number) => `${(ms / duration) * 100}%`;

  return (
    <div
      ref={trackRef}
      className="relative mt-4 h-16 select-none rounded-md border border-line bg-surface-2"
      onPointerDown={(e) => {
        drag.current = 'seek';
        e.currentTarget.setPointerCapture(e.pointerId);
        onSeek(msAt(e.clientX));
      }}
      onPointerMove={onPointerMove}
      onPointerUp={() => (drag.current = null)}
    >
      <Filmstrip src={src} duration={duration} />
      <div className="absolute inset-y-0 left-0 bg-black/65" style={{ width: pct(range[0]) }} />
      <div className="absolute inset-y-0 right-0 bg-black/65" style={{ width: `calc(100% - ${pct(range[1])})` }} />
      <div className="pointer-events-none absolute inset-y-0 rounded border-2 border-accent" style={{ left: pct(range[0]), width: pct(range[1] - range[0]) }} />
      {(['start', 'end'] as const).map((which) => (
        <div
          key={which}
          role="slider"
          aria-label={which === 'start' ? 'Trim start' : 'Trim end'}
          aria-valuenow={Math.round(range[which === 'start' ? 0 : 1])}
          tabIndex={0}
          className="absolute inset-y-0 z-10 flex w-3 -translate-x-1/2 cursor-ew-resize items-center justify-center rounded bg-accent"
          style={{ left: pct(range[which === 'start' ? 0 : 1]) }}
          onPointerDown={(e) => {
            e.stopPropagation();
            drag.current = which;
            trackRef.current?.setPointerCapture(e.pointerId);
          }}
        >
          <div className="h-5 w-0.5 rounded bg-white/80" />
        </div>
      ))}
      <div className="pointer-events-none absolute -inset-y-1 z-20 w-0.5 bg-white" style={{ left: pct(position) }} />
    </div>
  );
}

/** Draws evenly spaced frames using a hidden video element. */
function Filmstrip({ src, duration }: { src: string; duration: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let cancelled = false;
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.src = src;
    const frameW = canvas.width / FILMSTRIP_FRAMES;
    let i = 0;
    const next = () => {
      if (cancelled || i >= FILMSTRIP_FRAMES) return;
      video.currentTime = ((i + 0.5) / FILMSTRIP_FRAMES) * (duration / 1000);
    };
    video.addEventListener('seeked', () => {
      if (cancelled) return;
      const vw = video.videoWidth || 16;
      const vh = video.videoHeight || 9;
      const scale = Math.max(frameW / vw, canvas.height / vh);
      const w = vw * scale;
      const h = vh * scale;
      ctx.save();
      ctx.beginPath();
      ctx.rect(i * frameW, 0, frameW, canvas.height);
      ctx.clip();
      ctx.drawImage(video, i * frameW + (frameW - w) / 2, (canvas.height - h) / 2, w, h);
      ctx.restore();
      i += 1;
      next();
    });
    video.addEventListener('loadeddata', next, { once: true });
    return () => {
      cancelled = true;
      video.removeAttribute('src');
      video.load();
    };
  }, [src, duration]);
  return <canvas ref={canvasRef} width={1200} height={64} className="absolute inset-0 size-full rounded-md opacity-90" />;
}
