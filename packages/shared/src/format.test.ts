import { describe, expect, it } from 'vitest';
import { clipMediaUrl, clipPageUrl, formatBytes, formatDuration, formatResolution } from './format.js';
import { createClipBodySchema, registerBodySchema } from './schemas.js';

describe('formatDuration', () => {
  it('formats short and long durations', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(30_000)).toBe('0:30');
    expect(formatDuration(125_400)).toBe('2:05');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
    expect(formatDuration(-1)).toBe('0:00');
  });
});

describe('formatBytes', () => {
  it('uses sensible precision', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.50 KB');
    expect(formatBytes(50 * 1024 * 1024)).toBe('50.0 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.00 GB');
  });
});

describe('urls', () => {
  it('builds share and media urls without double slashes', () => {
    expect(clipPageUrl('https://cliplock.app/', 'abc123DEF0')).toBe('https://cliplock.app/c/abc123DEF0');
    expect(clipMediaUrl('https://cliplock.app', 'abc123DEF0')).toBe('https://cliplock.app/media/abc123DEF0.mp4');
    expect(clipMediaUrl('https://cliplock.app', 'abc123DEF0', '720p')).toBe(
      'https://cliplock.app/media/abc123DEF0/720p.mp4',
    );
  });
  it('formats resolutions', () => {
    expect(formatResolution(1920, 1080)).toBe('1080p');
    expect(formatResolution(2560, 1080)).toBe('1080p');
    expect(formatResolution(1000, 777)).toBe('1000×777');
  });
});

describe('schemas', () => {
  it('normalizes email and rejects short passwords', () => {
    const ok = registerBodySchema.parse({ email: ' Foo@Example.COM ', password: 'correct horse', displayName: 'Ace_1' });
    expect(ok.email).toBe('foo@example.com');
    expect(registerBodySchema.safeParse({ email: 'a@b.co', password: 'short', displayName: 'Ace' }).success).toBe(false);
  });
  it('validates clip creation payloads', () => {
    const parsed = createClipBodySchema.parse({
      title: 'Ace clutch',
      durationMs: 30_000,
      width: 1920,
      height: 1080,
      sizeBytes: 1000,
      sha256: 'a'.repeat(64),
    });
    expect(parsed.visibility).toBe('unlisted');
    expect(createClipBodySchema.safeParse({ ...parsed, sha256: 'XYZ' }).success).toBe(false);
  });
});
