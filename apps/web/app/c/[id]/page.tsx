import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { formatDuration } from '@cliplock/shared';
import { ClipPlayer } from '@/components/ClipPlayer';
import { CopyButton } from '@/components/CopyButton';
import { Header } from '@/components/Header';
import { fetchPublicClip } from '@/lib/api';
import { clipMetadata } from '@/lib/clip-meta';

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const clip = await fetchPublicClip((await params).id);
  // Missing and private clips get the same generic, non-indexable metadata.
  if (!clip) return { title: 'Clip not found', robots: { index: false, follow: false } };
  return {
    ...clipMetadata(clip),
    alternates: {
      canonical: clip.pageUrl,
      types: { 'application/json+oembed': `/oembed?url=${encodeURIComponent(clip.pageUrl)}` },
    },
  };
}

export default async function ClipPage({ params }: Props) {
  const clip = await fetchPublicClip((await params).id);
  if (!clip) notFound();
  const uploaded = new Date(clip.createdAt);
  return (
    <>
      <Header />
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="overflow-hidden rounded-lg border border-line bg-black">
          <ClipPlayer renditions={clip.renditions} poster={clip.thumbnailUrl} title={clip.title} />
        </div>
        <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="break-words text-xl font-semibold tracking-tight sm:text-2xl">{clip.title}</h1>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-muted">
              {clip.gameName && <span className="rounded bg-surface-3 px-1.5 py-0.5 text-xs font-medium text-fg">{clip.gameName}</span>}
              <span>{clip.author.displayName}</span>
              <span className="text-fg-subtle">·</span>
              <span>{formatDuration(clip.durationMs)}</span>
              <span className="text-fg-subtle">·</span>
              <time dateTime={clip.createdAt}>{uploaded.toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })}</time>
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <CopyButton text={clip.pageUrl} label="Copy link" primary />
            <CopyButton text={clip.mediaUrl} label="Copy video link" />
            {clip.downloadUrl && (
              <a href={clip.downloadUrl} className="inline-flex h-9 items-center rounded-md border border-line bg-surface-3 px-3.5 text-sm font-medium transition-colors hover:bg-line-strong">
                Download
              </a>
            )}
          </div>
        </div>
      </main>
    </>
  );
}
