import { Link } from 'react-router-dom';
import { CloudOff } from 'lucide-react';
import { PageHeader } from '../components/Layout';
import { Card, CardHeader, EmptyState } from '../components/ui';
import type { Clip } from '../lib/ipc';
import { useLibrary } from '../stores/library';
import { useSettings } from '../stores/settings';

export function Uploads() {
  return (
    <>
      <PageHeader title="Uploads" subtitle="Clips you share to your ClipLock server." />
      <div className="px-8 py-6">
        <Card>
          <EmptyState
            icon={<CloudOff className="size-5" />}
            title="Cloud uploads are not set up"
            body={<>ClipLock is in local-only mode. Add a server in <Link className="text-accent hover:underline" to="/settings/uploads">Settings → Uploads</Link> to share clips.</>}
          />
        </Card>
      </div>
    </>
  );
}

export function UploadsSummary() {
  const clips = useLibrary((s) => s.clips);
  const server = useSettings((s) => s.settings?.uploads.serverUrl);
  const active = clips.filter((c) => ['QUEUED', 'UPLOADING', 'PROCESSING'].includes(c.status)).length;
  return (
    <Card>
      <CardHeader title="Uploads" subtitle={server ? server : 'Local-only mode'} />
      <div className="px-5 pb-5 pt-3 text-sm text-fg-muted">{active > 0 ? `${active} active upload${active > 1 ? 's' : ''}` : 'No active uploads'}</div>
    </Card>
  );
}

export function CloudPanel(_props: { clip: Clip; onChange: (c: Clip) => void }) {
  return null;
}
