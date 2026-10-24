import type { AppSettings } from './ipc';

export const CAPTURE_PROFILES = [
  { id: 'performance', name: 'Performance', detail: '720p · 30 fps · 8 Mbps', height: 720, fps: 30, bitrate: 8_000 },
  { id: 'balanced', name: 'Balanced', detail: '1080p · 60 fps · 20 Mbps', height: 1080, fps: 60, bitrate: 20_000 },
  { id: 'quality', name: 'High quality', detail: '1440p · 60 fps · 35 Mbps', height: 1440, fps: 60, bitrate: 35_000 },
] as const;
export type CaptureProfile = typeof CAPTURE_PROFILES[number]['id'];

export function applyCaptureProfile(settings: AppSettings, id: CaptureProfile): void {
  const profile = CAPTURE_PROFILES.find((p) => p.id === id)!;
  Object.assign(settings.video, {
    outputHeight: profile.height, fps: profile.fps, bitrateKbps: profile.bitrate,
    codec: 'h264', encoder: 'auto',
  });
}

export function selectedCaptureProfile(settings: AppSettings): CaptureProfile | 'custom' {
  const v = settings.video;
  return CAPTURE_PROFILES.find((p) => p.height === v.outputHeight && p.fps === v.fps && p.bitrate === v.bitrateKbps
    && v.codec === 'h264' && v.encoder === 'auto')?.id ?? 'custom';
}

export function estimatedBytesPerHour(settings: AppSettings): number {
  const a = settings.audio;
  const tracks = a.systemEnabled || a.micEnabled
    ? 1 + (a.separateTracks ? Number(a.systemEnabled) + Number(a.micEnabled) : 0) : 0;
  return (settings.video.bitrateKbps + a.bitrateKbps * tracks) * 1000 / 8 * 3600;
}

export function quickReplayDurations(seconds: number): number[] {
  return [5, 15, 30, 60, 120].filter((duration) => duration <= seconds);
}
