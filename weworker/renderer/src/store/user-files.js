import { create } from 'zustand'
import { backendFetch } from '../api/http.js'
const EXPANDED_STORAGE_KEY = 'weworker:user-files:expanded-paths'
const DIRECTORY_STORAGE_KEY = 'weworker:user-files:directory'

function loadExpandedPaths() {
  try {
    const raw = localStorage.getItem(EXPANDED_STORAGE_KEY)
    if (raw === null) return null
    const paths = JSON.parse(raw || '[]')
    return Array.isArray(paths) ? paths.filter((p) => typeof p === 'string') : []
  } catch {
    return []
  }
}

function saveExpandedPaths(paths) {
  try {
    localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(paths))
  } catch {
    // Ignore storage failures; the in-memory state still works for this session.
  }
}

function loadCachedDirectory() {
  try {
    return localStorage.getItem(DIRECTORY_STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

function saveCachedDirectory(directory) {
  try {
    if (directory) localStorage.setItem(DIRECTORY_STORAGE_KEY, directory)
  } catch {
    // Ignore storage failures; the backend remains the source of truth.
  }
}

const INITIAL_EXPANDED_PATHS = loadExpandedPaths()
const INITIAL_DIRECTORY = loadCachedDirectory()

function basename(filePath) {
  return String(filePath || '').split(/[\\/]/).filter(Boolean).pop() || 'file'
}

function normalizeFilePath(filePath) {
  return String(filePath || '').replace(/\\/g, '/').replace(/\/+$/, '')
}

function isSameOrChildPath(filePath, targetPath) {
  const normalizedFilePath = normalizeFilePath(filePath)
  const normalizedTargetPath = normalizeFilePath(targetPath)
  return normalizedFilePath === normalizedTargetPath || normalizedFilePath.startsWith(normalizedTargetPath + '/')
}

function removePathFromTree(items, targetPath) {
  let changed = false
  const nextItems = []

  for (const item of items || []) {
    if (isSameOrChildPath(item?.path, targetPath)) {
      changed = true
      continue
    }

    if (item?.is_directory && Array.isArray(item.children) && item.children.length) {
      const nextChildren = removePathFromTree(item.children, targetPath)
      if (nextChildren !== item.children) {
        changed = true
        nextItems.push({ ...item, children: nextChildren })
        continue
      }
    }

    nextItems.push(item)
  }

  return changed ? nextItems : items
}

function friendlyFileError(error, fallback) {
  const message = error?.message || String(error || '')
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return '本地服务未连接，请稍后重试或重启 WeWorker'
  }
  return message || fallback
}

function isRecoverableBackendMessage(message) {
  return /本地服务未连接|failed to fetch|networkerror|load failed|network error/i.test(String(message || ''))
}

function isTransientBackendError(error) {
  const message = error?.message || String(error || '')
  return /failed to fetch|networkerror|load failed|event stream failed|network error/i.test(message)
}

async function backendFetchWithRetry(pathOrUrl, options = {}, retries = 5) {
  const retryDelays = [450, 900, 1500, 2500, 3500]
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await backendFetch(pathOrUrl, options)
    } catch (error) {
      lastError = error
      if (!isTransientBackendError(error) || attempt >= retries) break
      await delay(retryDelays[attempt] || 3500)
    }
  }
  throw lastError
}

