import type { CloudClip, PublicClip, Rendition } from '@cliplock/shared';
import { clipMediaUrl, clipPageUrl, clipThumbnailUrl } from '@cliplock/shared';
import type { Config } from '../config.js';
import type { Queryable } from '../db.js';
import { signMedia } from './signing.js';

export interface ClipRow {
  id: string;
  owner_id: string;
  title: string;
  game_name: string | null;
  status: CloudClip['status'];
  visibility: CloudClip['visibility'];
  allow_download: boolean;
  duration_ms: number;
  width: number;
  height: number;
  size_bytes: number;
  sha256: string;
  original_key: string;
  upload_id: string | null;
  part_size: number;
  part_count: number;
  error: string | null;
  recorded_at: Date | null;
  created_at: Date;
  ready_at: Date | null;
}

export interface RenditionRow {
  clip_id: string;
  label: string;
  object_key: string;
  content_type: string;
  width: number;
  height: number;
  size_bytes: number;
  etag: string | null;
}

export const PLAYBACK = 'playback';
export const PRIVATE_URL_TTL_SECONDS = 3600;

/** Media URL for the owner; private clips get a short-lived signed URL. */
export function ownerMediaUrl(cfg: Config, clip: ClipRow, asset: string): string {
  const base = asset === 'thumbnail' ? clipThumbnailUrl(cfg.PUBLIC_BASE_URL, clip.id) : clipMediaUrl(cfg.PUBLIC_BASE_URL, clip.id, asset === PLAYBACK ? undefined : asset);
  if (clip.visibility !== 'private') return base;
  const exp = Math.floor(Date.now() / 1000) + PRIVATE_URL_TTL_SECONDS;
  return `${base}?exp=${exp}&sig=${signMedia(cfg.MEDIA_SIGNING_SECRET, clip.id, asset, exp)}`;
}

export function toCloudClip(cfg: Config, row: ClipRow): CloudClip {
  const ready = row.status === 'READY';
  return {
    id: row.id,
    title: row.title,
    gameName: row.game_name,
    status: row.status,
    visibility: row.visibility,
    allowDownload: row.allow_download,
    durationMs: row.duration_ms,
    width: row.width,
    height: row.height,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    createdAt: row.created_at.toISOString(),
    readyAt: row.ready_at?.toISOString() ?? null,
    error: row.error,
    shareUrl: clipPageUrl(cfg.PUBLIC_BASE_URL, row.id),
    mediaUrl: ready ? ownerMediaUrl(cfg, row, PLAYBACK) : null,
    thumbnailUrl: ready ? ownerMediaUrl(cfg, row, 'thumbnail') : null,
  };
}

export async function renditionsOf(db: Queryable, clipId: string): Promise<RenditionRow[]> {
  const { rows } = await db.query<RenditionRow>('SELECT * FROM renditions WHERE clip_id = $1 ORDER BY height DESC', [clipId]);
  return rows;
}

export function toPublicClip(cfg: Config, row: ClipRow, author: string, renditions: RenditionRow[]): PublicClip {
  const videos: Rendition[] = renditions
    .filter((r) => r.content_type === 'video/mp4')
    .map((r) => ({
      label: r.label === PLAYBACK ? `${r.height}p` : r.label,
      width: r.width,
      height: r.height,
      sizeBytes: r.size_bytes,
      contentType: r.content_type,
      url: clipMediaUrl(cfg.PUBLIC_BASE_URL, row.id, r.label === PLAYBACK ? undefined : r.label),
    }));
  const playback = renditions.find((r) => r.label === PLAYBACK);
  const mediaUrl = clipMediaUrl(cfg.PUBLIC_BASE_URL, row.id);
  return {
    id: row.id,
    title: row.title,
    gameName: row.game_name,
    author: { displayName: author },
    durationMs: row.duration_ms,
    width: playback?.width ?? row.width,
    height: playback?.height ?? row.height,
    createdAt: (row.ready_at ?? row.created_at).toISOString(),
    visibility: row.visibility,
    allowDownload: row.allow_download,
    pageUrl: clipPageUrl(cfg.PUBLIC_BASE_URL, row.id),
    mediaUrl,
    thumbnailUrl: clipThumbnailUrl(cfg.PUBLIC_BASE_URL, row.id),
    renditions: videos,
    downloadUrl: row.allow_download ? `${mediaUrl}?download=1` : null,
  };
}
