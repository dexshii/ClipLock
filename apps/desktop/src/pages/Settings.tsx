import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useParams, Link } from 'react-router-dom';
import { open } from '@tauri-apps/plugin-dialog';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { REPLAY_DURATION_PRESETS_SECONDS } from '@cliplock/shared';
import { PageHeader } from '../components/Layout';
import { HotkeyInput } from '../components/HotkeyInput';
import { Button, Card, Select, SettingRow, Slider, TextInput, Toggle, cx } from '../components/ui';
import { api, errorMessage, updates, type AppInfo, type AppSettings, type AudioDevice, type Codec, type EncoderKind, type UpdateInfo } from '../lib/ipc';
import { ENCODER_LABELS } from '../lib/format';
import { useRecorder } from '../stores/recorder';
import { useSettings } from '../stores/settings';
import { toast } from '../stores/toasts';
import { CaptureSourcePicker, QualityPresets } from '../components/CaptureControls';

export const RESOLUTIONS = [
  { value: 0, label: 'Native' },
  { value: 720, label: '720p' },
  { value: 1080, label: '1080p' },
  { value: 1440, label: '1440p' },
  { value: 2160, label: '2160p (4K)' },
];

export const FRAME_RATES = [
  { value: 30, label: '30 fps' },
  { value: 60, label: '60 fps' },
  { value: 120, label: '120 fps' },
];

const SECTIONS = [
  ['general', 'General'],
  ['recording', 'Recording'],
  ['video', 'Video'],
  ['audio', 'Audio'],
  ['hotkeys', 'Hotkeys'],
  ['storage', 'Storage'],
  ['uploads', 'Uploads'],
  ['privacy', 'Privacy'],
  ['account', 'Account'],
] as const;

type Update = (mutate: (s: AppSettings) => void) => Promise<boolean>;

