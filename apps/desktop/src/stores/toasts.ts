import { create } from 'zustand';

export type ToastTone = 'info' | 'success' | 'error';

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
}

interface ToastStore {
  toasts: Toast[];
  push: (tone: ToastTone, title: string, body?: string) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToasts = create<ToastStore>((set, get) => ({
  toasts: [],
  push: (tone, title, body) => {
    const id = nextId++;
    set({ toasts: [...get().toasts.slice(-3), { id, tone, title, body }] });
    setTimeout(() => get().dismiss(id), tone === 'error' ? 7000 : 4000);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const toast = {
  info: (title: string, body?: string) => useToasts.getState().push('info', title, body),
  success: (title: string, body?: string) => useToasts.getState().push('success', title, body),
  error: (title: string, body?: string) => useToasts.getState().push('error', title, body),
};
