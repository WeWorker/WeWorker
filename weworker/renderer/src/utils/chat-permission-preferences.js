const MODES = new Set(['ask', 'workspace', 'full'])
const STORAGE_KEY = 'weworker.chat.permission-mode'
const selections = new Map()
const storage = () => globalThis.window?.localStorage
const key = scope => scope ? STORAGE_KEY + ':' + scope : STORAGE_KEY

// Automatic handoff and the visible composer must resolve the same preference.
// Development defaults to full, without changing the main chat's saved mode.
export const explorationDevelopmentPermissionSettings = workId => ({
  permissionScope: 'exploration-development:' + workId,
  defaultPermissionMode: 'full',
})
export function readChatPermissionMode({ permissionScope, defaultPermissionMode = 'workspace' } = {}) {
  if (selections.has(key(permissionScope))) return selections.get(key(permissionScope))
  const fallback = MODES.has(defaultPermissionMode) ? defaultPermissionMode : 'workspace'
  try {
    const saved = storage()?.getItem(key(permissionScope))
    if (saved !== undefined) return MODES.has(saved) ? saved : fallback
  } catch { /* Storage unavailable: use this conversation's default. */ }
  return fallback
}
export function saveChatPermissionMode(mode, permissionScope) {
  if (!MODES.has(mode)) return
  try {
    const target = storage()
    if (!target) throw new Error('Storage unavailable')
    target.setItem(key(permissionScope), mode)
    selections.delete(key(permissionScope))
  } catch { selections.set(key(permissionScope), mode) }
}
