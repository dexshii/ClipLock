/**
 * Typed bridge to the Rust backend. Every type here mirrors a serde type in
 * src-tauri/src (camelCase field names).
 */
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type Codec = 'h264' | 'hevc' | 'av1';
export type EncoderKind = 'auto' | 'nvenc' | 'amf' | 'qsv' | 'mediafoundation' | 'software' | 'openh264';

export interface EncoderInfo {
  kind: EncoderKind;
  codec: Codec;
  ffmpegName: string;
  hardware: boolean;
}

export interface Capabilities {
  ffmpegVersion: string;
  encoders: EncoderInfo[];
  hasDdagrab: boolean;
  hasGfxcapture: boolean;
  hasScaleD3d11: boolean;
  hasAac: boolean;
}

export interface EngineStatus {
  running: boolean;
  replay: { seconds: number; bufferedSeconds: number } | null;
  recording: { outputPath: string; elapsedSecs: number; paused: boolean } | null;
  encoder: EncoderInfo | null;
  gpuPath: boolean;
  stats: { frames: number; droppedFrames: number; speed: number } | null;
  lastError: string | null;
  audioWarning: string | null;
  micMuted: boolean;
}

export interface DetectedGame {
  id: string | null;
  name: string;
  executable: string;
  pid: number;
  hwnd: number | null;
}

export type InitState = { state: 'initializing' } | { state: 'ready' } | { state: 'failed'; message: string };

export interface RecorderState {
  init: InitState;
  capabilities: Capabilities | null;
  engine: EngineStatus | null;
  detectedGame: DetectedGame | null;
  manualGame: string | null;
  saving: boolean;
}

export type ClipKind = 'replay' | 'recording' | 'edit' | 'import';
export type ClipStatus = 'LOCAL' | 'QUEUED' | 'UPLOADING' | 'PROCESSING' | 'READY' | 'FAILED';

export interface Clip {
  id: string;
  title: string;
  filePath: string;
  thumbnailPath: string | null;
  gameId: string | null;
  gameName: string | null;
  kind: ClipKind;
  sourceClipId: string | null;
  createdAt: string;
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  sizeBytes: number;
  favorite: boolean;
  status: ClipStatus;
  uploadProgress: number | null;
  uploadError: string | null;
  cloudId: string | null;
  shareUrl: string | null;
  mediaUrl: string | null;
  visibility: 'private' | 'unlisted' | 'public' | null;
  sha256: string | null;
  fileExists: boolean;
}

export type ClipSort = 'newest' | 'oldest' | 'longest' | 'largest' | 'title';

export interface ClipQuery {
  search?: string | null;
  game?: string | null;
  favoritesOnly?: boolean;
  sort?: ClipSort;
}

export interface ClipPatch {
  title?: string;
  favorite?: boolean;
  gameName?: string;
}

export type CaptureTarget = 'display' | 'gameWindow';

export interface AppSettings {
  general: {
    launchOnStartup: boolean;
    startMinimized: boolean;
    closeToTray: boolean;
    notifications: boolean;
    soundEffects: boolean;
    gameDetection: boolean;
    customGames: { name: string; executable: string }[];
  };
  recording: {
    replayEnabled: boolean;
    replaySeconds: number;
    captureTarget: CaptureTarget;
    monitorIndex: number;
  };
  video: {
    outputHeight: number | null;
    fps: number;
    bitrateKbps: number;
    codec: Codec;
    encoder: EncoderKind;
    captureCursor: boolean;
  };
  audio: {
    systemEnabled: boolean;
    systemDeviceId: string | null;
    systemVolume: number;
    micEnabled: boolean;
    micDeviceId: string | null;
    micVolume: number;
    separateTracks: boolean;
    bitrateKbps: number;
  };
  hotkeys: {
    saveReplay: string | null;
    toggleRecording: string | null;
    pauseRecording: string | null;
    toggleReplay: string | null;
    toggleMicMute: string | null;
  };
  storage: {
    clipsDir: string | null;
    bufferDir: string | null;
    libraryWarningGb: number;
  };
  uploads: {
    serverUrl: string;
    defaultVisibility: 'private' | 'unlisted' | 'public';
    allowDownload: boolean;
  };
  privacy: {
    announceCapture: boolean;
  };
  onboardingComplete: boolean;
}

