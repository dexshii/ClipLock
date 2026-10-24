import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  deleteAccountBodySchema,
  displayNameSchema,
  loginBodySchema,
  refreshBodySchema,
  registerBodySchema,
  sessionResponseSchema,
  userSchema,
} from '@cliplock/shared';
import { tx } from '../db.js';
import type { AppContext } from '../app.js';
import {
  dummyPasswordHash,
  hashPassword,
  issueSession,
  requireAuth,
  revokeFamilyOf,
  rotateRefreshToken,
  toUser,
  verifyPassword,
  type UserRow,
} from '../lib/auth.js';
import { HttpError } from '../lib/errors.js';
import { enqueue } from '../lib/jobs.js';

const strict = { rateLimit: { max: 10, timeWindow: '1 minute' } };

export const authRoutes = (ctx: AppContext): FastifyPluginAsyncZod => async (app) => {
  const { db, cfg } = ctx;
  const auth = requireAuth(db);

  app.post('/v1/auth/register', {
    config: strict,
    schema: { tags: ['auth'], body: registerBodySchema, response: { 201: sessionResponseSchema } },
  }, async (req, reply) => {
    if (!cfg.ALLOW_REGISTRATION) throw new HttpError(403, 'registration_closed', 'Registration is disabled on this server.');
    const { email, password, displayName } = req.body;
    const passwordHash = await hashPassword(password);
    const session = await tx(db, async (c) => {
      const { rows } = await c.query<UserRow>(
        `INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3)
         ON CONFLICT (email) DO NOTHING RETURNING id, email, display_name, created_at`,
        [email, passwordHash, displayName],
      );
      if (!rows[0]) throw new HttpError(409, 'email_taken', 'An account with this email already exists.');
      return issueSession(c, cfg, rows[0], req.headers['user-agent']);
    });
    return reply.code(201).send(session);
  });

  app.post('/v1/auth/login', {
    config: strict,
    schema: { tags: ['auth'], body: loginBodySchema, response: { 200: sessionResponseSchema } },
  }, async (req) => {
    const { rows } = await db.query<UserRow & { password_hash: string }>(
      'SELECT id, email, display_name, created_at, password_hash FROM users WHERE email = $1',
      [req.body.email],
    );
    const user = rows[0];
    const ok = await verifyPassword(user?.password_hash ?? (await dummyPasswordHash()), req.body.password);
    if (!user || !ok) throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect.');
    return issueSession(db, cfg, user, req.headers['user-agent']);
  });

  app.post('/v1/auth/refresh', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { tags: ['auth'], body: refreshBodySchema, response: { 200: sessionResponseSchema } },
  }, async (req) => {
    const result = await tx(db, (c) => rotateRefreshToken(c, cfg, req.body.refreshToken, req.headers['user-agent']));
    if (result instanceof HttpError) throw result;
    return result;
  });

  app.post('/v1/auth/logout', {
    schema: { tags: ['auth'], body: z.object({ refreshToken: z.string().optional() }).optional(), response: { 204: z.null() } },
    preHandler: auth,
  }, async (req, reply) => {
    await revokeFamilyOf(db, req.auth!.token);
    if (req.body?.refreshToken) await revokeFamilyOf(db, req.body.refreshToken);
    return reply.code(204).send(null);
  });

  app.get('/v1/me', { schema: { tags: ['account'], response: { 200: userSchema } }, preHandler: auth }, async (req) => {
    const { rows } = await db.query<UserRow>('SELECT id, email, display_name, created_at FROM users WHERE id = $1', [req.auth!.userId]);
    if (!rows[0]) throw new HttpError(401, 'unauthorized', 'Sign in required.');
    return toUser(rows[0]);
  });

  app.patch('/v1/me', {
    schema: { tags: ['account'], body: z.object({ displayName: displayNameSchema }), response: { 200: userSchema } },
    preHandler: auth,
  }, async (req) => {
    const { rows } = await db.query<UserRow>(
      'UPDATE users SET display_name = $2 WHERE id = $1 RETURNING id, email, display_name, created_at',
      [req.auth!.userId, req.body.displayName],
    );
    return toUser(rows[0]!);
  });

  app.get('/v1/me/usage', {
    schema: { tags: ['account'], response: { 200: z.object({ clipCount: z.number(), usedBytes: z.number(), quotaBytes: z.number() }) } },
    preHandler: auth,
  }, async (req) => {
    const { rows } = await db.query<{ count: number; used: number }>(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(size_bytes), 0)::bigint AS used FROM clips WHERE owner_id = $1 AND status <> 'FAILED'`,
      [req.auth!.userId],
    );
    return { clipCount: rows[0]!.count, usedBytes: rows[0]!.used, quotaBytes: cfg.USER_STORAGE_QUOTA_BYTES };
  });

  /** Deletes the account, every clip and all stored media. */
  app.delete('/v1/me', {
    config: strict,
    schema: { tags: ['account'], body: deleteAccountBodySchema, response: { 204: z.null() } },
    preHandler: auth,
  }, async (req, reply) => {
    await tx(db, async (c) => {
      const { rows } = await c.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1 FOR UPDATE', [req.auth!.userId]);
      if (!rows[0] || !(await verifyPassword(rows[0].password_hash, req.body.password))) {
        throw new HttpError(403, 'invalid_credentials', 'Password is incorrect.');
      }
      const clips = await c.query<{ id: string; original_key: string; upload_id: string | null }>(
        'SELECT id, original_key, upload_id FROM clips WHERE owner_id = $1',
        [req.auth!.userId],
      );
      for (const clip of clips.rows) {
        await enqueue(c, 'purge-clip', { clipId: clip.id, originalKey: clip.original_key, uploadId: clip.upload_id });
      }
      await c.query('DELETE FROM users WHERE id = $1', [req.auth!.userId]);
    });
    return reply.code(204).send(null);
  });
};
