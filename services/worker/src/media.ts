import { spawn } from 'node:child_process';

export class MediaError extends Error {
  /** Permanent errors (bad input) are not retried. */
  constructor(message: string, readonly permanent: boolean) {
    super(message);
  }
}

export interface Probe {
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  videoCodec: string;
}

export function run(bin: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new MediaError(`${bin} timed out after ${Math.round(timeoutMs / 1000)}s`, false));
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new MediaError(`${bin} could not start: ${e.message}`, false));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new MediaError(`${bin} exited with ${code}: ${stderr.trim().split('\n').slice(-4).join(' | ')}`, true));
    });
  });
}

function parseRate(r: string | undefined): number {
  if (!r) return 0;
  const [n, d] = r.split('/').map(Number);
  return d ? (n ?? 0) / d : Number(r) || 0;
}

export async function probe(ffprobe: string, file: string): Promise<Probe> {
  let out: string;
  try {
    out = (await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], 60_000)).stdout;
  } catch (e) {
    throw new MediaError(`not a readable video: ${(e as Error).message}`, true);
  }
  const json = JSON.parse(out) as {
    streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; duration?: string }[];
    format?: { duration?: string; format_name?: string };
  };
  const video = json.streams?.find((s) => s.codec_type === 'video');
  if (!video?.width || !video.height) throw new MediaError('file has no video stream', true);
  const duration = Number(json.format?.duration ?? video.duration ?? 0);
  if (!Number.isFinite(duration) || duration <= 0) throw new MediaError('could not determine duration', true);
  return {
    durationMs: Math.round(duration * 1000),
    width: video.width,
    height: video.height,
    fps: parseRate(video.avg_frame_rate),
    hasAudio: !!json.streams?.some((s) => s.codec_type === 'audio'),
    videoCodec: video.codec_name ?? 'unknown',
  };
}

export interface RenditionSpec {
  label: string;
  maxHeight: number;
  crf: number;
  maxrateKbps: number;
}

/** Web/Discord-friendly H.264 High + AAC-LC in MP4 with the index at the front. */
export function transcodeArgs(input: string, output: string, spec: RenditionSpec, src: Probe, encoder: string): string[] {
  const fps = Math.min(60, Math.round(src.fps || 60));
  const height = Math.min(spec.maxHeight, src.height - (src.height % 2));
  const video =
    encoder === 'libx264'
      ? ['-c:v', 'libx264', '-preset', 'fast', '-crf', String(spec.crf), '-profile:v', 'high']
      : ['-c:v', encoder, '-b:v', `${Math.round(spec.maxrateKbps * 0.7)}k`];
  return [
    '-hide_banner', '-nostdin', '-y', '-loglevel', 'error',
    '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', `scale=-2:${height}:flags=lanczos,format=yuv420p`,
    '-fpsmax', String(fps),
    ...video,
    '-maxrate', `${spec.maxrateKbps}k`, '-bufsize', `${spec.maxrateKbps * 2}k`,
    '-g', String(fps * 2), '-bf', '2',
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000',
    '-map_metadata', '-1', '-movflags', '+faststart',
    '-f', 'mp4', output,
  ];
}

export function thumbnailArgs(input: string, output: string, durationMs: number): string[] {
  const at = Math.min(3, (durationMs / 1000) * 0.3);
  return ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-ss', at.toFixed(2), '-i', input, '-frames:v', '1',
    '-vf', 'scale=1280:-2:flags=lanczos', '-q:v', '3', '-f', 'image2', output];
}

export const RENDITIONS: RenditionSpec[] = [
  { label: 'playback', maxHeight: 1440, crf: 21, maxrateKbps: 14_000 },
  { label: '720p', maxHeight: 720, crf: 23, maxrateKbps: 5_000 },
];