function toImportProgress(job, fallback = {}) {
  if (!job) return null
  return {
    id: job.id || fallback.id || '',
    status: job.status || fallback.status || 'running',
    totalBytes: Number(job.total_bytes || 0),
    copiedBytes: Number(job.copied_bytes || 0),
    totalFiles: Number(job.total_files || 0),
    copiedFiles: Number(job.copied_files || 0),
    currentFile: job.current_file || fallback.currentFile || '',
    error: job.error || null,
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export const useUserFilesStore = create((set, get) => ({
  open: false,
  workspaceWorkId: null,
  directory: INITIAL_DIRECTORY,
  files: [],
  expandedPaths: INITIAL_EXPANDED_PATHS || [],
  expandedPathsInitialized: INITIAL_EXPANDED_PATHS !== null,
  loading: false,
  error: null,
  externalDragActive: false,
  dragTargetPath: '',
  importProgress: null,
  deleteProgress: null,
  chatAttachmentSeq: 0,
  pendingChatAttachmentTarget: null,
  pendingChatAttachments: [],
  setExternalDragActive: (active) => set({ externalDragActive: active, dragTargetPath: active ? get().dragTargetPath : '' }),
  setDragTargetPath: (path) => set({ dragTargetPath: path || '' }),
  dismissImportProgress: () => set((s) => (
    s.importProgress && (s.importProgress.status === 'done' || s.importProgress.status === 'error')
      ? { importProgress: null }
      : {}
  )),
  dismissDeleteProgress: () => set((s) => (
    s.deleteProgress && (s.deleteProgress.status === 'done' || s.deleteProgress.status === 'error')
      ? { deleteProgress: null }
      : {}
  )),
  clearRecoverableBackendError: () => set((s) => {
    const next = {}
    if (isRecoverableBackendMessage(s.error)) next.error = null
    if (s.deleteProgress?.status === 'error' && isRecoverableBackendMessage(s.deleteProgress.error)) {
      next.deleteProgress = null
    }
    return next
  }),
  queueChatAttachments: (files, target = 'welcome') => {
    const attachments = (files || [])
      .filter((file) => file && !file.is_directory && file.path)
      .map((file) => ({
        path: file.path,
        name: file.name || String(file.path).split(/[\\/]/).filter(Boolean).pop() || 'file',
      }))
    if (!attachments.length || !target) return
    set((s) => ({
      chatAttachmentSeq: s.chatAttachmentSeq + 1,
      pendingChatAttachmentTarget: target,
      pendingChatAttachments: attachments,
    }))
  },
  clearPendingChatAttachments: (seq) => set((s) => (
    seq === undefined || seq === s.chatAttachmentSeq
      ? { pendingChatAttachments: [], pendingChatAttachmentTarget: null }
      : {}
  )),
  setExpandedPaths: (paths) => {
    const next = Array.from(new Set((paths || []).filter(Boolean)))
    saveExpandedPaths(next)
    set({ expandedPaths: next })
  },
  setWorkspaceWorkId: (workspaceWorkId) => {
    const next = workspaceWorkId || null
    if (next === get().workspaceWorkId) return
    set({ workspaceWorkId: next, directory: '', files: [], error: null })
    if (get().open) get().load()
  },
  openPanel: async () => {
    set({ open: true })
    await get().load()
  },
  closePanel: () => set({ open: false }),
  togglePanel: async () => {
    const next = !get().open
    set({ open: next })
    if (next) await get().load()
  },
  load: async (workspaceWorkId = get().workspaceWorkId) => {
    set({ loading: true, error: null })
    try {
      const query = workspaceWorkId ? `?work_id=${encodeURIComponent(workspaceWorkId)}` : ''
      const res = await backendFetchWithRetry('/user-files' + query)
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || '\u52a0\u8f7d\u7528\u6237\u76ee\u5f55\u5931\u8d25')
      if (workspaceWorkId !== get().workspaceWorkId) return
      const directory = data.directory || ''
      const shouldInitializeExpanded = !get().expandedPathsInitialized && directory
      const expandedPaths = shouldInitializeExpanded ? [directory] : get().expandedPaths
      if (shouldInitializeExpanded) saveExpandedPaths(expandedPaths)
      saveCachedDirectory(directory)
      set({ directory, files: data.files || [], expandedPaths, expandedPathsInitialized: true, loading: false })
    } catch (e) {
      if (workspaceWorkId !== get().workspaceWorkId) return
      set({ error: friendlyFileError(e, '\u52a0\u8f7d\u7528\u6237\u76ee\u5f55\u5931\u8d25'), loading: false })
    }
  },
  createFolder: async (parentPath, name) => {
    const folderName = (name || '').trim()
    if (!folderName) return null
    set({ loading: true, error: null })
    try {
      const res = await backendFetch('/user-files/folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent_path: parentPath, name: folderName, work_id: get().workspaceWorkId || undefined }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || '\u521b\u5efa\u6587\u4ef6\u5939\u5931\u8d25')
      await get().load()
      return data.folder || null
    } catch (e) {
      set({ error: friendlyFileError(e, '\u521b\u5efa\u6587\u4ef6\u5939\u5931\u8d25'), loading: false, open: true })
      return null
    }
  },

  createFile: async (parentPath, name) => {
    const fileName = (name || '').trim()
    if (!fileName) return null
    set({ loading: true, error: null })
    try {
      const res = await backendFetch('/user-files/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent_path: parentPath, name: fileName, work_id: get().workspaceWorkId || undefined }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || '\u521b\u5efa\u6587\u4ef6\u5931\u8d25')
      await get().load()
      return data.file || null
    } catch (e) {
      set({ error: friendlyFileError(e, '\u521b\u5efa\u6587\u4ef6\u5931\u8d25'), loading: false, open: true })
      return null
    }
  },

  renameItem: async (targetPath, name) => {
    const nextName = (name || '').trim()
    if (!targetPath || !nextName) return null
    set({ loading: true, error: null })
    try {
      const res = await backendFetch('/user-files/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_path: targetPath, name: nextName, work_id: get().workspaceWorkId || undefined }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || '\u91cd\u547d\u540d\u5931\u8d25')
      await get().load()
      return data.item || data.folder || data.file || null
    } catch (e) {
      set({ error: friendlyFileError(e, '\u91cd\u547d\u540d\u5931\u8d25'), loading: false, open: true })
      return null
    }
  },

  deleteItem: async (targetPath) => {
    if (!targetPath) return false
    const targetName = basename(targetPath)
    const progress = { status: 'running', targetPath, targetName, percent: 18, error: null }
    set({ error: null, open: true, deleteProgress: progress })
    try {
      const res = await backendFetchWithRetry('/user-files/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_path: targetPath, work_id: get().workspaceWorkId || undefined }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || '\u5220\u9664\u5931\u8d25')
      set((state) => ({
        files: removePathFromTree(state.files, targetPath),
        expandedPaths: state.expandedPaths.filter((path) => !isSameOrChildPath(path, targetPath)),
        open: true,
        deleteProgress: { ...progress, status: 'refreshing', percent: 76 },
      }))
      saveExpandedPaths(get().expandedPaths)
      void (async () => {
        await get().load()
        set({ open: true, deleteProgress: { ...progress, status: 'done', percent: 100 } })
        setTimeout(() => {
          const state = get()
          if (state.deleteProgress?.targetPath === targetPath && state.deleteProgress.status === 'done') {
            set({ deleteProgress: null })
          }
        }, 1200)
      })()
      return true
    } catch (e) {
      const message = friendlyFileError(e, '\u5220\u9664\u5931\u8d25')
      set({ error: message, open: true, deleteProgress: { ...progress, status: 'error', error: message } })
      return false
    }
  },

  pasteItem: async (sourcePath, targetParentPath, mode) => {
    if (!sourcePath || !targetParentPath || !mode) return null
    set({ loading: true, error: null })
    try {
      const res = await backendFetch('/user-files/paste', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_path: sourcePath, target_parent_path: targetParentPath, mode, work_id: get().workspaceWorkId || undefined }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || '\u7c98\u8d34\u5931\u8d25')
      await get().load()
      return data.item || data.folder || data.file || null
    } catch (e) {
      set({ error: friendlyFileError(e, '\u7c98\u8d34\u5931\u8d25'), loading: false, open: true })
      return null
    }
  },

  importFiles: async (paths, targetParentPath = '') => {
    if (!paths?.length) return null
    const firstName = basename(paths[0])
    set({
      loading: true,
      error: null,
      open: true,
      importProgress: {
        id: '',
        status: 'pending',
        totalBytes: 0,
        copiedBytes: 0,
        totalFiles: paths.length,
        copiedFiles: 0,
        currentFile: firstName,
        error: null,
      },
    })
    try {
      const res = await backendFetch('/user-files/import-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths, target_parent_path: targetParentPath || undefined, work_id: get().workspaceWorkId || undefined }),
      })
      let job = await res.json()
      if (!res.ok) throw new Error(job.detail || '\u5bfc\u5165\u7528\u6237\u76ee\u5f55\u5931\u8d25')
      set({ importProgress: toImportProgress(job, { currentFile: firstName }) })

      while (job.status !== 'done' && job.status !== 'error') {
        await delay(220)
        const progressRes = await backendFetch('/user-files/import-jobs/' + encodeURIComponent(job.id))
        const progressJob = await progressRes.json()
        if (!progressRes.ok) throw new Error(progressJob.detail || '\u83b7\u53d6\u5bfc\u5165\u8fdb\u5ea6\u5931\u8d25')
        job = progressJob
        set({ importProgress: toImportProgress(job, { currentFile: firstName }) })
      }

      if (job.status === 'error') throw new Error(job.error || '\u5bfc\u5165\u7528\u6237\u76ee\u5f55\u5931\u8d25')
      await get().load()
      set({ open: true, importProgress: toImportProgress(job, { status: 'done', currentFile: firstName }) })
      setTimeout(() => {
        const state = get()
        if (state.importProgress?.id === job.id && state.importProgress.status === 'done') {
          set({ importProgress: null })
        }
      }, 1200)
      return job.files || []
    } catch (e) {
      const message = friendlyFileError(e, '\u5bfc\u5165\u7528\u6237\u76ee\u5f55\u5931\u8d25')
      set((s) => ({
        error: message,
        loading: false,
        open: true,
        importProgress: {
          ...(s.importProgress || {
            id: '',
            totalBytes: 0,
            copiedBytes: 0,
            totalFiles: paths.length,
            copiedFiles: 0,
            currentFile: firstName,
          }),
          status: 'error',
          error: message,
        },
      }))
      return null
    }
  },
}))
