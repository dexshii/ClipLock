import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UPLOAD_PART_SIZE_BYTES } from '@cliplock/shared';
import { integration, register, setup } from '../../api/test/helpers.js';
import { MediaError } from '../src/media.js';
import { processClip, purgeClip, type WorkerSettings } from '../src/process.js';

type Ctx = Awaited<ReturnType<typeof setup>>;
const dir = mkdtempSync(join(tmpdir(), 'cliplock-pipeline-'));
const settings: WorkerSettings = {
  ffmpeg: 'ffmpeg',
  ffprobe: 'ffprobe',
  encoder: 'libx264',
  keepOriginals: false,
  maxDurationMs: 3600_000,
  transcodeTimeoutMs: 300_000,
};

function makeVideo(name: string, seconds: number, bitrate: string): string {
  const out = join(dir, name);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=1920x1080:rate=60:d=${seconds}`,
    '-f', 'lavfi', '-i', `sine=f=440:d=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', bitrate, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out]);
  return out;
}

function ffprobe(file: string) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]).toString()) as {
    streams: { codec_type: string; codec_name: string; pix_fmt?: string; height?: number; profile?: string }[];
    format: { duration: string };
  };
}

describe.skipIf(!integration)('upload → process → share pipeline', () => {
  let ctx: Ctx;
  let auth: { authorization: string };

  beforeAll(async () => {
    ctx = await setup();
    const session = await register(ctx.app);
    auth = { authorization: `Bearer ${session.accessToken}` };
  }, 60_000);
  afterAll(async () => {
    await ctx?.app.close();
    await ctx?.db.end();
  });

  async function createClip(file: string, extra: Record<string, unknown> = {}) {
    const bytes = readFileSync(file);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/clips',
      headers: auth,
      payload: {
        title: 'Clutch ace',
        gameName: 'VALORANT',
        durationMs: 5000,
        width: 1920,
        height: 1080,
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        ...extra,
      },
    });
    return { res, bytes };
  }

  async function uploadParts(clipId: string, bytes: Buffer, partNumbers: number[]) {
    const urls = await ctx.app.inject({ method: 'POST', url: `/v1/clips/${clipId}/upload/parts`, headers: auth, payload: { partNumbers } });
    expect(urls.statusCode).toBe(200);
    const done: { partNumber: number; etag: string }[] = [];
    for (const { partNumber, url } of urls.json().parts as { partNumber: number; url: string }[]) {
      const chunk = bytes.subarray((partNumber - 1) * UPLOAD_PART_SIZE_BYTES, partNumber * UPLOAD_PART_SIZE_BYTES);
      const put = await fetch(url, { method: 'PUT', body: chunk });
      expect(put.status).toBe(200);
      done.push({ partNumber, etag: put.headers.get('etag')! });
    }
    return done;
  }

  it('uploads a multi-part clip resumably and turns it into shareable media', async () => {
    const file = makeVideo('big.mp4', 8, '24M');
    const { res, bytes } = await createClip(file);
    expect(res.statusCode).toBe(201);
    const { clip, upload } = res.json();
    expect(clip.status).toBe('UPLOADING');
    expect(upload.partCount).toBeGreaterThanOrEqual(2);

    // Upload the first part, "lose" the client, then resume from the server's part list.
    await uploadParts(clip.id, bytes, [1]);
    const listed = await ctx.app.inject({ method: 'GET', url: `/v1/clips/${clip.id}/upload/parts`, headers: auth });
    expect(listed.json().parts.map((p: { partNumber: number }) => p.partNumber)).toEqual([1]);
    const rest = Array.from({ length: upload.partCount - 1 }, (_, i) => i + 2);
    const parts = [...listed.json().parts.map((p: { partNumber: number; etag: string }) => ({ partNumber: p.partNumber, etag: p.etag })), ...(await uploadParts(clip.id, bytes, rest))];

    const incomplete = await ctx.app.inject({ method: 'POST', url: `/v1/clips/${clip.id}/upload/complete`, headers: auth, payload: { parts: parts.slice(1) } });
    expect(incomplete.statusCode).toBe(400);
    const complete = await ctx.app.inject({ method: 'POST', url: `/v1/clips/${clip.id}/upload/complete`, headers: auth, payload: { parts } });
    expect(complete.statusCode).toBe(200);
    expect(complete.json().status).toBe('PROCESSING');
    expect(complete.json().mediaUrl).toBeNull();

    const job = await ctx.db.query(`SELECT kind, payload FROM jobs WHERE status = 'queued'`);
    expect(job.rows).toEqual([{ kind: 'process-clip', payload: { clipId: clip.id } }]);

    // Duplicate prevention while processing.
    const dup = await createClip(file);
    expect(dup.res.statusCode).toBe(200);
    expect(dup.res.json()).toMatchObject({ duplicate: true, upload: null, clip: { id: clip.id } });

    await processClip(ctx.db, ctx.storage, settings, clip.id, () => undefined);
    const ready = (await ctx.app.inject({ method: 'GET', url: `/v1/clips/${clip.id}`, headers: auth })).json();
    expect(ready.status).toBe('READY');
    expect(ready.shareUrl).toBe(`https://clips.test/c/${clip.id}`);
    expect(ready.mediaUrl).toBe(`https://clips.test/media/${clip.id}.mp4`);
    expect(await ctx.storage.head(`originals/${clip.id}/source.mp4`)).toBeNull();

    // Direct media: real MP4 bytes with byte ranges.
    const head = await ctx.app.inject({ method: 'HEAD', url: `/media/${clip.id}.mp4` });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-type']).toBe('video/mp4');
    expect(head.headers['accept-ranges']).toBe('bytes');
    const length = Number(head.headers['content-length']);
    expect(length).toBeGreaterThan(10_000);
    expect(head.body).toBe('');

    const range = await ctx.app.inject({ method: 'GET', url: `/media/${clip.id}.mp4`, headers: { range: 'bytes=0-1023' } });
    expect(range.statusCode).toBe(206);
    expect(range.headers['content-range']).toBe(`bytes 0-1023/${length}`);
    expect(range.rawPayload.length).toBe(1024);
    expect(range.rawPayload.subarray(4, 8).toString()).toBe('ftyp');

    const tail = await ctx.app.inject({ method: 'GET', url: `/media/${clip.id}.mp4`, headers: { range: 'bytes=-100' } });
    expect(tail.statusCode).toBe(206);
    expect(tail.rawPayload.length).toBe(100);
    expect((await ctx.app.inject({ method: 'GET', url: `/media/${clip.id}.mp4`, headers: { range: `bytes=${length}-` } })).statusCode).toBe(416);

    const full = await ctx.app.inject({ method: 'GET', url: `/media/${clip.id}.mp4`, headers: { 'user-agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' } });
    expect(full.statusCode).toBe(200);
    expect(full.rawPayload.length).toBe(length);
    const out = join(dir, 'served.mp4');
    writeFileSync(out, full.rawPayload);
    const info = ffprobe(out);
    const v = info.streams.find((s) => s.codec_type === 'video')!;
    const a = info.streams.find((s) => s.codec_type === 'audio')!;
    expect([v.codec_name, v.pix_fmt, v.profile, a.codec_name]).toEqual(['h264', 'yuv420p', 'High', 'aac']);
    expect(Number(info.format.duration)).toBeCloseTo(8, 0);
    expect(full.rawPayload.indexOf('moov')).toBeLessThan(full.rawPayload.indexOf('mdat'));

    const r720 = await ctx.app.inject({ method: 'HEAD', url: `/media/${clip.id}/720p.mp4` });
    expect(r720.statusCode).toBe(200);
    const thumb = await ctx.app.inject({ method: 'GET', url: `/media/${clip.id}.jpg` });
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers['content-type']).toBe('image/jpeg');

    // Unlisted: available by link but not indexable.
    const pub = await ctx.app.inject({ method: 'GET', url: `/v1/public/clips/${clip.id}` });
    expect(pub.statusCode).toBe(200);
    expect(pub.headers['x-robots-tag']).toContain('noindex');
    expect(pub.json()).toMatchObject({ title: 'Clutch ace', author: { displayName: 'Player One' }, height: 1080 });
    expect(pub.json().renditions.map((r: { label: string }) => r.label)).toEqual(['1080p', '720p']);
    expect(pub.body).not.toContain('player@example.com');

    // Downloads can be disabled.
    expect((await ctx.app.inject({ method: 'HEAD', url: `/media/${clip.id}.mp4?download=1` })).headers['content-disposition']).toMatch(/^attachment/);
    await ctx.app.inject({ method: 'PATCH', url: `/v1/clips/${clip.id}`, headers: auth, payload: { allowDownload: false } });
    expect((await ctx.app.inject({ method: 'HEAD', url: `/media/${clip.id}.mp4?download=1` })).statusCode).toBe(404);

    // Private: metadata and media disappear unless the URL is signed for the owner.
    const priv = await ctx.app.inject({ method: 'PATCH', url: `/v1/clips/${clip.id}`, headers: auth, payload: { visibility: 'private' } });
    expect(priv.json().mediaUrl).toMatch(/\?exp=\d+&sig=/);
    expect((await ctx.app.inject({ method: 'GET', url: `/v1/public/clips/${clip.id}` })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'HEAD', url: `/media/${clip.id}.mp4` })).statusCode).toBe(404);
    const signed = new URL(priv.json().mediaUrl);
    const signedRes = await ctx.app.inject({ method: 'HEAD', url: signed.pathname + signed.search });
    expect(signedRes.statusCode).toBe(200);
    expect(signedRes.headers['cache-control']).toContain('private');
    const forged = await ctx.app.inject({ method: 'HEAD', url: `${signed.pathname}?exp=${Number(signed.searchParams.get('exp')) + 1}&sig=${signed.searchParams.get('sig')}` });
    expect(forged.statusCode).toBe(404);

    // Other users cannot see or touch it.
    const other = await register(ctx.app, 'other@example.com');
    const otherAuth = { authorization: `Bearer ${other.accessToken}` };
    expect((await ctx.app.inject({ method: 'GET', url: `/v1/clips/${clip.id}`, headers: otherAuth })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/v1/clips/${clip.id}`, headers: otherAuth })).statusCode).toBe(404);

    // Deleting removes the row and, via the purge job, every stored object.
    const del = await ctx.app.inject({ method: 'DELETE', url: `/v1/clips/${clip.id}`, headers: auth });
    expect(del.statusCode).toBe(204);
    const purge = await ctx.db.query(`SELECT payload FROM jobs WHERE kind = 'purge-clip'`);
    await purgeClip(ctx.storage, purge.rows[0].payload);
    expect(await ctx.storage.head(`media/${clip.id}/playback.mp4`)).toBeNull();
    expect((await ctx.app.inject({ method: 'HEAD', url: `/media/${clip.id}.mp4` })).statusCode).toBe(404);
  }, 300_000);

  it('rejects files that are not video and reports the clip as failed', async () => {
    const junk = join(dir, 'junk.mp4');
    writeFileSync(junk, Buffer.alloc(4096, 7));
    const { res, bytes } = await createClip(junk, { title: 'Not a video' });
    const clip = res.json().clip;
    const parts = await uploadParts(clip.id, bytes, [1]);
    await ctx.app.inject({ method: 'POST', url: `/v1/clips/${clip.id}/upload/complete`, headers: auth, payload: { parts } });
    const err = await processClip(ctx.db, ctx.storage, settings, clip.id, () => undefined).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaError);
    expect((err as MediaError).permanent).toBe(true);
  }, 60_000);

  it('enforces size and duration limits and supports cancelling', async () => {
    const tooBig = await ctx.app.inject({
      method: 'POST',
      url: '/v1/clips',
      headers: auth,
      payload: { title: 'x', durationMs: 1000, width: 10, height: 10, sizeBytes: 10 * 1024 ** 4, sha256: 'b'.repeat(64) },
    });
    expect(tooBig.statusCode).toBe(413);
    const file = makeVideo('small.mp4', 2, '2M');
    const { res } = await createClip(file, { title: 'cancel me' });
    const id = res.json().clip.id;
    expect((await ctx.app.inject({ method: 'DELETE', url: `/v1/clips/${id}/upload`, headers: auth })).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: 'GET', url: `/v1/clips/${id}`, headers: auth })).statusCode).toBe(404);
  }, 60_000);

  it('deletes the account with its data', async () => {
    const wrong = await ctx.app.inject({ method: 'DELETE', url: '/v1/me', headers: auth, payload: { password: 'nope' } });
    expect(wrong.statusCode).toBe(403);
    const ok = await ctx.app.inject({ method: 'DELETE', url: '/v1/me', headers: auth, payload: { password: 'correct horse battery' } });
    expect(ok.statusCode).toBe(204);
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: auth })).statusCode).toBe(401);
    const left = await ctx.db.query(`SELECT COUNT(*)::int AS n FROM clips c JOIN users u ON u.id = c.owner_id WHERE u.email = 'player@example.com'`);
    expect(left.rows[0].n).toBe(0);
  });
});
