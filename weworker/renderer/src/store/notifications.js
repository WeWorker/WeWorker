import { create } from 'zustand'

let nextId = 0

export const useNotificationsStore = create((set) => ({
  notices: [],
  dismiss: (id) => set((state) => ({ notices: state.notices.filter((notice) => notice.id !== id) })),
}))

export function showNotification(message, { type = 'info', duration = 5000 } = {}) {
  const id = ++nextId
  const notice = {
    id,
    message: String(message ?? ''),
    type: ['info', 'success', 'warning', 'error'].includes(type) ? type : 'info',
    duration,
  }
  useNotificationsStore.setState((state) => ({ notices: [...state.notices, notice].slice(-3) }))
  return id
}
