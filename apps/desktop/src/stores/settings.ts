import { create } from 'zustand';
import { api, errorMessage, type AppSettings } from '../lib/ipc';
import { toast } from './toasts';

interface SettingsStore {
  settings: AppSettings | null;
  saving: boolean;
  load: () => Promise<void>;
  /** Applies a change immediately (settings are saved as you edit). */
  update: (mutate: (draft: AppSettings) => void) => Promise<boolean>;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  settings: null,
  saving: false,
  load: async () => set({ settings: await api.getSettings() }),
  update: async (mutate) => {
    const current = get().settings;
    if (!current) return false;
    const draft = structuredClone(current);
    mutate(draft);
    set({ settings: draft, saving: true });
    try {
      const result = await api.updateSettings(draft);
      set({ settings: result.settings });
      if (result.hotkeyFailures.length > 0) {
        toast.error('Hotkey unavailable', `${result.hotkeyFailures.join(', ')} is used by another program.`);
      }
      return true;
    } catch (e) {
      set({ settings: current });
      toast.error('Setting not saved', errorMessage(e));
      return false;
    } finally {
      set({ saving: false });
    }
  },
}));
