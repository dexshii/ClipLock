import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  UPLOAD_PART_SIZE_BYTES,
  clipIdSchema,
  clipListResponseSchema,
  cloudClipSchema,
  completeUploadBodySchema,
  createClipBodySchema,
  createClipResponseSchema,
  partUrlsBodySchema,
  partUrlsResponseSchema,
  updateClipBodySchema,
  uploadedPartsResponseSchema,
} from '@cliplock/shared';
import type { AppContext } from '../app.js';
import { tx, type Queryable } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import { toCloudClip, type ClipRow } from '../lib/clips.js';
import { HttpError, notFound } from '../lib/errors.js';
import { newClipId } from '../lib/ids.js';
import { enqueue } from '../lib/jobs.js';
import { keys } from '../lib/storage.js';

const PART_URL_TTL_SECONDS = 3600;
const idParams = z.object({ id: clipIdSchema });

async function ownedClip(db: Queryable, userId: string, id: string, lock = false): Promise<ClipRow> {
  const { rows } = await db.query<ClipRow>(`SELECT * FROM clips WHERE id = $1 AND owner_id = $2${lock ? ' FOR UPDATE' : ''}`, [id, userId]);
  // Other people's clips are indistinguishable from missing ones.
  if (!rows[0]) throw notFound();
  return rows[0];
}

