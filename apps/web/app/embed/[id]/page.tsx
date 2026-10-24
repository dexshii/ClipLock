import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ClipPlayer } from '@/components/ClipPlayer';
import { fetchPublicClip } from '@/lib/api';

type Props = { params: Promise<{ id: string }> };

export const metadata: Metadata = { robots: { index: false, follow: false } };

/** Minimal player used for iframe embeds (twitter:player / oEmbed). */
export default async function EmbedPage({ params }: Props) {
  const clip = await fetchPublicClip((await params).id);
  if (!clip) notFound();
  return (
    <main className="flex h-dvh items-center justify-center bg-black">
      <ClipPlayer renditions={clip.renditions} poster={clip.thumbnailUrl} title={clip.title} />
    </main>
  );
}
