import { AsyncLocalStorage } from 'node:async_hooks'

const workspaceRoot = new AsyncLocalStorage<string>()

/** Scope tool callbacks without changing global settings or another conversation. */
export function runWithWorkspaceDirectory<T>(directory: string | undefined, action: () => T): T {
  return directory ? workspaceRoot.run(directory, action) : action()
}

export function getActiveWorkspaceDirectory(): string | undefined {
  return workspaceRoot.getStore()
}
