export type RangeResult =
  | { kind: 'full' }
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'unsatisfiable' };

/**
 * Parses a single HTTP byte range against a resource of `size` bytes (RFC 9110 §14.1.2).
 * Multiple ranges are answered with the full resource, which clients must accept.
 */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (!header) return { kind: 'full' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return { kind: 'full' }; // malformed or multi-range: ignore the header
  const [, a, b] = m;
  if (a === '' && b === '') return { kind: 'unsatisfiable' };
  let start: number;
  let end: number;
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0) return { kind: 'unsatisfiable' };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
    if (b !== '' && Number(b) < start) return { kind: 'unsatisfiable' };
  }
  if (start >= size || size === 0) return { kind: 'unsatisfiable' };
  return { kind: 'partial', start, end };
}