export function Settings() {
  const { section = 'general' } = useParams();
  const { settings, update } = useSettings();
  if (!settings) return null;
  const props = { s: settings, update };
  return (
    <>
      <PageHeader title="Settings" subtitle="Changes are saved automatically." />
      <div className="flex gap-6 px-6 py-6">
        <nav aria-label="Settings sections" className="w-36 shrink-0">
          <ul className="space-y-0.5">
            {SECTIONS.map(([id, label]) => (
              <li key={id}>
                <NavLink
                  to={`/settings/${id}`}
                  className={() =>
                    cx(
                      'block rounded-md px-3 py-1.5 text-sm transition-colors',
                      section === id ? 'bg-surface-3 font-medium text-fg' : 'text-fg-muted hover:bg-surface-2 hover:text-fg',
                    )
                  }
                >
                  {label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 max-w-3xl flex-1 space-y-5">
          {section === 'general' && <General {...props} />}
          {section === 'recording' && <Recording {...props} />}
          {section === 'video' && <Video {...props} />}
          {section === 'audio' && <Audio {...props} />}
          {section === 'hotkeys' && <Hotkeys {...props} />}
          {section === 'storage' && <Storage {...props} />}
          {section === 'uploads' && <Uploads {...props} />}
          {section === 'privacy' && <Privacy {...props} />}
          {section === 'account' && (
            <Group title="Account">
              <SettingRow title="Cloud account" description="Sign in, manage your profile or delete your account.">
                <Link to="/account" className="text-sm text-accent hover:underline">
                  Open Account
                </Link>
              </SettingRow>
            </Group>
          )}
        </div>
      </div>
    </>
  );
}

function Group({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-1 text-sm font-semibold">{title}</h2>
      {description && <p className="mb-3 text-xs text-fg-muted">{description}</p>}
      <Card className={description ? '' : 'mt-2'}>{children}</Card>
    </section>
  );
}

function General({ s, update }: { s: AppSettings; update: Update }) {
  const g = s.general;
  const [name, setName] = useState('');
  const [exe, setExe] = useState('');
  return (
    <>
      <Group title="General">
        <SettingRow title="Launch ClipLock when Windows starts">
          <Toggle label="Launch on startup" checked={g.launchOnStartup} onChange={(v) => void update((d) => void (d.general.launchOnStartup = v))} />
        </SettingRow>
        <SettingRow title="Start minimized to the tray">
          <Toggle label="Start minimized" checked={g.startMinimized} onChange={(v) => void update((d) => void (d.general.startMinimized = v))} />
        </SettingRow>
        <SettingRow title="Keep running in the tray when the window is closed" description="Instant Replay keeps working in the background.">
          <Toggle label="Close to tray" checked={g.closeToTray} onChange={(v) => void update((d) => void (d.general.closeToTray = v))} />
        </SettingRow>
        <SettingRow title="Notifications" description="Clip saved, recording recovered and capture warnings.">
          <Toggle label="Notifications" checked={g.notifications} onChange={(v) => void update((d) => void (d.general.notifications = v))} />
        </SettingRow>
        <SettingRow title="Sound effects" description="A short sound when a clip is saved or a recording starts/stops.">
          <Toggle label="Sound effects" checked={g.soundEffects} onChange={(v) => void update((d) => void (d.general.soundEffects = v))} />
        </SettingRow>
        <SettingRow title="Detect games automatically" description="Reads the name of the active program to tag clips. No game files are touched.">
          <Toggle label="Game detection" checked={g.gameDetection} onChange={(v) => void update((d) => void (d.general.gameDetection = v))} />
        </SettingRow>
      </Group>
      <UpdatesGroup />
      <Group title="Custom games" description="Teach ClipLock about games that aren’t detected automatically.">
        {g.customGames.map((game, i) => (
          <SettingRow key={`${game.executable}-${i}`} title={game.name} description={game.executable}>
            <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => void update((d) => void d.general.customGames.splice(i, 1))}>
              Remove
            </Button>
          </SettingRow>
        ))}
        <form
          className="flex items-center gap-2 px-5 py-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || !exe.trim()) return;
            void update((d) => void d.general.customGames.push({ name: name.trim(), executable: exe.trim() })).then((ok) => {
              if (ok) {
                setName('');
                setExe('');
              }
            });
          }}
        >
          <TextInput placeholder="Game name" value={name} onChange={(e) => setName(e.target.value)} className="flex-1" aria-label="Game name" />
          <TextInput placeholder="game.exe" value={exe} onChange={(e) => setExe(e.target.value)} className="w-48" aria-label="Executable" />
          <Button type="submit" icon={<Plus className="size-4" />}>
            Add
          </Button>
        </form>
      </Group>
    </>
  );
}

function Recording({ s, update }: { s: AppSettings; update: Update }) {
  const r = s.recording;
  const preset = (REPLAY_DURATION_PRESETS_SECONDS as readonly number[]).includes(r.replaySeconds) ? r.replaySeconds : -1;
  const [custom, setCustom] = useState(String(r.replaySeconds));
  const reprobe = () => api.reprobeHardware().then(() => toast.info('Re-detecting hardware…'));
  return (
    <>
    <Group title="Capture setup"><div className="space-y-5 p-5"><CaptureSourcePicker /><QualityPresets /></div></Group>
    <Group title="Instant Replay">
      <SettingRow title="Instant Replay" description="Continuously buffers recent gameplay while ClipLock runs. Starts automatically when ClipLock launches while turned on.">
        <Toggle label="Instant Replay" checked={r.replayEnabled} onChange={(v) => void update((d) => void (d.recording.replayEnabled = v))} />
      </SettingRow>
      <SettingRow title="Replay length" description="How much is saved when you press the save hotkey.">
        <Select
          label="Replay length"
          value={preset}
          onChange={(v) => v > 0 && void update((d) => void (d.recording.replaySeconds = v))}
          options={[
            ...REPLAY_DURATION_PRESETS_SECONDS.map((v) => ({ value: v as number, label: v < 60 ? `${v} seconds` : `${v / 60} minute${v > 60 ? 's' : ''}` })),
            { value: -1, label: 'Custom' },
          ]}
        />
        {preset === -1 && (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              void update((d) => void (d.recording.replaySeconds = Math.round(Number(custom))));
            }}
          >
            <TextInput type="number" min={5} max={1200} value={custom} onChange={(e) => setCustom(e.target.value)} className="w-20" aria-label="Custom length in seconds" />
            <span className="text-xs text-fg-muted">s</span>
          </form>
        )}
        {preset !== -1 && (
          <Button size="sm" variant="ghost" onClick={() => void update((d) => void (d.recording.replaySeconds = 45))}>
            Custom…
          </Button>
        )}
      </SettingRow>
      <SettingRow title="Hardware" description="Re-run encoder detection after changing GPUs or drivers.">
        <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={() => void reprobe()}>
          Re-detect
        </Button>
      </SettingRow>
    </Group>
    </>
  );
}

