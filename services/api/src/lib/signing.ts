import { createHmac, timingSafeEqual } from 'node:crypto';

/** Short-lived signed URLs for private media: HMAC over clip, asset and expiry. */
export function signMedia(secret: string, clipId: string, asset: string, expiresAt: number): string {
  return createHmac('sha256', secret).update(`${clipId}\n${asset}\n${expiresAt}`).digest('base64url');
}

export function verifyMedia(secret: string, clipId: string, asset: string, exp: unknown, sig: unknown, now = Date.now()): boolean {
  if (typeof exp !== 'string' || typeof sig !== 'string' || !/^\d{1,13}$/.test(exp)) return false;
  const expiresAt = Number(exp);
  if (expiresAt * 1000 < now) return false;
  const expected = Buffer.from(signMedia(secret, clipId, asset, expiresAt));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
