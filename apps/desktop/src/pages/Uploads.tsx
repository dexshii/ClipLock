import { Link } from 'react-router-dom';
import { CloudOff, CloudUpload, Copy, RotateCcw, X } from 'lucide-react';
import { PageHeader } from '../components/Layout';
import { UploadBadge } from '../components/ClipCard';
import { Button, Card, CardHeader, EmptyState, ProgressBar } from '../components/ui';
import { cloud, errorMessage, fileUrl, type Clip } from '../lib/ipc';
import { formatBytes, relativeTime } from '../lib/format';
import { copyToClipboard, useCloud } from '../stores/cloud';
import { useLibrary } from '../stores/library';
import { toast } from '../stores/toasts';

const ORDER: Record<string, number> = { UPLOADING: 0, QUEUED: 1, PROCESSING: 2, FAILED: 3, READY: 4 };

export function Uploads() {
  const { serverUrl, user } = useCloud();
  const clips = useLibrary((s) => s.clips).filter((c) => c.status !== 'LOCAL');
  clips.sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || b.createdAt.localeCompare(a.createdAt));

  return (
    <>
      <PageHeader title="Uploads" subtitle={serverUrl ? `${serverUrl}${user ? ` · ${user.displayName}` : ''}` : 'Local-only mode'} />
      <div className="px-8 py-6">
        {!serverUrl ? (
          <Card>
            <EmptyState
              icon={<CloudOff className="size-5" />}
              title="Cloud uploads are not set up"
              body={<>ClipLock is in local-only mode. Add a server in <Link className="text-accent hover:underline" to="/settings/uploads">Settings → Uploads</Link> to share clips.</>}
            />
          </Card>
        ) : clips.length === 0 ? (
          <Card>
            <EmptyState
              icon={<CloudUpload className="size-5" />}
              title="Nothing uploaded yet"
              body={user ? 'Open a clip from your library and choose Upload to get a share link.' : 'Sign in on the Account page, then upload clips from your library.'}
              action={!user ? <Link to="/account"><Button variant="primary">Sign in</Button></Link> : undefined}
            />
          </Card>
        ) : (
          <Card className="overflow-hidden">
            {clips.map((c) => (
              <UploadRow key={c.id} clip={c} />
            ))}
          </Card>
        )}
      </div>
    </>
  );
}

function UploadRow({ clip }: { clip: Clip }) {
  const live = useCloud((s) => s.progress[clip.id]);
  const p = live?.progress ?? clip.uploadProgress ?? 0;
  const run = (fn: () => Promise<unknown>, failure: string) => fn().catch((e) => toast.error(failure, errorMessage(e)));
  return (
    <div className="flex items-center gap-4 border-b border-line px-4 py-3 last:border-b-0">
      <Link to={`/clips/${clip.id}`} className="w-28 shrink-0 overflow-hidden rounded bg-surface-3">
        {clip.thumbnailPath && <img src={fileUrl(clip.thumbnailPath)} alt="" className="aspect-video w-full object-cover" />}
      </Link>
      <div className="min-w-0 flex-1">
        <Link to={`/clips/${clip.id}`} className="block truncate text-sm font-medium hover:text-accent">
          {clip.title}
        </Link>
        <div className="mt-1 flex items-center gap-2 text-xs text-fg-muted">
          <UploadBadge clip={clip} />
          <span>{formatBytes(clip.sizeBytes)}</span>
          <span>· {relativeTime(clip.createdAt)}</span>
        </div>
        {(clip.status === 'UPLOADING' || clip.status === 'QUEUED') && <ProgressBar value={p} className="mt-2 max-w-sm" />}
        {clip.status === 'FAILED' && <p className="mt-1 truncate text-xs text-rec">{clip.uploadError}</p>}
      </div>
      <div className="flex shrink-0 gap-2">
        {(clip.status === 'UPLOADING' || clip.status === 'QUEUED') && (
          <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} onClick={() => void run(() => cloud.cancelUpload(clip.id), 'Could not cancel')}>
            Cancel
          </Button>
        )}
        {clip.status === 'FAILED' && (
          <Button size="sm" icon={<RotateCcw className="size-3.5" />} onClick={() => void run(() => cloud.upload(clip.id), 'Retry failed')}>
            Retry
          </Button>
        )}
        {clip.status === 'READY' && clip.shareUrl && (
          <Button size="sm" icon={<Copy className="size-3.5" />} onClick={() => void copyToClipboard(clip.shareUrl!, 'Share link')}>
            Copy link
          </Button>
        )}
      </div>
    </div>
  );
}

export function UploadsSummary() {
  const clips = useLibrary((s) => s.clips);
  const { serverUrl, user } = useCloud();
  const active = clips.filter((c) => ['QUEUED', 'UPLOADING', 'PROCESSING'].includes(c.status));
  return (
    <Card>
      <CardHeader
        title="Uploads"
        subtitle={serverUrl ? (user ? `Signed in as ${user.displayName}` : 'Not signed in') : 'Local-only mode'}
        action={<Link to="/uploads" className="text-xs text-accent hover:underline">View</Link>}
      />
      <div className="space-y-2 px-5 pb-5 pt-3 text-sm text-fg-muted">
        {active.length === 0 ? (
          'No active uploads'
        ) : (
          active.slice(0, 3).map((c) => (
            <div key={c.id} className="flex items-center justify-between gap-3">
              <span className="truncate text-fg">{c.title}</span>
              <UploadBadge clip={c} />
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
