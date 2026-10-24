import { Link } from 'react-router-dom';
import { Cloud, CloudOff, FileWarning, Film, Play, Star } from 'lucide-react';
import { fileUrl, type Clip } from '../lib/ipc';
import { formatBytes, formatDuration, formatResolution, relativeTime } from '../lib/format';
import { Badge, cx } from './ui';

export function UploadBadge({ clip }: { clip: Clip }) {
  switch (clip.status) {
    case 'READY':
      return (
        <Badge tone="ok">
          <Cloud className="size-3" />
          {clip.visibility === 'public' ? 'Public' : clip.visibility === 'private' ? 'Private' : 'Shared'}
        </Badge>
      );
    case 'QUEUED':
      return <Badge tone="neutral">Queued</Badge>;
    case 'UPLOADING':
      return <Badge tone="accent">Uploading {Math.round((clip.uploadProgress ?? 0) * 100)}%</Badge>;
    case 'PROCESSING':
      return <Badge tone="accent">Processing</Badge>;
    case 'FAILED':
      return (
        <Badge tone="rec">
          <CloudOff className="size-3" />
          Upload failed
        </Badge>
      );
    default:
      return null;
  }
}

function Thumb({ clip, className }: { clip: Clip; className?: string }) {
  return (
    <div className={cx('relative overflow-hidden bg-surface-3', className)}>
      {clip.thumbnailPath ? (
        <img src={fileUrl(clip.thumbnailPath)} alt="" loading="lazy" className="size-full object-cover" />
      ) : (
        <div className="flex size-full items-center justify-center text-fg-subtle">
          <Film className="size-6" />
        </div>
      )}
      {!clip.fileExists && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70 text-xs text-warn">
          <FileWarning className="mr-1.5 size-4" /> File missing
        </div>
      )}
    </div>
  );
}

export function ClipCard({ clip }: { clip: Clip }) {
  return (
    <Link
      to={`/clips/${clip.id}`}
      className="group block min-w-0 rounded-md outline-offset-4"
    >
      <div className="relative overflow-hidden rounded-md border border-line transition-colors group-hover:border-line-strong">
        <Thumb clip={clip} className="aspect-video" />
        {clip.fileExists && <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/15 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"><Play className="size-6 fill-white text-white" strokeWidth={1} /></div>}
        <span className="absolute bottom-2 right-2 rounded bg-black/75 px-1.5 py-0.5 text-[11px] font-medium tabular-nums">
          {formatDuration(clip.durationMs)}
        </span>
        {clip.favorite && <Star className="absolute left-2 top-2 size-4 fill-warn text-warn drop-shadow" />}
      </div>
      <div className="pt-2.5">
        <div className="truncate text-[12px] font-medium leading-relaxed group-hover:text-accent" title={clip.title}>
          {clip.title}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-fg-subtle">
          <span className="truncate">{clip.gameName ?? 'Desktop'}</span>
          <span className="text-fg-subtle">·</span>
          <span className="shrink-0">{relativeTime(clip.createdAt)}</span>
        </div>
        <div className="mt-1.5 flex items-center gap-2 text-[10px] text-fg-subtle">
          <span className="font-mono">{formatResolution(clip.width, clip.height)} · {Math.round(clip.fps)} fps</span>
          <span className="ml-auto font-mono">{formatBytes(clip.sizeBytes)}</span>
          <UploadBadge clip={clip} />
        </div>
      </div>
    </Link>
  );
}

export function ClipRow({ clip }: { clip: Clip }) {
  return (
    <Link
      to={`/clips/${clip.id}`}
      className="clip-list-row border-b border-line px-4 py-2 text-xs transition-colors last:border-b-0 hover:bg-surface-2"
    >
      <Thumb clip={clip} className="aspect-video w-[88px] rounded-sm" />
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 truncate font-medium">
          {clip.favorite && <Star className="size-3.5 shrink-0 fill-warn text-warn" />}
          <span className="truncate">{clip.title}</span>
        </div>
        <div className="mt-0.5 text-xs text-fg-muted">{relativeTime(clip.createdAt)}</div>
      </div>
      <span className="truncate text-fg-muted">{clip.gameName ?? 'Desktop'}</span>
      <span className="tabular-nums text-fg-muted">{formatDuration(clip.durationMs)}</span>
      <span className="text-fg-muted">{formatResolution(clip.width, clip.height)}</span>
      <span className="tabular-nums text-fg-muted">{formatBytes(clip.sizeBytes)}</span>
      <span>
        {clip.status === 'LOCAL' ? <span className="text-fg-subtle">Local</span> : <UploadBadge clip={clip} />}
      </span>
    </Link>
  );
}
