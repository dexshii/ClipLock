import 'server-only';
import { CLIP_ID_PATTERN, publicClipSchema, type PublicClip } from '@cliplock/shared';

const API = (process.env.CLIPLOCK_API_URL ?? 'http://localhost:8080').replace(/\/+$/, '');

/**
 * Loads a public or unlisted clip from the API. Private, unfinished, deleted and
 * unknown clips all come back as `null`, so pages never reveal that they exist.
 */
export async function fetchPublicClip(id: string): Promise<PublicClip | null> {
  if (!CLIP_ID_PATTERN.test(id)) return null;
  const res = await fetch(`${API}/v1/public/clips/${id}`, { next: { revalidate: 30 } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`API responded with ${res.status}`);
  return publicClipSchema.parse(await res.json());
}
