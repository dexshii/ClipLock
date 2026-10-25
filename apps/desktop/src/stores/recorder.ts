import { create } from 'zustand';
import { api, errorMessage, on, type Clip, type EngineEvent, type RecorderState } from '../lib/ipc';
import { toast } from './toasts';

type Action = 'replay' | 'save' | 'record' | 'pause';

interface RecorderStore {
  state: RecorderState | null;
  busy: Partial<Record<Action, boolean>>;
  refresh: () => Promise<void>;
  toggleReplay: () => Promise<void>;
  saveReplay: (seconds?: number) => Promise<void>;
  toggleRecording: () => Promise<void>;
  togglePause: () => Promise<void>;
  setMicMuted: (muted: boolean) => Promise<void>;
  setManualGame: (name: string | null, hwnd?: number | null) => Promise<void>;
}

export const useRecorder = create<RecorderStore>((set, get) => {
  async function run(action: Action, fn: () => Promise<unknown>, failure: string) {
    if (get().busy[action]) return;
    set({ busy: { ...get().busy, [action]: true } });
    try {
      await fn();
    } catch (e) {
      toast.error(failure, errorMessage(e));
    } finally {
      set({ busy: { ...get().busy, [action]: false } });
      await get().refresh();
    }
  }

  return {
    state: null,
    busy: {},
    refresh: async () => set({ state: await api.recorderState() }),
    toggleReplay: () =>
      run(
        'replay',
        () => (get().state?.engine?.replay ? api.stopReplay() : api.startReplay()),
        'Instant Replay could not be changed',
      ),
    saveReplay: (seconds) =>
      run(
        'save',
        // Feedback comes from the clip-saving / clip-saved events, which also fire for the hotkey.
        () => api.saveReplay(seconds),
        'Could not save clip',
      ),
    toggleRecording: () =>
      run(
        'record',
        async () => {
          if (get().state?.engine?.recording) {
            const clip = await api.stopRecording();
            toast.success('Recording saved', clip.title);
          } else {
            await api.startRecording();
          }
        },
        'Recording failed',
      ),
    togglePause: () => run('pause', () => api.togglePause(), 'Could not pause'),
    setMicMuted: async (muted) => {
      await api.setMicMuted(muted).catch((e) => toast.error('Microphone', errorMessage(e)));
      await get().refresh();
    },
    setManualGame: async (name, hwnd = null) => {
      await api.setManualGame(name, hwnd);
      await get().refresh();
    },
  };
});

/** Subscribes to backend events; polls while capturing so timers stay live. */
export function startRecorderSync(): () => void {
  const store = useRecorder.getState();
  let savingToast: number | null = null;
  void store.refresh();
  const unlisten = [
    on<RecorderState>('recorder-state', (state) => useRecorder.setState({ state })),
    on<EngineEvent>('engine-event', (e) => {
      if (e.type === 'pipelineFailed' && !e.willRetry) toast.error('Capture stopped', e.error);
      if (e.type === 'pipelineStarted' && e.fallback)
        toast.info('Using a fallback encoder', `${e.encoder.ffmpegName}${e.gpuPath ? '' : ' (CPU conversion)'}`);
      if (e.type === 'audioWarning') toast.error('Audio device problem', e.message);
    }),
    on<string>('app-error', (message) => toast.error('ClipLock', message)),
    on('clip-saving', () => {
      savingToast = toast.info('Saving clip…');
    }),
    on<Clip>('clip-saved', (clip) => {
      if (savingToast !== null) toast.dismiss(savingToast);
      savingToast = null;
      toast.success('Clip saved', clip.title);
    }),
  ];
  const timer = window.setInterval(() => {
    const engine = useRecorder.getState().state?.engine;
    if (engine?.running || useRecorder.getState().state?.init.state === 'initializing') void store.refresh();
  }, 1000);
  return () => {
    window.clearInterval(timer);
    unlisten.forEach((p) => void p.then((f) => f()));
  };
}