function Video({ s, update }: { s: AppSettings; update: Update }) {
  const caps = useRecorder((st) => st.state?.capabilities);
  const v = s.video;
  const codecs: Codec[] = caps ? [...new Set(caps.encoders.map((e) => e.codec))] : ['h264'];
  const encoderKinds: EncoderKind[] = ['auto', ...new Set((caps?.encoders ?? []).filter((e) => e.codec === v.codec).map((e) => e.kind))];
  const codecLabel: Record<Codec, string> = { h264: 'H.264 (most compatible)', hevc: 'HEVC / H.265', av1: 'AV1' };
  return (
    <Group title="Video" description="Only options supported by your hardware are shown. Higher settings cost more GPU time and disk space.">
      <SettingRow title="Resolution" description="Output size. “Native” records at your display resolution.">
        <Select label="Resolution" value={v.outputHeight ?? 0} onChange={(x) => void update((d) => void (d.video.outputHeight = x || null))} options={RESOLUTIONS} />
      </SettingRow>
      <SettingRow title="Frame rate">
        <Select label="Frame rate" value={v.fps} onChange={(x) => void update((d) => void (d.video.fps = x))} options={FRAME_RATES} />
      </SettingRow>
      <SettingRow title="Bitrate" description="20 Mbps suits 1080p60. Use more for 1440p and fast-moving games.">
        <Slider label="Bitrate" value={v.bitrateKbps / 1000} min={2} max={100} step={1} onChange={(x) => void update((d) => void (d.video.bitrateKbps = x * 1000))} format={(x) => `${x} Mbps`} />
      </SettingRow>
      <SettingRow title="Codec" description="Shared clips are always converted to H.264 for playback everywhere.">
        <Select
          label="Codec"
          value={v.codec}
          onChange={(x) =>
            void update((d) => {
              d.video.codec = x;
              d.video.encoder = 'auto';
            })
          }
          options={codecs.map((c) => ({ value: c, label: codecLabel[c] }))}
        />
      </SettingRow>
      <SettingRow title="Encoder" description="Automatic picks the GPU encoder and falls back to software if it fails.">
        <Select label="Encoder" value={encoderKinds.includes(v.encoder) ? v.encoder : 'auto'} onChange={(x) => void update((d) => void (d.video.encoder = x))} options={encoderKinds.map((k) => ({ value: k, label: ENCODER_LABELS[k] ?? k }))} />
      </SettingRow>
      <SettingRow title="Capture mouse cursor">
        <Toggle label="Capture cursor" checked={v.captureCursor} onChange={(x) => void update((d) => void (d.video.captureCursor = x))} />
      </SettingRow>
    </Group>
  );
}

