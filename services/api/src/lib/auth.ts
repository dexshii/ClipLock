import { randomUUID } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SessionResponse, User } from '@cliplock/shared';
import type { Config } from '../config.js';
import type { Queryable } from '../db.js';
import { hashToken, newToken } from './ids.js';
import { HttpError } from './errors.js';

// OWASP-recommended Argon2id parameters (19 MiB, 2 iterations).
// algorithm 2 = Argon2id (the package exports it as a const enum, unusable with isolatedModules).
const ARGON = { algorithm: 2 as const, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const hashPassword = (password: string) => hash(password, ARGON);

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

/** A real hash to verify against when the email is unknown, so timing doesn't reveal accounts. */
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword('cliplock-timing-equalizer');
  return dummyHash;
}

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  created_at: Date;
}

export function toUser(row: UserRow): User {
  return { id: row.id, email: row.email, displayName: row.display_name, createdAt: row.created_at.toISOString() };
}

/** Issues an access/refresh token pair. Pass `familyId` when rotating. */
export async function issueSession(
  db: Queryable,
  cfg: Config,
  user: UserRow,
  userAgent: string | undefined,
  familyId: string = randomUUID(),
): Promise<SessionResponse> {
  const access = newToken();
  const refresh = newToken();
  const now = Date.now();
  const accessExp = new Date(now + cfg.ACCESS_TOKEN_TTL_SECONDS * 1000);
  const refreshExp = new Date(now + cfg.REFRESH_TOKEN_TTL_DAYS * 86400 * 1000);
  const ua = userAgent?.slice(0, 200) ?? null;
  await db.query(
    `INSERT INTO auth_tokens (token_hash, user_id, kind, family_id, expires_at, user_agent)
     VALUES ($1, $2, 'access', $3, $4, $5), ($6, $2, 'refresh', $3, $7, $5)`,
    [hashToken(access), user.id, familyId, accessExp, ua, hashToken(refresh), refreshExp],
  );
  return {
    user: toUser(user),
    accessToken: access,
    accessTokenExpiresAt: accessExp.toISOString(),
    refreshToken: refresh,
    refreshTokenExpiresAt: refreshExp.toISOString(),
  };
}

/**
 * Rotates a refresh token. Presenting an already-used refresh token means it was
 * copied: the whole token family is revoked and the request rejected.
 */
export async function rotateRefreshToken(
  db: Queryable,
  cfg: Config,
  token: string,
  userAgent?: string,
): Promise<SessionResponse | HttpError> {
  const { rows } = await db.query<{ user_id: string; family_id: string; used_at: Date | null; revoked_at: Date | null; expires_at: Date }>(
    `SELECT user_id, family_id, used_at, revoked_at, expires_at FROM auth_tokens
     WHERE token_hash = $1 AND kind = 'refresh' FOR UPDATE`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row || row.revoked_at || row.expires_at.getTime() < Date.now()) {
    return new HttpError(401, 'invalid_token', 'Session expired. Please sign in again.');
  }
  if (row.used_at) {
    // Returned rather than thrown so the caller's transaction commits the revocation.
    await db.query('UPDATE auth_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [row.family_id]);
    return new HttpError(401, 'token_reused', 'Session was revoked for security reasons. Please sign in again.');
  }
  await db.query('UPDATE auth_tokens SET used_at = now() WHERE token_hash = $1', [hashToken(token)]);
  // Old access tokens of this family stop working once a new pair exists.
  await db.query(`UPDATE auth_tokens SET revoked_at = now() WHERE family_id = $1 AND kind = 'access' AND revoked_at IS NULL`, [row.family_id]);
  const user = await db.query<UserRow>('SELECT id, email, display_name, created_at FROM users WHERE id = $1', [row.user_id]);
  if (!user.rows[0]) return new HttpError(401, 'invalid_token', 'Account no longer exists.');
  return issueSession(db, cfg, user.rows[0], userAgent, row.family_id);
}

export async function revokeFamilyOf(db: Queryable, token: string): Promise<void> {
  await db.query(
    `UPDATE auth_tokens SET revoked_at = now()
     WHERE family_id = (SELECT family_id FROM auth_tokens WHERE token_hash = $1) AND revoked_at IS NULL`,
    [hashToken(token)],
  );
}

export interface AuthContext {
  userId: string;
  token: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length >= 20 && token.length <= 200 ? token : null;
}

/** preHandler that requires a valid access token. */
export function requireAuth(db: Queryable) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const token = bearerToken(req);
    if (!token) throw new HttpError(401, 'unauthorized', 'Sign in required.');
    const { rows } = await db.query<{ user_id: string }>(
      `SELECT user_id FROM auth_tokens
       WHERE token_hash = $1 AND kind = 'access' AND revoked_at IS NULL AND expires_at > now()`,
      [hashToken(token)],
    );
    if (!rows[0]) throw new HttpError(401, 'unauthorized', 'Sign in required.');
    req.auth = { userId: rows[0].user_id, token };
  };
}
