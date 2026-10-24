import { describe, expect, it } from 'vitest';
import { parseRange } from '../src/lib/range.js';
import { signMedia, verifyMedia } from '../src/lib/signing.js';
import { newClipId } from '../src/lib/ids.js';
import { loadConfig } from '../src/config.js';

describe('parseRange', () => {
  it('handles the forms browsers and crawlers send', () => {
    expect(parseRange(undefined, 100)).toEqual({ kind: 'full' });
    expect(parseRange('bytes=0-', 100)).toEqual({ kind: 'partial', start: 0, end: 99 });
    expect(parseRange('bytes=0-1', 100)).toEqual({ kind: 'partial', start: 0, end: 1 });
    expect(parseRange('bytes=90-200', 100)).toEqual({ kind: 'partial', start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ kind: 'partial', start: 90, end: 99 });
    expect(parseRange('bytes=-500', 100)).toEqual({ kind: 'partial', start: 0, end: 99 });
  });
  it('rejects unsatisfiable ranges and ignores malformed ones', () => {
    expect(parseRange('bytes=100-', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=5-2', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=-0', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=0-1,5-6', 100)).toEqual({ kind: 'full' });
    expect(parseRange('items=0-1', 100)).toEqual({ kind: 'full' });
  });
});

describe('signed media URLs', () => {
  const secret = 'x'.repeat(40);
  it('accepts valid signatures and rejects tampering or expiry', () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const sig = signMedia(secret, 'abcdefghij', 'playback', exp);
    expect(verifyMedia(secret, 'abcdefghij', 'playback', String(exp), sig)).toBe(true);
    expect(verifyMedia(secret, 'abcdefghik', 'playback', String(exp), sig)).toBe(false);
    expect(verifyMedia(secret, 'abcdefghij', '720p', String(exp), sig)).toBe(false);
    expect(verifyMedia(secret, 'abcdefghij', 'playback', String(exp + 1), sig)).toBe(false);
    expect(verifyMedia(secret, 'abcdefghij', 'playback', String(exp), sig, (exp + 1) * 1000)).toBe(false);
    expect(verifyMedia(secret, 'abcdefghij', 'playback', undefined, sig)).toBe(false);
  });
});

describe('ids and config', () => {
  it('generates base62 clip ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, newClipId));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9]{10}$/);
  });
  it('requires a strong media signing secret', () => {
    const base = { DATABASE_URL: 'postgres://x', S3_BUCKET: 'bucket', S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 'b' };
    expect(() => loadConfig({ ...base, MEDIA_SIGNING_SECRET: 'short' })).toThrow(/MEDIA_SIGNING_SECRET/);
    expect(loadConfig({ ...base, MEDIA_SIGNING_SECRET: 'y'.repeat(32), PUBLIC_BASE_URL: 'https://a.b/' }).PUBLIC_BASE_URL).toBe('https://a.b');
  });
});
