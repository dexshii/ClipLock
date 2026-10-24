import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { LogOut, Server, ShieldAlert, UserRound } from 'lucide-react';
import { PageHeader } from '../components/Layout';
import { Button, Card, CardHeader, Dialog, ProgressBar, Segmented, SettingRow, Spinner, TextInput } from '../components/ui';
import { cloud, errorMessage, type CloudUsage, type ServerInfo } from '../lib/ipc';
import { formatBytes } from '../lib/format';
import { useCloud } from '../stores/cloud';
import { toast } from '../stores/toasts';

export function Account() {
  const { serverUrl, user, restoring } = useCloud();
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);

  useEffect(() => {
    setInfo(null);
    setInfoError(null);
    if (serverUrl) cloud.serverInfo().then(setInfo).catch((e) => setInfoError(errorMessage(e)));
  }, [serverUrl]);

  return (
    <>
      <PageHeader title="Account" subtitle="An account is only needed for uploading and sharing. Recording works without one." />
      <div className="mx-auto max-w-3xl space-y-5 px-8 py-6">
        <Card>
          <CardHeader title="Server" subtitle="Official or self-hosted ClipLock server." />
          <div className="flex items-center gap-3 px-5 pb-5 pt-3 text-sm">
            <Server className="size-4 text-fg-muted" />
            {serverUrl ? (
              <>
                <span className="truncate">{serverUrl}</span>
                {info && <span className="text-xs text-ok">Connected</span>}
                {infoError && <span className="truncate text-xs text-rec" title={infoError}>Unreachable: {infoError}</span>}
                {!info && !infoError && <Spinner />}
              </>
            ) : (
              <span className="text-fg-muted">None — local-only mode.</span>
            )}
            <Link className="ml-auto shrink-0 text-xs text-accent hover:underline" to="/settings/uploads">
              Change
            </Link>
          </div>
        </Card>

        {!serverUrl ? null : restoring ? (
          <Card className="flex items-center gap-3 p-5 text-sm text-fg-muted">
            <Spinner /> Restoring your session…
          </Card>
        ) : user ? (
          <SignedIn />
        ) : (
          <SignInForm registrationOpen={info?.registrationOpen ?? true} />
        )}
      </div>
    </>
  );
}

function SignInForm({ registrationOpen }: { registrationOpen: boolean }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = mode === 'login' ? await cloud.login(email, password) : await cloud.register(email, password, displayName);
      useCloud.setState({ user });
      toast.success(mode === 'login' ? 'Signed in' : 'Account created', user.email);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      setPassword('');
    }
  };

  return (
    <Card>
      <div className="flex items-center justify-between px-5 pt-4">
        <h2 className="text-sm font-semibold">{mode === 'login' ? 'Sign in' : 'Create an account'}</h2>
        {registrationOpen && (
          <Segmented
            label="Mode"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'login', label: 'Sign in' },
              { value: 'register', label: 'Create account' },
            ]}
          />
        )}
      </div>
      <form onSubmit={(e) => void submit(e)} className="space-y-3 px-5 pb-5 pt-4">
        {mode === 'register' && (
          <Field label="Display name">
            <TextInput required minLength={2} maxLength={32} value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="w-full" autoComplete="nickname" />
          </Field>
        )}
        <Field label="Email">
          <TextInput required type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full" autoComplete="email" />
        </Field>
        <Field label="Password">
          <TextInput
            required
            type="password"
            minLength={mode === 'register' ? 10 : 1}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />
          {mode === 'register' && <p className="mt-1 text-xs text-fg-subtle">At least 10 characters. A passphrase works great.</p>}
        </Field>
        {error && <p className="rounded-md bg-rec-soft px-3 py-2 text-xs text-rec">{error}</p>}
        <Button type="submit" variant="primary" loading={busy}>
          {mode === 'login' ? 'Sign in' : 'Create account'}
        </Button>
      </form>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-fg-muted">{label}</span>
      {children}
    </label>
  );
}

function SignedIn() {
  const user = useCloud((s) => s.user)!;
  const [usage, setUsage] = useState<CloudUsage | null>(null);
  const [name, setName] = useState(user.displayName);
  const [deleting, setDeleting] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    cloud.usage().then(setUsage).catch(() => undefined);
  }, []);

  return (
    <>
      <Card>
        <div className="flex items-center gap-4 p-5">
          <div className="flex size-11 items-center justify-center rounded-full bg-accent-soft text-accent">
            <UserRound className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{user.displayName}</div>
            <div className="truncate text-sm text-fg-muted">{user.email}</div>
          </div>
          <Button
            icon={<LogOut className="size-4" />}
            onClick={() =>
              cloud
                .logout()
                .then(() => useCloud.setState({ user: null }))
                .catch((e) => toast.error('Sign out failed', errorMessage(e)))
            }
          >
            Sign out
          </Button>
        </div>
        {usage && (
          <div className="border-t border-line px-5 py-4">
            <div className="mb-1.5 flex justify-between text-xs text-fg-muted">
              <span>{usage.clipCount} uploaded clips</span>
              <span className="tabular-nums">
                {formatBytes(usage.usedBytes)} of {formatBytes(usage.quotaBytes)}
              </span>
            </div>
            <ProgressBar value={usage.usedBytes / usage.quotaBytes} />
          </div>
        )}
      </Card>
      <Card>
        <SettingRow title="Display name" description="Shown on your public clip pages.">
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              cloud
                .updateProfile(name)
                .then((u) => {
                  useCloud.setState({ user: u });
                  toast.success('Profile updated');
                })
                .catch((err) => toast.error('Could not update profile', errorMessage(err)));
            }}
          >
            <TextInput value={name} minLength={2} maxLength={32} onChange={(e) => setName(e.target.value)} className="w-48" aria-label="Display name" />
            <Button type="submit" size="sm" disabled={name.trim() === user.displayName}>
              Save
            </Button>
          </form>
        </SettingRow>
        <SettingRow title="Delete account" description="Removes your account and every uploaded clip from the server. Clips on this PC are kept.">
          <Button variant="danger" size="sm" icon={<ShieldAlert className="size-3.5" />} onClick={() => setDeleting(true)}>
            Delete account
          </Button>
        </SettingRow>
      </Card>
      <Dialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title="Delete your account?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(false)}>Cancel</Button>
            <Button
              variant="record"
              loading={busy}
              disabled={!password}
              onClick={async () => {
                setBusy(true);
                try {
                  await cloud.deleteAccount(password);
                  useCloud.setState({ user: null });
                  toast.success('Account deleted', 'All uploaded clips are being removed from the server.');
                  setDeleting(false);
                } catch (e) {
                  toast.error('Could not delete account', errorMessage(e));
                } finally {
                  setBusy(false);
                  setPassword('');
                }
              }}
            >
              Delete permanently
            </Button>
          </>
        }
      >
        <p>This cannot be undone. Every share link you created will stop working.</p>
        <TextInput type="password" placeholder="Confirm with your password" value={password} onChange={(e) => setPassword(e.target.value)} className="mt-4 w-full" aria-label="Password" />
      </Dialog>
    </>
  );
}