function Audio({ s, update }: { s: AppSettings; update: Update }) {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  useEffect(() => {
    void api.audioDevices().then(setDevices);
  }, []);
  const a = s.audio;
  const outputs = devices.filter((d) => d.kind === 'output');
  const inputs = devices.filter((d) => d.kind === 'input');
  const deviceOptions = (list: AudioDevice[]) => [{ value: '', label: 'System default' }, ...list.map((d) => ({ value: d.id, label: d.name }))];
  return (
    <>
      <Group title="Game & system audio">
        <SettingRow title="Record system audio" description="Everything you hear through the selected output device.">
          <Toggle label="System audio" checked={a.systemEnabled} onChange={(x) => void update((d) => void (d.audio.systemEnabled = x))} />
        </SettingRow>
        <SettingRow title="Output device">
          <Select label="Output device" className="w-64" value={a.systemDeviceId ?? ''} onChange={(x) => void update((d) => void (d.audio.systemDeviceId = x || null))} options={deviceOptions(outputs)} />
        </SettingRow>
        <SettingRow title="System volume">
          <Slider label="System volume" value={a.systemVolume} min={0} max={2} step={0.05} onChange={(x) => void update((d) => void (d.audio.systemVolume = x))} format={(x) => `${Math.round(x * 100)}%`} />
        </SettingRow>
      </Group>
      <Group title="Microphone" description="ClipLock never records your microphone unless you turn it on here.">
        <SettingRow title="Record microphone">
          <Toggle label="Microphone" checked={a.micEnabled} onChange={(x) => void update((d) => void (d.audio.micEnabled = x))} />
        </SettingRow>
        <SettingRow title="Input device">
          <Select label="Input device" className="w-64" value={a.micDeviceId ?? ''} onChange={(x) => void update((d) => void (d.audio.micDeviceId = x || null))} options={deviceOptions(inputs)} disabled={!a.micEnabled} />
        </SettingRow>
        <SettingRow title="Microphone volume">
          <Slider label="Microphone volume" value={a.micVolume} min={0} max={2} step={0.05} onChange={(x) => void update((d) => void (d.audio.micVolume = x))} format={(x) => `${Math.round(x * 100)}%`} />
        </SettingRow>
      </Group>
      <Group title="Advanced">
        <SettingRow title="Separate audio tracks" description="Adds system audio and microphone as extra tracks after the mixed track (for editing in other software).">
          <Toggle label="Separate tracks" checked={a.separateTracks} onChange={(x) => void update((d) => void (d.audio.separateTracks = x))} />
        </SettingRow>
        <SettingRow title="Audio bitrate">
          <Select label="Audio bitrate" value={a.bitrateKbps} onChange={(x) => void update((d) => void (d.audio.bitrateKbps = x))} options={[128, 160, 192, 256, 320].map((b) => ({ value: b, label: `${b} kbps` }))} />
        </SettingRow>
      </Group>
    </>
  );
}

function Hotkeys({ s, update }: { s: AppSettings; update: Update }) {
  const rows: [keyof AppSettings['hotkeys'], string, string][] = [
    ['saveReplay', 'Save Instant Replay', 'Saves the last few seconds of gameplay.'],
    ['toggleRecording', 'Start / stop recording', ''],
    ['pauseRecording', 'Pause / resume recording', ''],
    ['toggleReplay', 'Turn Instant Replay on / off', ''],
    ['toggleMicMute', 'Mute / unmute microphone', ''],
  ];
  return (
    <Group title="Hotkeys" description="Hotkeys work while games are focused. Combinations need a modifier unless they use a function key.">
      {rows.map(([key, title, description]) => (
        <SettingRow key={key} title={title} description={description || undefined}>
          <HotkeyInput label={title} value={s.hotkeys[key]} onChange={(v) => void update((d) => void (d.hotkeys[key] = v))} />
        </SettingRow>
      ))}
    </Group>
  );
}

function Storage({ s, update }: { s: AppSettings; update: Update }) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    void api.appInfo().then(setInfo);
  }, []);
  const pick = async (current: string | null) => {
    const dir = await open({ directory: true, defaultPath: current ?? undefined });
    return typeof dir === 'string' ? dir : null;
  };
  return (
    <Group title="Storage">
      <SettingRow title="Clip folder" description={s.storage.clipsDir ?? info?.defaultClipsDir}>
        <Button size="sm" onClick={async () => {
          const dir = await pick(s.storage.clipsDir);
          if (dir) void update((d) => void (d.storage.clipsDir = dir));
        }}>
          Change…
        </Button>
        {s.storage.clipsDir && (
          <Button size="sm" variant="ghost" onClick={() => void update((d) => void (d.storage.clipsDir = null))}>
            Reset
          </Button>
        )}
      </SettingRow>
      <SettingRow title="Replay buffer folder" description={`${s.storage.bufferDir ?? 'App data folder'} · takes effect after restarting ClipLock`}>
        <Button size="sm" onClick={async () => {
          const dir = await pick(s.storage.bufferDir);
          if (dir) void update((d) => void (d.storage.bufferDir = dir));
        }}>
          Change…
        </Button>
      </SettingRow>
      <SettingRow title="Warn when the library exceeds">
        <Select label="Library size warning" value={s.storage.libraryWarningGb} onChange={(x) => void update((d) => void (d.storage.libraryWarningGb = x))} options={[10, 25, 50, 100, 250, 500].map((g) => ({ value: g, label: `${g} GB` }))} />
      </SettingRow>
    </Group>
  );
}