export interface AppInfo {
  version: string;
  os: string;
  arch: string;
  configDir: string;
  dataDir: string;
  logDir: string;
  defaultClipsDir: string;
  ffmpegVersion: string | null;
  debug: boolean;
}

export interface StorageInfo {
  library: { clipCount: number; totalBytes: number; totalDurationMs: number; uploadedCount: number };
  clipsDir: string;
  bufferDir: string;
  bufferBytes: number;
  freeBytes: number | null;
  warningBytes: number;
}

export interface AudioDevice {
  id: string;
  name: string;
  kind: 'output' | 'input';
  isDefault: boolean;
}

export interface EditRequest {
  trimStartMs: number;
  trimEndMs: number;
  speed: number;
  mute: boolean;
  volume: number;
  lossless: boolean;
  title?: string | null;
}

export type EngineEvent =
  | { type: 'pipelineStarted'; encoder: EncoderInfo; gpuPath: boolean; fallback: boolean }
  | { type: 'pipelineStopped' }
  | { type: 'pipelineFailed'; error: string; willRetry: boolean }
  | { type: 'recordingInterrupted'; clip: unknown; error: string }
  | { type: 'audioWarning'; message: string };

export interface CommandError {
  kind: string;
  message: string;
}

/** Extracts a readable message from anything a command can reject with. */
export function errorMessage(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && 'message' in e) return String((e as CommandError).message);
  return 'Something went wrong';
}

export const api = {
  appInfo: () => invoke<AppInfo>('get_app_info'),
  openLogDir: () => invoke<void>('open_log_dir'),
  quit: () => invoke<void>('quit_app'),

  getSettings: () => invoke<AppSettings>('get_settings'),
  updateSettings: (settings: AppSettings) =>
    invoke<{ settings: AppSettings; hotkeyFailures: string[] }>('update_settings', { settings }),

  recorderState: () => invoke<RecorderState>('get_recorder_state'),
  startReplay: () => invoke<void>('start_replay'),
  stopReplay: () => invoke<void>('stop_replay'),
  saveReplay: (seconds?: number) => invoke<Clip>('save_replay', { seconds: seconds ?? null }),
  startRecording: () => invoke<void>('start_recording'),
  stopRecording: () => invoke<Clip>('stop_recording'),
  togglePause: () => invoke<void>('toggle_pause'),
  setMicMuted: (muted: boolean) => invoke<void>('set_mic_muted', { muted }),
  reprobeHardware: () => invoke<void>('reprobe_hardware'),
  audioDevices: () => invoke<AudioDevice[]>('list_audio_devices'),

  listGames: () => invoke<{ id: string; name: string }[]>('list_games'),
  setManualGame: (name: string | null) => invoke<void>('set_manual_game', { name }),

  listClips: (query: ClipQuery = {}) => invoke<Clip[]>('list_clips', { query }),
  clipGames: () => invoke<string[]>('list_clip_games'),
  getClip: (id: string) => invoke<Clip>('get_clip', { id }),
  updateClip: (id: string, patch: ClipPatch) => invoke<Clip>('update_clip', { id, patch }),
  deleteClip: (id: string, deleteFile: boolean) => invoke<boolean>('delete_clip', { id, deleteFile }),
  revealClip: (id: string) => invoke<void>('reveal_clip', { id }),
  exportClip: (id: string, destination: string) => invoke<void>('export_clip', { id, destination }),
  storageInfo: () => invoke<StorageInfo>('storage_info'),
  regenerateThumbnail: (id: string, atSecs?: number) =>
    invoke<Clip>('regenerate_thumbnail', { id, atSecs: atSecs ?? null }),
  exportEdit: (id: string, request: EditRequest) => invoke<Clip>('export_edit', { id, request }),
};

export function on<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(event, (e) => handler(e.payload));
}

/** URL the webview can load a local file from (Tauri asset protocol). */
export function fileUrl(path: string | null | undefined): string | undefined {
  return path ? convertFileSrc(path) : undefined;
}
