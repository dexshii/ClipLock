import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, CircleDot, Film, HardDrive, Mic, MicOff, Monitor, AppWindow, Search, Star } from 'lucide-react';
import { PageHeader } from '../components/Layout';
import { ClipCard } from '../components/ClipCard';
import { GamePicker } from '../components/GamePicker';
import { RecorderPanel } from '../components/RecorderPanel';
import { Button, Kbd, Spinner, cx } from '../components/ui';
import { api, errorMessage, type Clip, type StorageInfo } from '../lib/ipc';
import { formatBytes } from '../lib/format';
import { useLibrary } from '../stores/library';
import { useRecorder } from '../stores/recorder';
import { useSettings } from '../stores/settings';

export function Home() {
  const library = useLibrary((s) => s.clips);
  const { settings, saving: settingsSaving } = useSettings();
  const { state, busy, toggleReplay, saveReplay } = useRecorder();
  const [clips, setClips] = useState<Clip[]>([]);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [favorites, setFavorites] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.allSettled([api.listClips({ sort: 'newest' }), api.storageInfo()]).then(([result, info]) => {
      if (cancelled) return;
      if (result.status === 'fulfilled') {
        setClips(result.value);
        setError(null);
      } else setError(errorMessage(result.reason));
      if (info.status === 'fulfilled') setStorage(info.value);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [library, refresh]);
  const visible = (favorites ? clips.filter((c) => c.favorite) : clips).slice(0, 12);
  const replay = state?.engine?.replay;
  const desktop = settings?.recording.captureTarget === 'display';
  const source = state?.captureSource;
  const mic = settings?.audio.micEnabled && !state?.engine?.micMuted;
  const ready = state?.init.state === 'ready';
  return (
    <>
      <PageHeader
        title="Workspace"
        subtitle="Local recordings and capture controls."
        actions={
          <Link
            to="/record"
            className="inline-flex h-8 items-center gap-2 rounded-md border border-line-strong bg-surface-2 px-3 text-xs hover:bg-surface-3"
          >
            <CircleDot className="size-3.5" />
            New recording
          </Link>
        }
      />
      <div className="flex min-h-11 flex-wrap items-center gap-x-5 gap-y-2 border-b border-line px-6 py-2 text-[11px] text-fg-muted">
        <span className="flex items-center gap-2 text-fg">
          {source?.type === 'window' ? (
            <AppWindow className="size-3.5 text-fg-subtle" />
          ) : (
            <Monitor className="size-3.5 text-fg-subtle" />
          )}
          {source?.type === 'window'
            ? (state?.manualGame ?? state?.detectedGame?.name ?? 'Game window')
            : `Desktop / Display ${(source?.type === 'monitor' ? source.index : (settings?.recording.monitorIndex ?? 0)) + 1}`}
        </span>
        {settings && (
          <span className="font-mono text-[10px] text-fg-subtle">
            {settings.video.outputHeight ? settings.video.outputHeight + 'p' : 'Native'} / {settings.video.fps} fps /{' '}
            {{ h264: 'H.264', hevc: 'HEVC', av1: 'AV1' }[settings.video.codec]}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5 text-fg-subtle">
          {mic ? <Mic className="size-3" /> : <MicOff className="size-3" />}
          {mic ? 'Mic on' : 'Mic off'}
        </span>
        {!desktop && <GamePicker />}
      </div>
      <div className="grid grid-cols-1 gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_296px]">
        <section className="min-w-0" aria-label="Recent captures">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <h2 className="text-[13px] font-semibold">Recent captures</h2>
              <span className="font-mono text-[10px] text-fg-subtle">{loading ? '…' : error ? '—' : clips.length}</span>
            </div>
            <Link to="/library" className="flex items-center gap-1 text-[11px] text-fg-muted hover:text-fg">
              Open library
              <ArrowUpRight className="size-3" />
            </Link>
          </div>
          <div className="mb-5 flex items-center justify-between border-b border-line">
            <div role="group" aria-label="Recent clip filter" className="flex gap-5">
              <button
                aria-pressed={!favorites}
                onClick={() => setFavorites(false)}
                className={cx(
                  'border-b-2 pb-2.5 text-xs',
                  !favorites ? 'border-fg text-fg' : 'border-transparent text-fg-subtle hover:text-fg',
                )}
              >
                All clips
              </button>
              <button
                aria-pressed={favorites}
                onClick={() => setFavorites(true)}
                className={cx(
                  'flex items-center gap-1.5 border-b-2 pb-2.5 text-xs',
                  favorites ? 'border-fg text-fg' : 'border-transparent text-fg-subtle hover:text-fg',
                )}
              >
                <Star className="size-3" />
                Favorites
              </button>
            </div>
            <Link
              to="/library"
              aria-label="Search library"
              title="Search library"
              className="mb-2 text-fg-subtle hover:text-fg"
            >
              <Search className="size-3.5" />
            </Link>
          </div>
          {error ? (
            <div className="border border-line p-6 text-xs">
              <p className="text-warn">Could not load recordings</p>
              <p className="mt-2 text-fg-muted">{error}</p>
              <Button className="mt-4" size="sm" onClick={() => setRefresh((v) => v + 1)}>
                Try again
              </Button>
            </div>
          ) : loading && clips.length === 0 ? (
            <div className="flex min-h-80 items-center justify-center">
              <Spinner />
            </div>
          ) : visible.length > 0 ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-x-4 gap-y-6">
              {visible.map((clip) => (
                <ClipCard key={clip.id} clip={clip} />
              ))}
            </div>
          ) : (
            <div className="flex min-h-[350px] flex-col items-center justify-center border border-line bg-surface/40 px-6 py-10 text-center">
              <Film className="mb-5 size-7 text-fg-subtle" strokeWidth={1.2} />
              <h3 className="text-sm font-medium">{favorites ? 'No favorites yet' : 'Nothing recorded yet'}</h3>
              <p className="mt-2 max-w-[290px] text-xs leading-relaxed text-fg-subtle">
                {favorites
                  ? 'Star a clip in your library to keep it here.'
                  : 'Save a replay after the moment happens, or start a manual recording.'}
              </p>
              {!favorites && settings?.hotkeys.saveReplay && (
                <div className="mt-6 flex items-center gap-1.5">
                  {settings.hotkeys.saveReplay.split('+').map((key, i) => (
                    <span key={i} className="flex items-center gap-1.5">
                      {i > 0 && <span className="text-[10px] text-fg-subtle">+</span>}
                      <Kbd>{key}</Kbd>
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-6 flex items-center gap-3">
                {favorites ? (
                  <Button size="sm" onClick={() => setFavorites(false)}>
                    Show all clips
                  </Button>
                ) : (
                  <>
                    <Button
                      size="sm"
                      disabled={
                        !ready ||
                        (!!state?.engine?.recording && !replay) ||
                        settingsSaving ||
                        !!busy.record ||
                        (replay ? replay.bufferedSeconds < 1 : false)
                      }
                      loading={busy.replay || busy.save}
                      onClick={() => void (replay ? saveReplay() : toggleReplay())}
                    >
                      {replay ? 'Save first clip' : 'Enable Instant Replay'}
                    </Button>
                    <Link to="/record" className="text-xs text-fg-muted hover:text-fg">
                      Record manually →
                    </Link>
                  </>
                )}
              </div>
            </div>
          )}
          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-3 text-[10px] text-fg-subtle">
            <span className="flex items-center gap-1.5">
              <HardDrive className="size-3" />
              Local library
            </span>
            <span>
              {storage
                ? `${formatBytes(storage.library.totalBytes)} / ${storage.library.clipCount} clip${storage.library.clipCount === 1 ? '' : 's'}`
                : 'Saved on this PC'}
            </span>
            {storage?.freeBytes != null && <span className="ml-auto">{formatBytes(storage.freeBytes)} free</span>}
          </div>
          {storage && storage.library.totalBytes > storage.warningBytes && (
            <p className="mt-3 text-xs text-warn">
              Your library is above its storage warning limit.{' '}
              <Link to="/settings/storage" className="underline">
                Manage storage
              </Link>
            </p>
          )}
        </section>
        <RecorderPanel />
      </div>
    </>
  );
}
