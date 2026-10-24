import { describe, expect, it } from 'vitest';
import { mergeClipRanges, planEventClip, resizeClip, type ClipRange } from './timeline.js';

const source = { matchId: 'match-1', recordingId: 'recording-1', startMs: 0, endMs: 60_000 };
const marker = { id: 'kill-1', matchId: 'match-1', atMs: 5_000, kind: 'kill' as const, source: 'deadlock' as const };
const clip: ClipRange = { ...source, startMs: 1_000, endMs: 10_000, markerIds: ['kill-1'] };

describe('match clip planning', () => {
  it('clamps context to retained media at either boundary', () => {
    expect(planEventClip(marker, source, 10_000, 10_000)).toMatchObject({ startMs: 0, endMs: 15_000 });
    expect(planEventClip({ ...marker, atMs: 59_000 }, source, 5_000, 10_000).endMs).toBe(60_000);
  });
  it('rejects foreign events, expired media, empty windows and invalid times', () => {
    expect(() => planEventClip({ ...marker, matchId: 'other' }, source, 1, 1)).toThrow();
    expect(() => planEventClip(marker, { ...source, startMs: 6_000 }, 1, 1)).toThrow();
    expect(() => planEventClip({ ...marker, atMs: 60_000 }, source, 1, 1)).toThrow();
    for (const context of [-1, NaN, Infinity, 0.5]) {
      expect(() => planEventClip(marker, source, context, 1)).toThrow();
    }
    expect(() => planEventClip(marker, source, 0, 0)).toThrow();
  });
  it('extends and trims only within the same retained source', () => {
    expect(resizeClip(clip, source, 0, 20_000)).toMatchObject({ startMs: 0, endMs: 20_000 });
    expect(() => resizeClip(clip, source, 0, 60_001)).toThrow();
    expect(() => resizeClip(clip, { ...source, recordingId: 'other' }, 0, 1)).toThrow();
    expect(clip.startMs).toBe(1_000);
  });
  it('merges overlaps and adjacent clips while preserving montage gaps and marker IDs', () => {
    const ranges = [
      { ...clip, startMs: 20_000, endMs: 25_000 },
      { ...clip, startMs: 10_000, endMs: 12_000, markerIds: ['manual-1'] },
      clip,
    ];
    expect(mergeClipRanges(ranges)).toEqual([
      { ...clip, endMs: 12_000, markerIds: ['kill-1', 'manual-1'] },
      { ...clip, startMs: 20_000, endMs: 25_000 },
    ]);
    expect(clip.endMs).toBe(10_000);
    expect(mergeClipRanges([])).toEqual([]);
    expect(() => mergeClipRanges([clip, { ...clip, recordingId: 'other' }])).toThrow();
  });
});
