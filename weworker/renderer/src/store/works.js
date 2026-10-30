import { create } from 'zustand'
import { mapMessagesAfterStop } from '../utils/chat-generation-stop.js'
import { applyTerminalEventToMessages } from '../utils/terminal-chat-output.js'
import { calibrateContextSnapshot, calibrateCompactedContextSnapshot, createContextTokenAnchor, projectIncrementalContextSnapshot } from '../utils/context-snapshot.js'
import { backendFetch } from '../api/http.js'
import { leaveWebsiteExploration } from './website-exploration.js'
import { showAlert } from './dialog.js'
import { discardMessageQueue } from './message-queue.js'
import { useChatDraftStore } from './chat-drafts.js'

const API = 'http://127.0.0.1:8765'
const pendingArchiveRequests = new Map()
const pendingCreateWorkRequests = new Map()

// Lazy import to avoid circular dependency
let _scheduledTasksStore = null
function getScheduledTasksStore() {
  if (!_scheduledTasksStore) {
    _scheduledTasksStore = import('./scheduled-tasks.js').then(m => m.useScheduledTasksStore)
  }
  return _scheduledTasksStore
}

export const useWorksStore = create((set, get) => ({
  works: [],
  projects: [],
  activeWorkId: null,
  messages: {}, // workId -> Message[]
  contextSnapshots: {}, // workId -> latest local context composition
  contextTokenAnchors: {}, // workId -> provider total and calibrated non-conversation baseline
  contextCompactionStatuses: {}, // workId -> compacting/completed/skipped/failed
  memoryStatuses: {}, // workId -> latest explicit memory processing status
  healthCheckMeta: null, // { siteId, siteName, toolNames } | null
  streamingWorkIds: new Set(), // workIds currently streaming — don't overwrite their messages
  abortControllers: {}, // workId -> AbortController — for stopping streaming from any view
  pendingThinkingEffort: 'off',
  pendingPermissionMode: 'workspace',
  labelFilter: null, // null = show all, string = filter by label color
  labelNames: {}, // color -> custom name, e.g. { red: '紧急', blue: '参考' }

  loadWorks: async () => {
    const [worksRes, namesRes, projectsRes] = await Promise.all([
      backendFetch(`${API}/works`),
      backendFetch(`${API}/settings/label-names`).catch(() => null),
      backendFetch(`${API}/projects`).catch(() => null),
    ])
    if (!worksRes.ok) return
    const works = await worksRes.json()
    const labelNames = namesRes?.ok ? await namesRes.json() : {}
    const projects = projectsRes?.ok ? await projectsRes.json() : []
    const nextWorks = Array.isArray(works) ? works : []
    set((state) => ({
      works: nextWorks,
      projects: Array.isArray(projects) ? projects : [],
      labelNames,
      ...(state.activeWorkId && !nextWorks.some((work) => work.id === state.activeWorkId && !work.archived)
        ? { activeWorkId: nextWorks.find((work) => !work.archived)?.id ?? null }
        : {}),
    }))
  },

  createWork: (opts = {}) => {
    const requestKey = JSON.stringify([opts.projectId ?? null, Boolean(opts.forceNew), opts.styleId ?? null])
    if (pendingCreateWorkRequests.has(requestKey)) return pendingCreateWorkRequests.get(requestKey)

    const request = (async () => {
      if (!await leaveWebsiteExploration()) return null
      const reuseEmptyWork = async (work) => {
        set({ activeWorkId: work.id })
        getScheduledTasksStore().then(s => s?.setState({ activeTaskId: null })).catch(() => {})
        // 风格沿用 work 上的 `zcf_role` 字段名（历史字段，改名需要数据迁移）。
        if (opts.styleId !== undefined && work.zcf_role !== opts.styleId) {
          return get().updateWorkStyle(work.id, { zcf_role: opts.styleId })
        }
        return work
      }

      try {
        // If the most recent work is empty (no messages), just switch to it
        const { works, messages } = get()
        const activeWorks = works.filter((work) => !work.archived)
        const latest = opts.forceNew
          ? activeWorks.find((work) => (work.project_id ?? null) === (opts.projectId ?? null) && !work.title)
          : activeWorks[0]
        if (latest) {
          const latestMsgs = messages[latest.id]
          // Empty if: no messages loaded yet and no title, or loaded and truly empty
          const isEmpty = !latest.title && (latestMsgs === undefined || latestMsgs.length === 0)
          if (isEmpty) {
            // If we haven't loaded messages yet, verify with server
            if (latestMsgs === undefined) {
              try {
                const res = await backendFetch(`${API}/works/${latest.id}`)
                if (!res.ok) throw new Error('Failed to load work')
                const data = await res.json()
                set((s) => ({ messages: { ...s.messages, [latest.id]: data.messages } }))
                if (data.messages.length === 0) {
                  return reuseEmptyWork(latest)
                }
              } catch { /* fall through to create */ }
            } else {
              return reuseEmptyWork(latest)
            }
          }
        }
        const body = {}
        if (opts.projectId !== undefined) body.project_id = opts.projectId
        if (opts.styleId !== undefined) body.zcf_role = opts.styleId
        const res = await backendFetch(`${API}/works`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) throw new Error('Failed to create work')
        const work = await res.json()
        set((s) => ({ works: [work, ...s.works], activeWorkId: work.id }))
        getScheduledTasksStore().then(s => s?.setState({ activeTaskId: null })).catch(() => {})
        return work
      } catch (e) {
        console.error('[works] createWork failed:', e)
        showAlert('创建任务失败，请确认后端服务已启动')
        throw e
      }
    })()
    pendingCreateWorkRequests.set(requestKey, request)
    return request.finally(() => {
      if (pendingCreateWorkRequests.get(requestKey) === request) pendingCreateWorkRequests.delete(requestKey)
    })
  },

  createProject: async (name, folderPath) => {
    const res = await backendFetch(`${API}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, folder_path: folderPath }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.detail || 'Failed to create project')
    }
    const project = await res.json()
    set((s) => ({ projects: [project, ...s.projects] }))
    return project
  },

  renameProject: async (id, name) => {
    const res = await backendFetch(`${API}/projects/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.detail || 'Failed to rename project')
    }
    const project = await res.json()
    set((s) => ({ projects: s.projects.map((item) => (item.id === id ? { ...item, ...project } : item)) }))
    return project
  },

  deleteProject: async (id) => {
    const res = await backendFetch(`${API}/projects/${id}`, { method: 'DELETE' })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.detail || 'Failed to delete project')
    }
    set((s) => ({ projects: s.projects.filter((project) => project.id !== id) }))
  },

  selectWork: async (id) => {
    if (!await leaveWebsiteExploration()) return
    set({ activeWorkId: id })
    try { getScheduledTasksStore().then(s => s?.setState({ activeTaskId: null })) } catch {}
    // If this work is currently streaming, don't overwrite in-memory messages with backend data
    // (assistant message hasn't been persisted yet)
    if (get().streamingWorkIds.has(id)) return
    // Always fetch latest messages from backend (channel messages may have been added externally)
    try {
      const res = await backendFetch(`${API}/works/${id}`)
      const data = await res.json()
      set((s) => ({ messages: { ...s.messages, [id]: data.messages } }))
    } catch (e) {
      console.error('[works] selectWork fetch failed:', e)
    }
  },

  /** Reload a work's messages without making it the active main chat. */
  refreshWorkMessages: async (id) => {
    if (!id || get().streamingWorkIds.has(id)) return
    try {
      const res = await backendFetch(`${API}/works/${id}`)
      if (!res.ok) return
      const data = await res.json()
      if (get().streamingWorkIds.has(id)) return
      set((s) => ({ messages: { ...s.messages, [id]: data.messages } }))
    } catch (e) {
      console.error('[works] refreshWorkMessages failed:', e)
    }
  },

  deleteWork: async (id) => {
    try {
      const res = await backendFetch(`${API}/works/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete work')
      discardMessageQueue(id)
      useChatDraftStore.getState().discard(`work:${id}`)
      get().abortControllers[id]?.abort()
      set((s) => {
        const works = s.works.filter((w) => w.id !== id)
        const messages = { ...s.messages }
        const contextSnapshots = { ...s.contextSnapshots }
        const contextTokenAnchors = { ...s.contextTokenAnchors }
        const contextCompactionStatuses = { ...s.contextCompactionStatuses }
        delete messages[id]
        delete contextSnapshots[id]
        delete contextTokenAnchors[id]
        delete contextCompactionStatuses[id]
        return {
          works,
          messages,
          contextSnapshots,
          contextTokenAnchors,
          contextCompactionStatuses,
          activeWorkId: s.activeWorkId === id ? (works[0]?.id ?? null) : s.activeWorkId,
        }
      })
    } catch (e) {
      console.error('[works] deleteWork failed:', e)
      showAlert('删除任务失败，请稍后重试')
      throw e
    }
  },

  setWorkArchived: async (id, archived) => {
    const requestKey = `${id}:${Boolean(archived)}`
    if (pendingArchiveRequests.has(requestKey)) return pendingArchiveRequests.get(requestKey)

    const request = (async () => {
      const res = await backendFetch(`${API}/works/${id}/archive`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: Boolean(archived) }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.detail || '更新归档状态失败')
      set((state) => ({
        works: state.works.map((work) => (work.id === id ? { ...work, archived: Boolean(archived) } : work)),
      }))
      if (archived && get().activeWorkId === id) {
        const nextWork = get().works.find((work) => work.id !== id && !work.archived)
        if (nextWork) await get().selectWork(nextWork.id)
        else set({ activeWorkId: null })
      }
      return data
    })()
    pendingArchiveRequests.set(requestKey, request)
    try {
      return await request
    } finally {
      if (pendingArchiveRequests.get(requestKey) === request) pendingArchiveRequests.delete(requestKey)
    }
  },

  updateTitle: async (id, title) => {
    const nextTitle = title.trim()
    if (!nextTitle) return
    const res = await backendFetch(`${API}/works/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: nextTitle, preserveOrder: true }),
    })
    if (!res.ok) throw new Error('Failed to update title')
    set((s) => ({
      works: s.works.map((w) => (w.id === id ? { ...w, title: nextTitle } : w)),
    }))
  },

  updateLabel: async (id, label) => {
    await backendFetch(`${API}/works/${id}/label`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    })
    set((s) => ({
      works: s.works.map((w) => (w.id === id ? { ...w, label } : w)),
    }))
  },

  /**
   * 修改某个 work 的风格（`zcf_role` 是历史字段名，后端 PATCH `/works/:id/style`）。
   * 先做乐观更新，失败时回滚。
   */
  updateWorkStyle: async (id, prefs) => {
    const previous = get().works.find((w) => w.id === id)
    set((s) => ({
      works: s.works.map((w) => (w.id === id ? { ...w, ...prefs } : w)),
    }))
    try {
      const res = await backendFetch(`${API}/works/${id}/style`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prefs),
      })
      if (!res.ok) throw new Error('Failed to update style')
      const work = await res.json()
      set((s) => ({
        works: s.works.map((w) => (w.id === id ? { ...w, ...work } : w)),
      }))
      return work
    } catch (e) {
      if (previous) {
        set((s) => ({
          works: s.works.map((w) => (w.id === id ? { ...w, ...previous } : w)),
        }))
      }
      throw e
    }
  },

  setLabelFilter: (label) => {
    set({ labelFilter: label })
  },

  saveLabelName: async (color, name) => {
    const updated = { ...get().labelNames }
    if (name.trim()) {
      updated[color] = name.trim()
    } else {
      delete updated[color]
    }
    set({ labelNames: updated })
    await backendFetch(`${API}/settings/label-names`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated),
    })
  },

  // Local-only title update (backend already persisted it)
  updateTitleLocal: (id, title) => {
    set((s) => ({
      works: s.works.map((w) => (w.id === id ? { ...w, title } : w)),
    }))
  },

  appendMessage: (workId, msg) => {
    set((s) => ({
      messages: {
        ...s.messages,
        [workId]: [...(s.messages[workId] ?? []), msg],
      },
    }))
  },

  updateLastMessage: (workId, updater) => {
    set((s) => {
      const msgs = s.messages[workId] ?? []
      if (!msgs.length) return s
      const updated = [...msgs]
      updated[updated.length - 1] = updater(updated[updated.length - 1])
      return { messages: { ...s.messages, [workId]: updated } }
    })
  },

  handleTerminalEvent: (event) => {
    if (!event || event.type !== 'terminal_event') return
    const workId = event.data?.workId
    if (!workId) return

    set((s) => {
      const messages = s.messages[workId]
      if (!messages?.length) return s
      const nextMessages = applyTerminalEventToMessages(messages, event)
      if (nextMessages === messages) return s
      return {
        messages: {
          ...s.messages,
          [workId]: nextMessages,
        },
      }
    })
  },

  setContextSnapshot: (workId, snapshot) => {
    if (!workId || !snapshot) return
    set((s) => {
      const current = s.contextSnapshots[workId]
      const isCompactionSnapshot = snapshot.compaction?.mode === 'conversation_only'
      const hasProviderUsage = snapshot.token_source === 'provider_calibrated'
        && Number.isFinite(Number(snapshot.actual_input_tokens)) && Number(snapshot.actual_input_tokens) > 0
      const nextSnapshot = !isCompactionSnapshot && !hasProviderUsage && snapshot.phase === 'request_start' && Number.isFinite(Number(current?.actual_input_tokens)) && Number(current?.actual_input_tokens) > 0
        ? projectIncrementalContextSnapshot(snapshot, current.actual_input_tokens, current.estimated_total_tokens)
        : snapshot
      const nextAnchor = Number.isFinite(Number(snapshot.actual_input_tokens)) && Number(snapshot.actual_input_tokens) > 0 && snapshot.token_source === 'provider_calibrated'
        ? createContextTokenAnchor(snapshot)
        : s.contextTokenAnchors[workId]
      return {
        contextSnapshots: { ...s.contextSnapshots, [workId]: nextSnapshot },
        contextTokenAnchors: { ...s.contextTokenAnchors, [workId]: nextAnchor },
      }
    })
  },

  setContextUsage: (workId, usage) => {
    const isCompactionProbe = usage?.kind === 'post_compaction_probe'
    const actualInputTokens = isCompactionProbe ? usage?.total_input_tokens : usage?.context_input_tokens
    if (!workId || typeof actualInputTokens !== 'number' || !Number.isFinite(actualInputTokens) || actualInputTokens <= 0) return
    set((s) => {
      const current = s.contextSnapshots[workId]
      if (!current) return s
      const nextSnapshot = isCompactionProbe
        ? calibrateCompactedContextSnapshot(current, actualInputTokens, s.contextTokenAnchors[workId])
        : calibrateContextSnapshot(current, actualInputTokens)
      const nextAnchor = createContextTokenAnchor(nextSnapshot)
      return {
        contextSnapshots: {
          ...s.contextSnapshots,
          [workId]: nextSnapshot,
        },
        contextTokenAnchors: { ...s.contextTokenAnchors, [workId]: nextAnchor },
      }
    })
  },

  setContextCompactionStatus: (workId, status) => {
    if (!workId) return
    set((s) => {
      const contextCompactionStatuses = { ...s.contextCompactionStatuses }
      if (!status) delete contextCompactionStatuses[workId]
      else contextCompactionStatuses[workId] = status
      return { contextCompactionStatuses }
    })
  },

  setMemoryStatus: (workId, status) => {
    if (!workId || !status) return
    set((s) => {
      const current = s.memoryStatuses[workId]
      const isStaleCompletion = status.status !== 'processing'
        && current?.status === 'processing'
        && current.eventId
        && status.eventId
        && current.eventId !== status.eventId
      if (isStaleCompletion) return s
      return { memoryStatuses: { ...s.memoryStatuses, [workId]: status } }
    })
  },

  clearMemoryStatus: (workId) => {
    if (!workId) return
    set((s) => {
      if (!(workId in s.memoryStatuses)) return s
      const memoryStatuses = { ...s.memoryStatuses }
      delete memoryStatuses[workId]
      return { memoryStatuses }
    })
  },

  stopGeneration: (workId) => {
    set((s) => {
      const nextStreaming = new Set(s.streamingWorkIds)
      nextStreaming.delete(workId)
      const controllers = { ...s.abortControllers }
      delete controllers[workId]

      const msgs = s.messages[workId] ?? []
      if (!msgs.length) {
        return { streamingWorkIds: nextStreaming, abortControllers: controllers }
      }

      const updated = mapMessagesAfterStop(msgs)

      return {
        messages: { ...s.messages, [workId]: updated },
        streamingWorkIds: nextStreaming,
        abortControllers: controllers,
      }
    })
  },

  startHealthCheck: async (siteId, siteName, toolNames, prompt) => {
    const res = await backendFetch(`${API}/works`, { method: 'POST' })
    const work = await res.json()
    // Rename the work to indicate health check
    await backendFetch(`${API}/works/${work.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `[健康检查] ${siteName}` }),
    })
    set((s) => ({
      works: [{ ...work, title: `[健康检查] ${siteName}` }, ...s.works],
      activeWorkId: work.id,
      healthCheckMeta: { siteId, siteName, toolNames, workId: work.id },
      pendingMessage: prompt,
    }))
    try { getScheduledTasksStore().then(s => s?.setState({ activeTaskId: null })) } catch {}
    return work
  },
}))
