import type { Metadata } from 'next';
import { formatDuration, type PublicClip } from '@cliplock/shared';

export const SITE_NAME = 'ClipLock';

export function describeClip(clip: PublicClip): string {
  const parts = [clip.gameName, formatDuration(clip.durationMs), `by ${clip.author.displayName}`].filter(Boolean);
  return `${parts.join(' · ')} — watch on ClipLock`;
}

export function embedUrl(clip: PublicClip): string {
  return clip.pageUrl.replace(/\/c\/([A-Za-z0-9]+)$/, '/embed/$1');
}

/**
 * Link-preview metadata for a clip page. The same tags are served to every client:
 * Open Graph video tags pointing at the direct H.264/AAC MP4, plus a Twitter player
 * card (Discord reads both; see docs/discord.md for what was verified).
 */
export function clipMetadata(clip: PublicClip): Metadata {
  const description = describeClip(clip);
  const video = {
    url: clip.mediaUrl,
    secureUrl: clip.mediaUrl.startsWith('https://') ? clip.mediaUrl : undefined,
    type: 'video/mp4',
    width: clip.width,
    height: clip.height,
  };
  const image = { url: clip.thumbnailUrl, secureUrl: clip.thumbnailUrl.startsWith('https://') ? clip.thumbnailUrl : undefined, type: 'image/jpeg', width: 1280, height: Math.round((1280 * clip.height) / clip.width) };
  return {
    title: clip.title,
    description,
    alternates: { canonical: clip.pageUrl },
    robots: clip.visibility === 'public' ? { index: true, follow: true } : { index: false, follow: false },
    openGraph: {
      type: 'video.other',
      siteName: SITE_NAME,
      title: clip.title,
      description,
      url: clip.pageUrl,
      images: [image],
      videos: [video],
    },
    twitter: {
      card: 'player',
      title: clip.title,
      description,
      images: [clip.thumbnailUrl],
      players: [{ playerUrl: embedUrl(clip), streamUrl: clip.mediaUrl, width: clip.width, height: clip.height }],
    },
    other: {
      'twitter:player:stream:content_type': 'video/mp4',
    },
  };
}
