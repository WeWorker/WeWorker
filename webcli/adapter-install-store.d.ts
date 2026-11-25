import type { DesktopAdapterPaths } from './adapter-desktop.js'

export function compareAdapterVersions(a: string, b: string): number

export function installAdapter(input: {
  files: Map<string, Buffer | string>
  origin: { kind: 'generated' | 'local' | 'development' | 'hub'; service?: string }
  uploader?: string
  activate?: boolean
  preserveDisabled?: boolean
  expectedSourceDigest?: string | null
  expectedStateRevision?: number
  allowPermissionChange?: boolean
  allowSourceChange?: boolean
  allowDowngrade?: boolean
}, options?: { paths?: DesktopAdapterPaths }): { name: string; version: string; digest: string; revision: number; executionRoot: string }

export function removeInstalledAdapter(name: string, options?: {
  expectedStateRevision?: number
  expectedSourceDigest?: string | null
}): { name: string; action: string; revision: number }
