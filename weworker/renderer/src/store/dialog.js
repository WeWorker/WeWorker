import { create } from 'zustand'

export const useDialogStore = create((set, get) => ({
  queue: [],
  enqueue: (request) => new Promise((resolve) => {
    set((state) => ({ queue: [...state.queue, { ...request, resolve }] }))
  }),
  resolve: (value) => {
    const [current, ...rest] = get().queue
    if (current?.resolve) current.resolve(value)
    set({ queue: rest })
  },
}))

export function showAlert(message, title = '提示') {
  return useDialogStore.getState().enqueue({ kind: 'alert', title, message: String(message ?? '') })
}

export function showConfirm(message, title = '请确认', { danger = false } = {}) {
  return useDialogStore.getState().enqueue({ kind: 'confirm', title, message: String(message ?? ''), danger })
}
