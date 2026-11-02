import { AsyncLocalStorage } from 'node:async_hooks'
import type { ChannelPermissionMode } from './channels/channel-permissions.js'

const workspaceRoot = new AsyncLocalStorage<string>()
const permissionMode = new AsyncLocalStorage<ChannelPermissionMode>()

/** Scope tool callbacks without changing global settings or another conversation. */
export function runWithWorkspaceDirectory<T>(directory: string | undefined, action: () => T, mode?: ChannelPermissionMode): T {
  const run = () => mode ? permissionMode.run(mode, action) : action()
  return directory ? workspaceRoot.run(directory, run) : run()
}

export function getActiveWorkspaceDirectory(): string | undefined {
  return workspaceRoot.getStore()
}

export function getActivePermissionMode(): ChannelPermissionMode | undefined {
  return permissionMode.getStore()
}
