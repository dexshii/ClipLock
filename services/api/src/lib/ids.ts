import { createHash, randomBytes, randomInt } from 'node:crypto';
import { CLIP_ID_LENGTH } from '@cliplock/shared';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** 10 base62 characters ≈ 59.5 bits: unguessable enough for unlisted links. */
export function newClipId(): string {
  let id = '';
  for (let i = 0; i < CLIP_ID_LENGTH; i++) id += BASE62[randomInt(BASE62.length)];
  return id;
}

/** 256-bit random bearer token (base64url). */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}
