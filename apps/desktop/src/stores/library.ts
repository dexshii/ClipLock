import { create } from 'zustand';
import { api, errorMessage, on, type Clip, type ClipQuery } from '../lib/ipc';
import { toast } from './toasts';

interface LibraryStore {
  clips: Clip[];
  games: string[];
  query: ClipQuery;
  loading: boolean;
  view: 'grid' | 'list';
  setQuery: (q: Partial<ClipQuery>) => void;
  setView: (v: 'grid' | 'list') => void;
  reload: () => Promise<void>;
  upsert: (clip: Clip) => void;
  remove: (id: string) => void;
}

const VIEW_KEY = 'cliplock.library.view';

export const useLibrary = create<LibraryStore>((set, get) => ({
  clips: [],
  games: [],
  query: { sort: 'newest' },
  loading: false,
  view: (localStorage.getItem(VIEW_KEY) as 'grid' | 'list' | null) ?? 'grid',
  setQuery: (q) => {
    set({ query: { ...get().query, ...q } });
    void get().reload();
  },
  setView: (view) => {
    localStorage.setItem(VIEW_KEY, view);
    set({ view });
  },
  reload: async () => {
    set({ loading: true });
    try {
      const [clips, games] = await Promise.all([api.listClips(get().query), api.clipGames()]);
      set({ clips, games });
    } catch (e) {
      toast.error('Could not load clips', errorMessage(e));
    } finally {
      set({ loading: false });
    }
  },
  upsert: (clip) => {
    const exists = get().clips.some((c) => c.id === clip.id);
    if (exists) set({ clips: get().clips.map((c) => (c.id === clip.id ? clip : c)) });
    else void get().reload();
  },
  remove: (id) => set({ clips: get().clips.filter((c) => c.id !== id) }),
}));

export function startLibrarySync(): () => void {
  void useLibrary.getState().reload();
  const subs = [
    on<Clip>('clip-added', () => void useLibrary.getState().reload()),
    on<Clip>('clip-updated', (clip) => useLibrary.getState().upsert(clip)),
    on<string>('clip-deleted', (id) => useLibrary.getState().remove(id)),
  ];
  return () => subs.forEach((p) => void p.then((f) => f()));
}