export const clipRoutes = (ctx: AppContext): FastifyPluginAsyncZod => async (app) => {
  const { db, cfg, storage } = ctx;
  const auth = requireAuth(db);
  const session = (c: ClipRow) => (c.status === 'UPLOADING' ? { partSize: c.part_size, partCount: c.part_count } : null);

  app.post('/v1/clips', {
    schema: { tags: ['clips'], body: createClipBodySchema, response: { 200: createClipResponseSchema, 201: createClipResponseSchema } },
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const userId = req.auth!.userId;
    const body = req.body;
    if (body.sizeBytes > cfg.MAX_UPLOAD_BYTES) {
      throw new HttpError(413, 'too_large', `Clips can be at most ${Math.floor(cfg.MAX_UPLOAD_BYTES / 1024 ** 2)} MB.`);
    }
    if (body.durationMs > cfg.MAX_CLIP_DURATION_SECONDS * 1000) {
      throw new HttpError(422, 'too_long', `Clips can be at most ${Math.floor(cfg.MAX_CLIP_DURATION_SECONDS / 60)} minutes long.`);
    }
    const partCount = Math.ceil(body.sizeBytes / UPLOAD_PART_SIZE_BYTES);
    if (partCount > 10_000) throw new HttpError(413, 'too_large', 'File is too large.');

    const existing = await db.query<ClipRow>(`SELECT * FROM clips WHERE owner_id = $1 AND sha256 = $2 AND status <> 'FAILED'`, [userId, body.sha256]);
    if (existing.rows[0]) {
      const clip = existing.rows[0];
      return reply.code(200).send({ clip: toCloudClip(cfg, clip), upload: session(clip), duplicate: true });
    }

    const usage = await db.query<{ used: number }>(
      `SELECT COALESCE(SUM(size_bytes), 0)::bigint AS used FROM clips WHERE owner_id = $1 AND status <> 'FAILED'`,
      [userId],
    );
    if (usage.rows[0]!.used + body.sizeBytes > cfg.USER_STORAGE_QUOTA_BYTES) {
      throw new HttpError(507, 'quota_exceeded', 'Your cloud storage is full. Delete some uploaded clips first.');
    }

    // A failed earlier attempt with the same content is replaced.
    await db.query(`DELETE FROM clips WHERE owner_id = $1 AND sha256 = $2 AND status = 'FAILED'`, [userId, body.sha256]);

    for (let attempt = 0; attempt < 5; attempt++) {
      const id = newClipId();
      const originalKey = keys.original(id);
      const uploadId = await storage.createMultipart(originalKey, 'video/mp4');
      try {
        const { rows } = await db.query<ClipRow>(
          `INSERT INTO clips (id, owner_id, title, game_name, status, visibility, allow_download, duration_ms, width, height,
                              size_bytes, sha256, original_key, upload_id, part_size, part_count, recorded_at)
           VALUES ($1, $2, $3, $4, 'UPLOADING', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
           RETURNING *`,
          [id, userId, body.title, body.gameName ?? null, body.visibility, body.allowDownload, body.durationMs, body.width, body.height,
            body.sizeBytes, body.sha256, originalKey, uploadId, UPLOAD_PART_SIZE_BYTES, partCount, body.recordedAt ?? null],
        );
        const clip = rows[0]!;
        return reply.code(201).send({ clip: toCloudClip(cfg, clip), upload: session(clip), duplicate: false });
      } catch (e) {
        await storage.abortMultipart(originalKey, uploadId);
        const code = (e as { code?: string; constraint?: string }).code;
        if (code === '23505' && (e as { constraint?: string }).constraint === 'clips_owner_sha') {
          // Raced with an identical request.
          const again = await db.query<ClipRow>(`SELECT * FROM clips WHERE owner_id = $1 AND sha256 = $2 AND status <> 'FAILED'`, [userId, body.sha256]);
          if (again.rows[0]) return reply.code(200).send({ clip: toCloudClip(cfg, again.rows[0]), upload: session(again.rows[0]), duplicate: true });
        }
        if (code !== '23505') throw e; // otherwise: id collision, try another id
      }
    }
    throw new HttpError(500, 'id_exhausted', 'Could not allocate a clip id.');
  });

  app.post('/v1/clips/:id/upload/parts', {
    schema: { tags: ['uploads'], params: idParams, body: partUrlsBodySchema, response: { 200: partUrlsResponseSchema } },
    preHandler: auth,
  }, async (req) => {
    const clip = await ownedClip(db, req.auth!.userId, req.params.id);
    if (clip.status !== 'UPLOADING' || !clip.upload_id) throw new HttpError(409, 'not_uploading', 'This clip is not accepting uploads.');
    const bad = req.body.partNumbers.find((n) => n > clip.part_count);
    if (bad) throw new HttpError(400, 'bad_part', `Part ${bad} is out of range.`);
    const parts = await Promise.all(
      [...new Set(req.body.partNumbers)].map(async (partNumber) => ({
        partNumber,
        url: await storage.presignPart(clip.original_key, clip.upload_id!, partNumber, PART_URL_TTL_SECONDS),
      })),
    );
    return { parts, expiresAt: new Date(Date.now() + PART_URL_TTL_SECONDS * 1000).toISOString() };
  });

  app.get('/v1/clips/:id/upload/parts', {
    schema: { tags: ['uploads'], params: idParams, response: { 200: uploadedPartsResponseSchema } },
    preHandler: auth,
  }, async (req) => {
    const clip = await ownedClip(db, req.auth!.userId, req.params.id);
    if (clip.status !== 'UPLOADING' || !clip.upload_id) throw new HttpError(409, 'not_uploading', 'This clip is not accepting uploads.');
    return { parts: await storage.listParts(clip.original_key, clip.upload_id) };
  });

  app.post('/v1/clips/:id/upload/complete', {
    schema: { tags: ['uploads'], params: idParams, body: completeUploadBodySchema, response: { 200: cloudClipSchema } },
    preHandler: auth,
  }, async (req) => {
    const userId = req.auth!.userId;
    const clip = await ownedClip(db, userId, req.params.id);
    if (clip.status === 'PROCESSING' || clip.status === 'READY') return toCloudClip(cfg, clip); // idempotent
    if (clip.status !== 'UPLOADING' || !clip.upload_id) throw new HttpError(409, 'not_uploading', 'This clip is not accepting uploads.');
    const numbers = req.body.parts.map((p) => p.partNumber).sort((a, b) => a - b);
    if (numbers.length !== clip.part_count || numbers.some((n, i) => n !== i + 1)) {
      throw new HttpError(400, 'incomplete', `Expected parts 1–${clip.part_count}.`);
    }
    await storage.completeMultipart(clip.original_key, clip.upload_id, req.body.parts);
    const head = await storage.head(clip.original_key);
    if (!head || head.size !== clip.size_bytes) {
      await storage.deletePrefix(`originals/${clip.id}/`);
      await db.query(`UPDATE clips SET status = 'FAILED', error = 'Uploaded size does not match', upload_id = NULL, updated_at = now() WHERE id = $1`, [clip.id]);
      throw new HttpError(422, 'size_mismatch', 'The uploaded file does not match the announced size.');
    }
    const updated = await tx(db, async (c) => {
      const { rows } = await c.query<ClipRow>(
        `UPDATE clips SET status = 'PROCESSING', upload_id = NULL, updated_at = now() WHERE id = $1 AND status = 'UPLOADING' RETURNING *`,
        [clip.id],
      );
      if (rows[0]) await enqueue(c, 'process-clip', { clipId: clip.id });
      return rows[0] ?? (await ownedClip(c, userId, clip.id));
    });
    return toCloudClip(cfg, updated);
  });

  /** Cancels an upload in progress and forgets the clip. */
  app.delete('/v1/clips/:id/upload', {
    schema: { tags: ['uploads'], params: idParams, response: { 204: z.null() } },
    preHandler: auth,
  }, async (req, reply) => {
    const clip = await ownedClip(db, req.auth!.userId, req.params.id);
    if (clip.status !== 'UPLOADING') throw new HttpError(409, 'not_uploading', 'This clip is not uploading.');
    if (clip.upload_id) await storage.abortMultipart(clip.original_key, clip.upload_id);
    await db.query('DELETE FROM clips WHERE id = $1', [clip.id]);
    return reply.code(204).send(null);
  });

  app.get('/v1/clips', {
    schema: {
      tags: ['clips'],
      querystring: z.object({ cursor: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }),
      response: { 200: clipListResponseSchema },
    },
    preHandler: auth,
  }, async (req) => {
    let after: [string, string] | null = null;
    if (req.query.cursor) {
      const [ts, id] = Buffer.from(req.query.cursor, 'base64url').toString().split('|');
      if (!ts || !id || Number.isNaN(Date.parse(ts))) throw new HttpError(400, 'bad_cursor', 'Invalid cursor.');
      after = [ts, id];
    }
    const { rows } = await db.query<ClipRow>(
      `SELECT * FROM clips WHERE owner_id = $1 AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3))
       ORDER BY created_at DESC, id DESC LIMIT $4`,
      [req.auth!.userId, after?.[0] ?? null, after?.[1] ?? null, req.query.limit + 1],
    );
    const page = rows.slice(0, req.query.limit);
    const last = page[page.length - 1];
    return {
      clips: page.map((c) => toCloudClip(cfg, c)),
      nextCursor: rows.length > req.query.limit && last ? Buffer.from(`${last.created_at.toISOString()}|${last.id}`).toString('base64url') : null,
    };
  });

  app.get('/v1/clips/:id', {
    schema: { tags: ['clips'], params: idParams, response: { 200: cloudClipSchema } },
    preHandler: auth,
  }, async (req) => toCloudClip(cfg, await ownedClip(db, req.auth!.userId, req.params.id)));

  app.patch('/v1/clips/:id', {
    schema: { tags: ['clips'], params: idParams, body: updateClipBodySchema, response: { 200: cloudClipSchema } },
    preHandler: auth,
  }, async (req) => {
    await ownedClip(db, req.auth!.userId, req.params.id);
    const { title, visibility, allowDownload } = req.body;
    const { rows } = await db.query<ClipRow>(
      `UPDATE clips SET title = COALESCE($2, title), visibility = COALESCE($3, visibility),
              allow_download = COALESCE($4, allow_download), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, title ?? null, visibility ?? null, allowDownload ?? null],
    );
    return toCloudClip(cfg, rows[0]!);
  });

  /** Deletes the clip and (asynchronously) all of its stored media. */
  app.delete('/v1/clips/:id', {
    schema: { tags: ['clips'], params: idParams, response: { 204: z.null() } },
    preHandler: auth,
  }, async (req, reply) => {
    await tx(db, async (c) => {
      const clip = await ownedClip(c, req.auth!.userId, req.params.id, true);
      await enqueue(c, 'purge-clip', { clipId: clip.id, originalKey: clip.original_key, uploadId: clip.upload_id });
      await c.query('DELETE FROM clips WHERE id = $1', [clip.id]);
    });
    return reply.code(204).send(null);
  });
};
