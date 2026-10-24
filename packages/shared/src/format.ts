/** Formats milliseconds as m:ss or h:mm:ss. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** Formats a byte count using binary multiples with decimal-style labels (as Windows Explorer does). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1);
  const value = bytes / 1024 ** exp;
  const digits = exp === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${BYTE_UNITS[exp]}`;
}

export function formatResolution(width: number, height: number): string {
  if (height > 0 && [480, 720, 1080, 1440, 2160].includes(height)) return `${height}p`;
  return `${width}×${height}`;
}

export function clipPageUrl(publicBaseUrl: string, clipId: string): string {
  return `${publicBaseUrl.replace(/\/+$/, '')}/c/${clipId}`;
}

export function clipMediaUrl(publicBaseUrl: string, clipId: string, rendition?: string): string {
  const base = publicBaseUrl.replace(/\/+$/, '');
  return rendition ? `${base}/media/${clipId}/${rendition}.mp4` : `${base}/media/${clipId}.mp4`;
}

export function clipThumbnailUrl(publicBaseUrl: string, clipId: string): string {
  return `${publicBaseUrl.replace(/\/+$/, '')}/media/${clipId}.jpg`;
}
