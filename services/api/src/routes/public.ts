import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { clipIdSchema, publicClipSchema } from '@cliplock/shared';
import type { AppContext } from '../app.js';
import { renditionsOf, toPublicClip, type ClipRow } from '../lib/clips.js';
import { notFound } from '../lib/errors.js';

export const publicRoutes = (ctx: AppContext): FastifyPluginAsyncZod => async (app) => {
  const { db, cfg } = ctx;

  /** Metadata for the public clip page. Private and unfinished clips are reported as missing. */
  app.get('/v1/public/clips/:id', {
    schema: { tags: ['public'], params: z.object({ id: clipIdSchema }), response: { 200: publicClipSchema } },
  }, async (req, reply) => {
    const { rows } = await db.query<ClipRow & { display_name: string }>(
      `SELECT c.*, u.display_name FROM clips c JOIN users u ON u.id = c.owner_id
       WHERE c.id = $1 AND c.status = 'READY' AND c.visibility IN ('public', 'unlisted')`,
      [req.params.id],
    );
    const row = rows[0];
    if (!row) throw notFound();
    reply.header('Cache-Control', 'public, max-age=30');
    if (row.visibility === 'unlisted') reply.header('X-Robots-Tag', 'noindex, nofollow');
    return toPublicClip(cfg, row, row.display_name, await renditionsOf(db, row.id));
  });

  app.get('/v1/health', { schema: { tags: ['meta'], response: { 200: z.object({ ok: z.boolean() }) } } }, async () => {
    await db.query('SELECT 1');
    return { ok: true };
  });

  app.get('/v1/server-info', {
    schema: {
      tags: ['meta'],
      response: {
        200: z.object({
          name: z.literal('cliplock'),
          apiVersion: z.literal(1),
          publicBaseUrl: z.string(),
          registrationOpen: z.boolean(),
          maxUploadBytes: z.number(),
          maxClipDurationSeconds: z.number(),
        }),
      },
    },
  }, async () => ({
    name: 'cliplock' as const,
    apiVersion: 1 as const,
    publicBaseUrl: cfg.PUBLIC_BASE_URL,
    registrationOpen: cfg.ALLOW_REGISTRATION,
    maxUploadBytes: cfg.MAX_UPLOAD_BYTES,
    maxClipDurationSeconds: cfg.MAX_CLIP_DURATION_SECONDS,
  }));
};
