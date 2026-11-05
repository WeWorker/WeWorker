import { create } from 'zustand'

// UI session state only: reloading must not pretend a lost stream is still running.
export const useWorkActivityStore = create((set) => ({
  activities: {},
  visibleWorkId: null,
  view: (id) => set(s => {
    const activities = { ...s.activities }
    if (['completed', 'failed'].includes(activities[id]?.status)) delete activities[id]
    return { visibleWorkId: id, activities }
  }),
  leave: (id) => set(s => s.visibleWorkId === id ? { visibleWorkId: null } : s),
  start: (id, token) => set(s => ({ activities: { ...s.activities, [id]: { token, status: 'running' } } })),
  wait: (id, token, choiceId) => set(s => s.activities[id]?.token === token
    ? { activities: { ...s.activities, [id]: { token, status: 'waiting', choiceId } } } : s),
  answer: (id, choiceId) => set(s => s.activities[id]?.status === 'waiting' && s.activities[id].choiceId === choiceId
    ? { activities: { ...s.activities, [id]: { token: s.activities[id].token, status: 'running' } } } : s),
  finish: (id, token, outcome) => set(s => {
    if (s.activities[id]?.token !== token) return s
    const activities = { ...s.activities }
    delete activities[id]
    if (outcome !== 'stopped' && s.visibleWorkId !== id) activities[id] = { status: outcome }
    return { activities }
  }),
  discard: (id) => set(s => {
    const activities = { ...s.activities }
    delete activities[id]
    return { activities }
  }),
}))

export function workActivityStatus(activity, streaming, visible = false) {
  if (activity?.status === 'waiting') return 'waiting'
  if (streaming) return 'running'
  if (!visible && ['completed', 'failed'].includes(activity?.status)) return activity.status
  return null
}

export function folderActivityStatus(statuses) {
  return ['waiting', 'failed', 'running', 'completed'].find(status => statuses.includes(status)) ?? null
}
