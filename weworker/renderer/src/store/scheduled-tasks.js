import { create } from 'zustand'
import { useWorksStore } from './works.js'
import { backendFetch } from '../api/http.js'
import { leaveWebsiteExploration } from './website-exploration.js'

export const useScheduledTasksStore = create((set, get) => ({
  tasks: [],
  tasksStatus: 'idle',
  activeTaskId: null,
  executions: {}, // taskId -> TaskExecution[]
  runningTasks: {},
  startingTasks: {},

  runTask: async (id) => {
    if (get().startingTasks[id] || get().runningTasks[id]) return
    set((s) => ({ startingTasks: { ...s.startingTasks, [id]: true } }))
    try {
      const res = await backendFetch(`/scheduled-tasks/${id}/run`, { method: 'POST' })
      if (!res.ok) {
        const error = await res.json().catch(() => ({}))
        throw new Error(error.error || '启动任务失败，请重试')
      }
      set((s) => ({ runningTasks: { ...s.runningTasks, [id]: true } }))
      // A refresh failure must not turn an accepted run into a retryable start error.
      await get().loadExecutions(id).catch(() => {})
    } finally {
      set((s) => ({ startingTasks: { ...s.startingTasks, [id]: false } }))
    }
  },

  loadTasks: async () => {
    set({ tasksStatus: 'loading' })
    try {
      const res = await backendFetch('/scheduled-tasks')
      if (!res.ok) {
        set({ tasksStatus: 'error' })
        return
      }
      const data = await res.json()
      set({ tasks: Array.isArray(data.tasks) ? data.tasks : [], tasksStatus: 'ready' })
    } catch {
      set({ tasksStatus: 'error' })
    }
  },

  createTask: async (config) => {
    if (!await leaveWebsiteExploration()) return null
    const res = await backendFetch('/scheduled-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Request failed' }))
      console.error('[scheduled-tasks] createTask failed:', err)
      return null
    }
    const task = await res.json()
    set((s) => ({ tasks: [task, ...s.tasks], activeTaskId: task.id }))
    useWorksStore.setState({ activeWorkId: null })
    return task
  },

  selectTask: async (id) => {
    if (!await leaveWebsiteExploration()) return
    set({ activeTaskId: id })
    useWorksStore.setState({ activeWorkId: null })
    // Load executions for the selected task
    const res = await backendFetch(`/scheduled-tasks/${id}`)
    if (!res.ok) return
    const data = await res.json()
    set((s) => ({ executions: { ...s.executions, [id]: Array.isArray(data.executions) ? data.executions : [] } }))
  },

  updateTask: async (id, updates) => {
    const res = await backendFetch(`/scheduled-tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    const updated = await res.json()
    if (!res.ok) throw new Error(updated.error || updated.detail || '更新定时任务失败，请重试')
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? updated : t)),
    }))
    return updated
  },

  deleteTask: async (id) => {
    const res = await backendFetch(`/scheduled-tasks/${id}`, { method: 'DELETE' })
    if (!res.ok) {
      const error = await res.json().catch(() => ({}))
      throw new Error(error.error || error.detail || '删除定时任务失败，请重试')
    }
    set((s) => {
      const tasks = s.tasks.filter((t) => t.id !== id)
      const executions = { ...s.executions }
      delete executions[id]
      return {
        tasks,
        executions,
        activeTaskId: s.activeTaskId === id ? null : s.activeTaskId,
      }
    })
  },

  loadExecutions: async (taskId) => {
    const res = await backendFetch(`/scheduled-tasks/${taskId}`)
    if (!res.ok) return
    const data = await res.json()
    set((s) => ({
      executions: { ...s.executions, [taskId]: Array.isArray(data.executions) ? data.executions : [] },
      runningTasks: { ...s.runningTasks, [taskId]: Boolean(data.running) },
    }))
  },
}))
