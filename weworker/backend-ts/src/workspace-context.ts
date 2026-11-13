import { getUserDirectory } from './config.js'
import * as works from './works-store.js'
import { explorationIdForConversation } from './exploration-conversations.js'
import { getExplorationTaskDirectory } from './exploration-workspace.js'
import { isGuardedDesktopMode, type ChannelPermissionMode } from './channels/channel-permissions.js'

const defaults = {
  getWork: (id: string): { workspace_directory: string } | null => works.getWork(id),
  getProject: (id: string): { folder_path: string } | null => works.getProject(id),
  explorationIdForWork: explorationIdForConversation,
  userDirectory: getUserDirectory,
  explorationDirectory: getExplorationTaskDirectory,
}

/** Resolve a trusted scope, never an arbitrary root supplied by the renderer. */
export function workspaceDirectoryForContext(workId?: string, projectId?: string, scope?: string, deps = defaults): string | undefined {
  if (scope) {
    const explorationId = /^website-exploration:([A-Za-z0-9_-]{1,200})$/.exec(scope)?.[1]
    if (!explorationId || workId || projectId) throw new Error('请先创建或选择探索记录')
    return deps.explorationDirectory(explorationId)
  }
  if (workId) {
    const explorationId = deps.explorationIdForWork(workId)
    if (explorationId) return deps.explorationDirectory(explorationId)
    const work = deps.getWork(workId)
    if (!work) throw new Error('work not found')
    return work.workspace_directory
  }
  if (projectId) {
    const project = deps.getProject(projectId)
    if (!project) throw new Error('project not found')
    return project.folder_path
  }
  return undefined
}

export function resolveAgentWorkspaceDirectory(workId: string | undefined, mode: ChannelPermissionMode, deps = defaults): string | undefined {
  // Ownership includes existing conversations whose input.json lives in a legacy
  // folder. Leave that metadata intact so history can still restore attachments.
  const explorationId = workId ? deps.explorationIdForWork(workId) : null
  if (explorationId) return deps.explorationDirectory(explorationId)
  if (workId && isGuardedDesktopMode(mode)) return deps.getWork(workId)?.workspace_directory || deps.userDirectory()
  return undefined
}
