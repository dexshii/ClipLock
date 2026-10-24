import { describe, expect, it } from 'vitest';
import type { PublicClip } from '@cliplock/shared';
import { clipMetadata, embedUrl } from './clip-meta';

const clip: PublicClip = {
  id: 'abcDEF1234',
  title: 'Ace on Ascent',
  gameName: 'VALORANT',
  author: { displayName: 'Ace' },
  durationMs: 30_000,
  width: 1920,
  height: 1080,
  createdAt: '2026-10-24T12:00:00.000Z',
  visibility: 'unlisted',
  allowDownload: true,
  pageUrl: 'https://clips.example.com/c/abcDEF1234',
  mediaUrl: 'https://clips.example.com/media/abcDEF1234.mp4',
  thumbnailUrl: 'https://clips.example.com/media/abcDEF1234.jpg',
  renditions: [],
  downloadUrl: null,
};

describe('clipMetadata', () => {
  it('describes the clip as an MP4 video for link previews', () => {
    const m = clipMetadata(clip);
    const og = m.openGraph as Record<string, unknown> & { videos: Record<string, unknown>[] };
    expect(og.type).toBe('video.other');
    expect(og.videos[0]).toMatchObject({ url: clip.mediaUrl, secureUrl: clip.mediaUrl, type: 'video/mp4', width: 1920, height: 1080 });
    const tw = m.twitter as Record<string, unknown> & { players: Record<string, unknown>[] };
    expect(tw.card).toBe('player');
    expect(tw.players[0]).toMatchObject({ playerUrl: 'https://clips.example.com/embed/abcDEF1234', streamUrl: clip.mediaUrl });
    expect(m.other).toMatchObject({ 'twitter:player:stream:content_type': 'video/mp4' });
    expect(m.description).toBe('VALORANT · 0:30 · by Ace — watch on ClipLock');
  });

  it('keeps unlisted clips out of search engines', () => {
    expect(clipMetadata(clip).robots).toEqual({ index: false, follow: false });
    expect(clipMetadata({ ...clip, visibility: 'public' }).robots).toEqual({ index: true, follow: true });
  });

  it('builds embed urls', () => {
    expect(embedUrl(clip)).toBe('https://clips.example.com/embed/abcDEF1234');
  });
});
