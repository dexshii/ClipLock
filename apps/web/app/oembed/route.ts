import { NextResponse } from 'next/server';
import { fetchPublicClip } from '@/lib/api';
import { embedUrl, SITE_NAME } from '@/lib/clip-meta';

/** oEmbed (https://oembed.com) for clip pages. */
export async function GET(req: Request) {
  const target = new URL(req.url).searchParams.get('url') ?? '';
  const id = /\/c\/([A-Za-z0-9]{10})\/?$/.exec(target)?.[1];
  const clip = id ? await fetchPublicClip(id) : null;
  if (!clip) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const width = Math.min(clip.width, 1280);
  const height = Math.round((width * clip.height) / clip.width);
  return NextResponse.json(
    {
      version: '1.0',
      type: 'video',
      provider_name: SITE_NAME,
      provider_url: new URL(clip.pageUrl).origin,
      title: clip.title,
      author_name: clip.author.displayName,
      thumbnail_url: clip.thumbnailUrl,
      width,
      height,
      html: `<iframe src="${embedUrl(clip)}" width="${width}" height="${height}" frameborder="0" allow="autoplay; fullscreen" allowfullscreen></iframe>`,
    },
    { headers: { 'Cache-Control': 'public, max-age=60' } },
  );
}
