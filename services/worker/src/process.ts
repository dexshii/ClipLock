import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { keys, type ClipRow, type Db, type Storage } from '@cliplock/api/core';
import { MediaError, probe, RENDITIONS, run, thumbnailArgs, transcodeArgs } from './media.js';

export interface WorkerSettings {
  ffmpeg: string;
  ffprobe: string;
  encoder: string;
  keepOriginals: boolean;
  maxDurationMs: number;
  transcodeTimeoutMs: number;
}

/** Validates an uploaded original, produces playback renditions and a thumbnail, and marks the clip READY. */
export async function processClip(db: Db, storage: Storage, s: WorkerSettings, clipId: string, log: (m: string) => void): Promise<void> {
  const { rows } = await db.query<ClipRow>('SELECT * FROM clips WHERE id = $1', [clipId]);
  const clip = rows[0];
  if (!clip) return log(`clip ${clipId} no longer exists; skipping`);
  if (clip.status === 'READY') return log(`clip ${clipId} already processed`);

  const dir = await mkdtemp(join(tmpdir(), `cliplock-${clipId}-`));
  try {
    const original = join(dir, 'original');
    const object = await storage.get(clip.original_key);
    await pipeline(object.Body as Readable, createWriteStream(original));

    const src = await probe(s.ffprobe, original);
    if (src.durationMs > s.maxDurationMs) throw new MediaError('clip is longer than this server allows', true);
    if (src.width > 8192 || src.height > 8192) throw new MediaError('resolution is too large', true);
    log(`clip ${clipId}: ${src.width}x${src.height} ${src.fps.toFixed(1)}fps ${src.videoCodec} ${(src.durationMs / 1000).toFixed(1)}s`);

    const produced: { label: string; key: string; type: string; width: number; height: number; size: number; etag?: string }[] = [];
    for (const spec of RENDITIONS) {
      if (spec.label !== 'playback' && src.height <= spec.maxHeight) continue;
      const out = join(dir, `${spec.label}.mp4`);
      await run(s.ffmpeg, transcodeArgs(original, out, spec, src, s.encoder), s.transcodeTimeoutMs);
      const info = await probe(s.ffprobe, out);
      const size = (await stat(out)).size;
      const key = keys.rendition(clipId, spec.label);
      const etag = await storage.put(key, createReadStream(out), 'video/mp4', size, 'public, max-age=31536000');
      produced.push({ label: spec.label, key, type: 'video/mp4', width: info.width, height: info.height, size, etag });
    }
    const thumb = join(dir, 'thumbnail.jpg');
    await run(s.ffmpeg, thumbnailArgs(original, thumb, src.durationMs), 120_000);
    const thumbSize = (await stat(thumb)).size;
    const thumbEtag = await storage.put(keys.thumbnail(clipId), createReadStream(thumb), 'image/jpeg', thumbSize, 'public, max-age=31536000');
    const playback = produced.find((p) => p.label === 'playback')!;
    produced.push({ label: 'thumbnail', key: keys.thumbnail(clipId), type: 'image/jpeg', width: 1280, height: Math.round((1280 * playback.height) / playback.width), size: thumbSize, etag: thumbEtag });

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      // The clip may have been deleted while we worked; then just clean up.
      const still = await client.query('SELECT 1 FROM clips WHERE id = $1 FOR UPDATE', [clipId]);
      if (still.rowCount === 0) {
        await client.query('ROLLBACK');
        await storage.deletePrefix(`media/${clipId}/`);
        return log(`clip ${clipId} was deleted during processing`);
      }
      for (const p of produced) {
        await client.query(
          `INSERT INTO renditions (clip_id, label, object_key, content_type, width, height, size_bytes, etag)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (clip_id, label) DO UPDATE SET object_key = $3, content_type = $4, width = $5, height = $6, size_bytes = $7, etag = $8`,
          [clipId, p.label, p.key, p.type, p.width, p.height, p.size, p.etag ?? null],
        );
      }
      await client.query(
        `UPDATE clips SET status = 'READY', error = NULL, duration_ms = $2, width = $3, height = $4, ready_at = now(), updated_at = now()
         WHERE id = $1`,
        [clipId, src.durationMs, src.width, src.height],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
    if (!s.keepOriginals) await storage.deletePrefix(`originals/${clipId}/`);
    log(`clip ${clipId} ready (${produced.map((p) => p.label).join(', ')})`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function markFailed(db: Db, clipId: string, message: string): Promise<void> {
  await db.query(`UPDATE clips SET status = 'FAILED', error = $2, updated_at = now() WHERE id = $1 AND status <> 'READY'`, [clipId, message.slice(0, 500)]);
}

export async function purgeClip(storage: Storage, payload: { clipId: string; originalKey: string; uploadId: string | null }): Promise<void> {
  if (!/^[A-Za-z0-9]{10}$/.test(payload.clipId)) throw new MediaError('invalid clip id in purge job', true);
  if (payload.uploadId) await storage.abortMultipart(payload.originalKey, payload.uploadId);
  await storage.deletePrefix(`originals/${payload.clipId}/`);
  await storage.deletePrefix(`media/${payload.clipId}/`);
}
