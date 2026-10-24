import { useState } from 'react';
import { Link } from 'react-router-dom';
import { openUrl } from '@tauri-apps/plugin-opener';
import { CloudUpload, Copy, ExternalLink, Film, Loader2, RotateCcw, Trash2, X } from 'lucide-react';
import { Button, Dialog, ProgressBar, Select } from './ui';
import { cloud, errorMessage, type Clip, type Visibility } from '../lib/ipc';
import { formatBytes } from '../lib/format';
import { copyToClipboard, useCloud } from '../stores/cloud';
import { useSettings } from '../stores/settings';
import { toast } from '../stores/toasts';

const VISIBILITY_OPTIONS: { value: Visibility; label: string }[] = [
  { value: 'unlisted', label: 'Unlisted — anyone with the link' },
  { value: 'public', label: 'Public' },
  { value: 'private', label: 'Private — only you' },
];

/** Upload, sharing and link controls for one clip. */
export function CloudPanel({ clip, onChange }: { clip: Clip; onChange: (c: Clip) => void }) {
  const { serverUrl, user, progress } = useCloud();
  const defaultVisibility = useSettings((s) => s.settings?.uploads.defaultVisibility ?? 'unlisted');
  const [visibility, setVisibility] = useState<Visibility>(clip.visibility ?? defaultVisibility);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const live = progress[clip.id];

  const act = async (fn: () => Promise<Clip | void>, failure: string) => {
    setBusy(true);
    try {
      const result = await fn();
      if (result) onChange(result);
    } catch (e) {
      toast.error(failure, errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  let body: React.ReactNode;
  if (!serverUrl) {
    body = (
      <p className="text-xs text-fg-muted">
        Local-only mode. To share clips, add a ClipLock server in{' '}
        <Link className="text-accent hover:underline" to="/settings/uploads">Settings → Uploads</Link>.
      </p>
    );
  } else if (!user && clip.status !== 'READY') {
    body = (
      <div className="space-y-3">
        <p className="text-xs text-fg-muted">Sign in to upload and get a share link.</p>
        <Link to="/account"><Button size="sm" variant="primary">Sign in</Button></Link>
      </div>
    );
  } else if (clip.status === 'LOCAL' || clip.status === 'FAILED') {
    body = (
      <div className="space-y-3">
        {clip.status === 'FAILED' && <p className="break-words rounded-md bg-rec-soft px-3 py-2 text-xs text-rec">{clip.uploadError ?? 'Upload failed.'}</p>}
        <Select label="Visibility" value={visibility} onChange={setVisibility} options={VISIBILITY_OPTIONS} className="w-full" />
        <Button
          variant="primary"
          className="w-full"
          icon={clip.status === 'FAILED' ? <RotateCcw className="size-4" /> : <CloudUpload className="size-4" />}
          loading={busy}
          disabled={!clip.fileExists}
          onClick={() => void act(() => cloud.upload(clip.id, visibility), 'Upload failed to start')}
        >
          {clip.status === 'FAILED' ? 'Retry upload' : `Upload (${formatBytes(clip.sizeBytes)})`}
        </Button>
        {clip.status === 'FAILED' && (
          <Button size="sm" variant="ghost" className="w-full" onClick={() => void act(() => cloud.cancelUpload(clip.id), 'Could not reset')}>
            Discard upload
          </Button>
        )}
      </div>
    );
  } else if (clip.status === 'QUEUED' || clip.status === 'UPLOADING') {
    const p = live?.progress ?? clip.uploadProgress ?? 0;
    body = (
      <div className="space-y-2">
        <div className="flex justify-between text-xs text-fg-muted">
          <span>{clip.status === 'QUEUED' ? 'Waiting…' : 'Uploading…'}</span>
          <span className="tabular-nums">
            {Math.round(p * 100)}%{live && live.bytesPerSecond > 0 ? ` · ${formatBytes(live.bytesPerSecond)}/s` : ''}
          </span>
        </div>
        <ProgressBar value={p} />
        <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} onClick={() => void act(() => cloud.cancelUpload(clip.id), 'Could not cancel')}>
          Cancel upload
        </Button>
      </div>
    );
  } else if (clip.status === 'PROCESSING') {
    body = (
      <div className="space-y-2 text-xs text-fg-muted">
        <div className="flex items-center gap-2 text-fg">
          <Loader2 className="size-4 animate-spin text-accent" /> Processing for playback…
        </div>
        <p>The share link works as soon as processing finishes.</p>
        {clip.shareUrl && <code className="block truncate rounded bg-surface-2 px-2 py-1 text-[11px]">{clip.shareUrl}</code>}
      </div>
    );
  } else {
    const directAvailable = clip.visibility !== 'private' && !!clip.mediaUrl;
    body = (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-surface-2 px-2 py-1.5 text-[11px] text-fg">{clip.shareUrl}</code>
          <Button size="sm" variant="primary" icon={<Copy className="size-3.5" />} onClick={() => void copyToClipboard(clip.shareUrl!, 'Share link')}>
            Copy
          </Button>
        </div>
        {directAvailable && (
          <Button size="sm" className="w-full" icon={<Film className="size-3.5" />} onClick={() => void copyToClipboard(clip.mediaUrl!, 'Video link')} title="A direct .mp4 link. Chat apps such as Discord can play it inline.">
            Copy direct video link (.mp4)
          </Button>
        )}
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" icon={<ExternalLink className="size-3.5" />} onClick={() => void openUrl(clip.shareUrl!)}>
            Open
          </Button>
          <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} className="ml-auto" onClick={() => setConfirmRemove(true)}>
            Remove from cloud
          </Button>
        </div>
        <Select
          label="Visibility"
          value={clip.visibility ?? 'unlisted'}
          onChange={(v) => void act(() => cloud.setVisibility(clip.id, v), 'Could not change visibility')}
          options={VISIBILITY_OPTIONS}
          className="w-full"
          disabled={busy}
        />
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <h3 className="mb-3 text-sm font-semibold">Share</h3>
      {body}
      <Dialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title="Remove from cloud?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmRemove(false)}>Cancel</Button>
            <Button
              variant="record"
              loading={busy}
              onClick={() =>
                void act(() => cloud.deleteCloudCopy(clip.id), 'Could not remove').then(() => setConfirmRemove(false))
              }
            >
              Remove
            </Button>
          </>
        }
      >
        The uploaded copy and its share link will stop working. The clip on this PC is kept.
      </Dialog>
    </div>
  );
}
