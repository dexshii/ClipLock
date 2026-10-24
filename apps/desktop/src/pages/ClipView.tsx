import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { save } from '@tauri-apps/plugin-dialog';
import { ArrowLeft, Download, FolderOpen, Gamepad2, ImageIcon, Pencil, Scissors, Star, Trash2 } from 'lucide-react';
import { Badge, Button, Dialog, IconButton, Spinner, TextInput, Toggle, cx } from '../components/ui';
import { UploadBadge } from '../components/ClipCard';
import { api, errorMessage, fileUrl, type Clip } from '../lib/ipc';
import { formatBytes, formatDuration, formatResolution } from '../lib/format';
import { useLibrary } from '../stores/library';
import { toast } from '../stores/toasts';
import { CloudPanel } from './Uploads';

export function ClipView() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const fromStore = useLibrary((s) => s.clips.find((c) => c.id === id));
  const [clip, setClip] = useState<Clip | null>(fromStore ?? null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState('');
  const [gameDialog, setGameDialog] = useState(false);
  const [deleteDialog, setDeleteDialog] = useState(false);

  useEffect(() => {
    if (fromStore) setClip(fromStore);
  }, [fromStore]);
  useEffect(() => {
    api.getClip(id).then(setClip).catch((e) => toast.error('Clip not found', errorMessage(e)));
  }, [id]);

  if (!clip) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const patch = async (p: Parameters<typeof api.updateClip>[1]) => {
    try {
      setClip(await api.updateClip(clip.id, p));
    } catch (e) {
      toast.error('Could not update clip', errorMessage(e));
    }
  };

  const exportCopy = async () => {
    const destination = await save({
      defaultPath: `${clip.title.replace(/[<>:"/\\|?*]/g, ' ')}.mp4`,
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    });
    if (!destination) return;
    try {
      await api.exportClip(clip.id, destination);
      toast.success('Exported', destination);
    } catch (e) {
      toast.error('Export failed', errorMessage(e));
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-8 py-6">
      <div className="mb-4 flex items-center gap-2">
        <IconButton label="Back to library" onClick={() => navigate(-1)}>
          <ArrowLeft className="size-4" />
        </IconButton>
        {editingTitle ? (
          <form
            className="flex flex-1 items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void patch({ title }).then(() => setEditingTitle(false));
            }}
          >
            <TextInput autoFocus value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} className="flex-1 text-base" aria-label="Clip title" />
            <Button variant="primary" type="submit">
              Save
            </Button>
            <Button type="button" variant="ghost" onClick={() => setEditingTitle(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <>
            <h1 className="truncate text-xl font-semibold tracking-tight">{clip.title}</h1>
            <IconButton
              label="Rename"
              onClick={() => {
                setTitle(clip.title);
                setEditingTitle(true);
              }}
            >
              <Pencil className="size-3.5" />
            </IconButton>
          </>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div>
          <div className="overflow-hidden rounded-lg border border-line bg-black">
            {clip.fileExists ? (
              <video key={clip.filePath} src={fileUrl(clip.filePath)} poster={fileUrl(clip.thumbnailPath)} controls preload="metadata" className="aspect-video max-h-[62vh] w-full object-contain" />
            ) : (
              <div className="flex aspect-video items-center justify-center text-sm text-warn">
                The video file was moved or deleted outside ClipLock.
              </div>
            )}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="primary" icon={<Scissors className="size-4" />} onClick={() => navigate(`/clips/${clip.id}/edit`)} disabled={!clip.fileExists}>
              Edit
            </Button>
            <Button icon={<Star className={cx('size-4', clip.favorite && 'fill-warn text-warn')} />} onClick={() => void patch({ favorite: !clip.favorite })}>
              {clip.favorite ? 'Favorited' : 'Favorite'}
            </Button>
            <Button icon={<FolderOpen className="size-4" />} onClick={() => api.revealClip(clip.id).catch((e) => toast.error('Cannot open folder', errorMessage(e)))}>
              Show in folder
            </Button>
            <Button icon={<Download className="size-4" />} onClick={() => void exportCopy()} disabled={!clip.fileExists}>
              Export copy
            </Button>
            <Button
              icon={<ImageIcon className="size-4" />}
              onClick={() =>
                api
                  .regenerateThumbnail(clip.id)
                  .then(setClip)
                  .catch((e) => toast.error('Thumbnail failed', errorMessage(e)))
              }
              disabled={!clip.fileExists}
            >
              Refresh thumbnail
            </Button>
            <Button variant="danger" icon={<Trash2 className="size-4" />} className="ml-auto" onClick={() => setDeleteDialog(true)}>
              Delete
            </Button>
          </div>
        </div>

        <aside className="space-y-4">
          <div className="rounded-lg border border-line bg-surface">
            <dl className="divide-y divide-line text-sm">
              <Meta label="Game">
                <button className="flex items-center gap-1.5 hover:text-accent" onClick={() => setGameDialog(true)}>
                  <Gamepad2 className="size-3.5" /> {clip.gameName ?? 'Desktop'}
                </button>
              </Meta>
              <Meta label="Recorded">{new Date(clip.createdAt).toLocaleString()}</Meta>
              <Meta label="Duration">{formatDuration(clip.durationMs)}</Meta>
              <Meta label="Quality">
                {formatResolution(clip.width, clip.height)} · {Math.round(clip.fps)} fps
              </Meta>
              <Meta label="Size">{formatBytes(clip.sizeBytes)}</Meta>
              <Meta label="Type">
                <Badge>{clip.kind}</Badge>
              </Meta>
              {clip.sourceClipId && (
                <Meta label="Edited from">
                  <Link className="text-accent hover:underline" to={`/clips/${clip.sourceClipId}`}>
                    Original clip
                  </Link>
                </Meta>
              )}
              <Meta label="Cloud">
                <UploadBadge clip={clip} /> {clip.status === 'LOCAL' && <span className="text-fg-muted">Not uploaded</span>}
              </Meta>
            </dl>
            <div className="break-all border-t border-line px-4 py-3 font-mono text-[11px] text-fg-subtle">{clip.filePath}</div>
          </div>
          <CloudPanel clip={clip} onChange={setClip} />
        </aside>
      </div>

      <GameDialog open={gameDialog} clip={clip} onClose={() => setGameDialog(false)} onSave={(name) => void patch({ gameName: name }).then(() => setGameDialog(false))} />
      <DeleteDialog
        open={deleteDialog}
        clip={clip}
        onClose={() => setDeleteDialog(false)}
        onDeleted={() => {
          setDeleteDialog(false);
          navigate('/library');
        }}
      />
    </div>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5">
      <dt className="text-fg-muted">{label}</dt>
      <dd className="flex items-center gap-1.5 text-right">{children}</dd>
    </div>
  );
}

function GameDialog({ open, clip, onClose, onSave }: { open: boolean; clip: Clip; onClose: () => void; onSave: (name: string) => void }) {
  const [games, setGames] = useState<{ id: string; name: string }[]>([]);
  const [value, setValue] = useState(clip.gameName ?? '');
  useEffect(() => {
    if (open) {
      setValue(clip.gameName ?? '');
      void api.listGames().then(setGames);
    }
  }, [open, clip.gameName]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Set game"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onSave(value)}>
            Save
          </Button>
        </>
      }
    >
      <p className="mb-3">Choose a game or type a name. Leave empty for “Desktop”.</p>
      <TextInput list="cliplock-games" value={value} onChange={(e) => setValue(e.target.value)} className="w-full" aria-label="Game name" maxLength={100} />
      <datalist id="cliplock-games">
        {games.map((g) => (
          <option key={g.id} value={g.name} />
        ))}
      </datalist>
    </Dialog>
  );
}

function DeleteDialog({ open, clip, onClose, onDeleted }: { open: boolean; clip: Clip; onClose: () => void; onDeleted: () => void }) {
  const [deleteFile, setDeleteFile] = useState(true);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Delete clip?"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="record"
            loading={busy}
            data-autofocus
            onClick={async () => {
              setBusy(true);
              try {
                await api.deleteClip(clip.id, deleteFile);
                toast.success('Clip deleted');
                onDeleted();
              } catch (e) {
                toast.error('Delete failed', errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Delete
          </Button>
        </>
      }
    >
      <p>
        “{clip.title}” will be removed from your library.
        {clip.status === 'READY' && ' The uploaded copy stays online until you delete it from Uploads.'}
      </p>
      <label className="mt-4 flex items-center justify-between gap-4 rounded-md border border-line bg-surface-2 px-3 py-2.5 text-fg">
        <span className="text-sm">Also move the video file to the Recycle Bin</span>
        <Toggle checked={deleteFile} onChange={setDeleteFile} label="Delete file" />
      </label>
    </Dialog>
  );
}
