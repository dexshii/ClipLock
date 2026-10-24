import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import { CLIP_ID_PATTERN } from '@cliplock/shared';
import type { AppContext } from '../app.js';
import { PLAYBACK, type ClipRow, type RenditionRow } from '../lib/clips.js';
import { parseRange } from '../lib/range.js';
import { verifyMedia } from '../lib/signing.js';

const RENDITION_LABEL = /^[a-z0-9]{1,16}$/;

/** RFC 6266 filename: ASCII fallback plus UTF-8 form. */
function contentDisposition(kind: 'inline' | 'attachment', title: string, ext: string): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 80) || 'clip';
  const ascii = base.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}.${ext}"; filename*=UTF-8''${encodeURIComponent(base)}.${ext}`;
}

/**
 * Direct media endpoints:
 *   GET|HEAD /media/:id.mp4            playback rendition (H.264/AAC, fast start)
 *   GET|HEAD /media/:id/:label.mp4     another rendition (e.g. 720p)
 *   GET|HEAD /media/:id.jpg            thumbnail
 *
 * These return the actual bytes (with byte-range support), never an HTML page, so the
 * URL can be pasted anywhere a video file is accepted. Private clips require a signed
 * URL and are otherwise reported as not found.
 */
export const mediaRoutes = (ctx: AppContext): FastifyPluginAsync => async (app) => {
  const { db, cfg, storage } = ctx;

  const handler = async (req: FastifyRequest, reply: FastifyReply, clipId: string, label: string, ext: 'mp4' | 'jpg') => {
    reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
    const notFound = () => reply.code(404).header('Cache-Control', 'no-store').type('text/plain').send('Not found');
    if (!CLIP_ID_PATTERN.test(clipId) || !RENDITION_LABEL.test(label)) return notFound();

    const { rows } = await db.query<ClipRow & RenditionRow>(
      `SELECT c.*, r.object_key, r.content_type, r.size_bytes AS r_size, r.etag, r.label
       FROM clips c JOIN renditions r ON r.clip_id = c.id
       WHERE c.id = $1 AND r.label = $2 AND c.status = 'READY'`,
      [clipId, label],
    );
    const row = rows[0] as (ClipRow & RenditionRow & { r_size: number }) | undefined;
    if (!row) return notFound();

    const query = req.query as Record<string, unknown>;
    if (row.visibility === 'private' && !verifyMedia(cfg.MEDIA_SIGNING_SECRET, clipId, label, query.exp, query.sig)) {
      return notFound();
    }
    const download = query.download === '1';
    if (download && !row.allow_download) return notFound();

    if (cfg.MEDIA_DELIVERY === 'redirect' && row.visibility !== 'private' && !download) {
      return reply.redirect(`${cfg.MEDIA_CDN_BASE_URL!.replace(/\/+$/, '')}/${row.object_key}`, 302);
    }

    const size = row.r_size;
    const etag = row.etag ?? `"${clipId}-${label}-${size}"`;
    reply
      .header('Content-Type', row.content_type)
      .header('Accept-Ranges', 'bytes')
      .header('ETag', etag)
      .header('Last-Modified', (row.ready_at ?? row.created_at).toUTCString())
      .header('Access-Control-Allow-Origin', '*')
      .header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')
      .header('Content-Disposition', contentDisposition(download ? 'attachment' : 'inline', row.title, ext))
      .header('Cache-Control', row.visibility === 'private' ? 'private, max-age=600' : 'public, max-age=86400');
    if (row.visibility !== 'public') reply.header('X-Robots-Tag', 'noindex, nofollow');

    const range = parseRange(req.headers.range, size);
    if (req.headers['if-none-match'] === etag && range.kind === 'full') return reply.code(304).send();
    if (range.kind === 'unsatisfiable') {
      return reply.code(416).header('Content-Range', `bytes */${size}`).send();
    }
    const [start, end] = range.kind === 'partial' ? [range.start, range.end] : [0, size - 1];
    reply.header('Content-Length', String(end - start + 1));
    if (range.kind === 'partial') reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`);
    if (req.method === 'HEAD') return reply.send();

    const object = await storage.get(row.object_key, range.kind === 'partial' ? `bytes=${start}-${end}` : undefined);
    const body = object.Body as Readable | undefined;
    if (!body) return notFound();
    req.raw.on('close', () => body.destroy());
    return reply.send(body);
  };

  // Explicit HEAD (instead of Fastify's generated one) so HEAD reports the real Content-Length.
  app.route<{ Params: { file: string } }>({
    method: ['GET', 'HEAD'],
    url: '/media/:file',
    handler: async (req, reply) => {
      const m = /^([A-Za-z0-9]+)\.(mp4|jpg)$/.exec(req.params.file);
      if (!m) return reply.code(404).send('Not found');
      return handler(req, reply, m[1]!, m[2] === 'jpg' ? 'thumbnail' : PLAYBACK, m[2] as 'mp4' | 'jpg');
    },
  });

  app.route<{ Params: { id: string; file: string } }>({
    method: ['GET', 'HEAD'],
    url: '/media/:id/:file',
    handler: async (req, reply) => {
      const m = /^([a-z0-9]+)\.mp4$/.exec(req.params.file);
      if (!m || m[1] === 'thumbnail') return reply.code(404).send('Not found');
      return handler(req, reply, req.params.id, m[1]!, 'mp4');
    },
  });
};