function Uploads({ s, update }: { s: AppSettings; update: Update }) {
  const [url, setUrl] = useState(s.uploads.serverUrl);
  return (
    <Group title="Cloud uploads" description="Uploading is optional and always manual. Leave the server empty to keep ClipLock fully local.">
      <SettingRow title="Server" description="Your ClipLock server, e.g. https://clips.example.com (self-hosted or official).">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void update((d) => void (d.uploads.serverUrl = url.trim().replace(/\/+$/, '')));
          }}
        >
          <TextInput value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" className="w-72" aria-label="Server URL" />
          <Button type="submit" size="sm">
            Save
          </Button>
        </form>
      </SettingRow>
      <SettingRow title="Default visibility" description="Unlisted clips can only be opened with the link.">
        <Select
          label="Default visibility"
          value={s.uploads.defaultVisibility}
          onChange={(x) => void update((d) => void (d.uploads.defaultVisibility = x))}
          options={[
            { value: 'unlisted', label: 'Unlisted' },
            { value: 'public', label: 'Public' },
            { value: 'private', label: 'Private' },
          ]}
        />
      </SettingRow>
      <SettingRow title="Allow viewers to download">
        <Toggle label="Allow download" checked={s.uploads.allowDownload} onChange={(x) => void update((d) => void (d.uploads.allowDownload = x))} />
      </SettingRow>
    </Group>
  );
}

function Privacy({ s, update }: { s: AppSettings; update: Update }) {
  return (
    <>
      <Group title="Privacy">
        <SettingRow title="Announce when capture starts" description="Shows a notification each time Instant Replay starts buffering.">
          <Toggle label="Announce capture" checked={s.privacy.announceCapture} onChange={(x) => void update((d) => void (d.privacy.announceCapture = x))} />
        </SettingRow>
        <SettingRow title="Background recording (Instant Replay)" description="Turn off to make sure nothing is buffered.">
          <Toggle label="Instant Replay" checked={s.recording.replayEnabled} onChange={(x) => void update((d) => void (d.recording.replayEnabled = x))} />
        </SettingRow>
        <SettingRow title="Microphone" description="Off by default.">
          <Toggle label="Microphone" checked={s.audio.micEnabled} onChange={(x) => void update((d) => void (d.audio.micEnabled = x))} />
        </SettingRow>
      </Group>
      <Group title="Your data">
        <div className="space-y-2 px-5 py-4 text-sm text-fg-muted">
          <p>ClipLock collects no telemetry or analytics. Clips never leave this PC unless you upload them.</p>
          <p>The capture indicator in the sidebar and the tray icon always show when ClipLock is capturing.</p>
        </div>
        <SettingRow title="Logs" description="Useful when reporting a bug. Logs never contain your clips.">
          <Button size="sm" onClick={() => void api.openLogDir()}>
            Open log folder
          </Button>
        </SettingRow>
      </Group>
    </>
  );
}

function UpdatesGroup() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void updates.check().then(setInfo).catch(() => undefined);
  }, []);
  const check = async () => {
    setBusy(true);
    try {
      const result = await updates.check();
      setInfo(result);
      if (result.configured && !result.available) toast.info('ClipLock is up to date');
    } catch (e) {
      toast.error('Update check failed', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Group title="Updates">
      <SettingRow
        title={`ClipLock ${info?.currentVersion ?? ''}`}
        description={
          !info
            ? 'Checking…'
            : !info.configured
              ? 'This build has no signed update channel. Get new versions from the releases page.'
              : info.available
                ? `Version ${info.available} is available. Updates are verified against ClipLock's signing key before installing.`
                : 'You are on the latest version.'
        }
      >
        {info?.configured && info.available ? (
          <Button size="sm" variant="primary" loading={busy} onClick={() => {
            setBusy(true);
            updates.install().catch((e) => {
              toast.error('Update failed', errorMessage(e));
              setBusy(false);
            });
          }}>
            Install and restart
          </Button>
        ) : (
          <Button size="sm" loading={busy} disabled={!info?.configured} onClick={() => void check()}>
            Check for updates
          </Button>
        )}
      </SettingRow>
    </Group>
  );
}
