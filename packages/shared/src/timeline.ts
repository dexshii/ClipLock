import { z } from 'zod';

const milliseconds = z.number().int().nonnegative().safe();

/** Offsets use the recording's media clock, never wall time or the game clock. */
export const matchMarkerSchema = z.object({
  id: z.string().min(1),
  matchId: z.string().min(1),
  atMs: milliseconds,
  kind: z.enum(['manual', 'kill', 'assist', 'multiKill', 'midBoss']),
  source: z.enum(['manual', 'deadlock']),
}).refine((m) => (m.kind === 'manual') === (m.source === 'manual'), {
  message: 'Manual markers must have a manual source; game events must have a Deadlock source',
});
export type MatchMarker = z.infer<typeof matchMarkerSchema>;

/** Retained source bounds: trimming must never imply that deleted video exists. */
export const sourceRangeSchema = z.object({
  matchId: z.string().min(1),
  recordingId: z.string().min(1),
  startMs: milliseconds,
  endMs: milliseconds,
}).refine((r) => r.endMs > r.startMs, 'Source must have a positive duration');
export type SourceRange = z.infer<typeof sourceRangeSchema>;

export const clipRangeSchema = z.object({
  matchId: z.string().min(1),
  recordingId: z.string().min(1),
  startMs: milliseconds,
  endMs: milliseconds,
  markerIds: z.array(z.string().min(1)),
}).refine((r) => r.endMs > r.startMs, 'Clip must have a positive duration');
export type ClipRange = z.infer<typeof clipRangeSchema>;

/** Plan a non-destructive clip; media export is a separate capture-engine operation. */
export function planEventClip(
  marker: MatchMarker,
  source: SourceRange,
  beforeMs: number,
  afterMs: number,
): ClipRange {
  marker = matchMarkerSchema.parse(marker);
  source = sourceRangeSchema.parse(source);
  milliseconds.parse(beforeMs);
  milliseconds.parse(afterMs);
  if (marker.matchId !== source.matchId) throw new Error('Marker belongs to another match');
  if (marker.atMs < source.startMs || marker.atMs >= source.endMs) {
    throw new Error('Marker is outside retained media');
  }
  return clipRangeSchema.parse({
    ...source,
    startMs: Math.max(source.startMs, marker.atMs - beforeMs),
    endMs: marker.atMs + Math.min(afterMs, source.endMs - marker.atMs),
    markerIds: [marker.id],
  });
}

/** Extend or trim against retained media without modifying the recording. */
export function resizeClip(range: ClipRange, source: SourceRange, startMs: number, endMs: number): ClipRange {
  range = clipRangeSchema.parse(range);
  source = sourceRangeSchema.parse(source);
  if (range.matchId !== source.matchId || range.recordingId !== source.recordingId) {
    throw new Error('Clip and source must belong to the same recording');
  }
  const resized = clipRangeSchema.parse({ ...range, startMs, endMs });
  if (resized.startMs < source.startMs || resized.endMs > source.endMs) {
    throw new Error('Requested clip exceeds retained media');
  }
  return resized;
}

/** Merge overlapping/touching ranges, preserving gaps as separate montage items. */
export function mergeClipRanges(ranges: readonly ClipRange[]): ClipRange[] {
  const sorted = ranges.map((r) => clipRangeSchema.parse(r)).sort((a, b) => a.startMs - b.startMs);
  const first = sorted[0];
  if (!first) return [];
  if (sorted.some((r) => r.matchId !== first.matchId || r.recordingId !== first.recordingId)) {
    throw new Error('Cannot merge ranges from different recordings');
  }
  const result: ClipRange[] = [];
  for (const range of sorted) {
    const previous = result.at(-1);
    if (previous && range.startMs <= previous.endMs) {
      previous.endMs = Math.max(previous.endMs, range.endMs);
      previous.markerIds = [...new Set([...previous.markerIds, ...range.markerIds])];
    } else {
      result.push({ ...range, markerIds: [...new Set(range.markerIds)] });
    }
  }
  return result;
}
