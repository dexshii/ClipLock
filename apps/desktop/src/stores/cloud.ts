import { create } from 'zustand';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { cloud, errorMessage, on, type CloudUser, type UploadProgress } from '../lib/ipc';
import { toast } from './toasts';

interface CloudStore {
  serverUrl: string;
  user: CloudUser | null;
  restoring: boolean;
  progress: Record<string, UploadProgress>;
  refresh: () => Promise<void>;
}

export const useCloud = create<CloudStore>((set, get) => ({
  serverUrl: '',
  user: null,
  restoring: false,
  progress: {},
  refresh: async () => {
    const status = await cloud.status();
    set({ serverUrl: status.serverUrl, user: status.user });
    if (!status.user && status.hasStoredSession && !get().restoring) {
      set({ restoring: true });
      try {
        set({ user: await cloud.restore() });
      } catch {
        // Offline or session expired: stay signed out; local features are unaffected.
      } finally {
        set({ restoring: false });
      }
    }
  },
}));

export function startCloudSync(): () => void {
  void useCloud.getState().refresh();
  const subs = [
    on<CloudUser | null>('cloud-session', (user) => {
      useCloud.setState({ user });
      void useCloud.getState().refresh();
    }),
    on<UploadProgress>('upload-progress', (p) => useCloud.setState({ progress: { ...useCloud.getState().progress, [p.clipId]: p } })),
    on('settings-changed', () => void useCloud.getState().refresh()),
  ];
  return () => subs.forEach((s) => void s.then((f) => f()));
}

export async function copyToClipboard(text: string, what = 'Link'): Promise<void> {
  try {
    await writeText(text);
    toast.success(`${what} copied`, text);
  } catch (e) {
    toast.error('Could not copy', errorMessage(e));
  }
}
