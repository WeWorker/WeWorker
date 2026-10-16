export interface DesktopAdapter {
  id: string
  name: string
  description?: string
  display?: string
  match?: string[]
  homepage_url?: string
  requires_auth?: boolean
  auth_check_tool?: string
  gate_aliases?: string[]
  hidden?: boolean
  icon?: string
  test_prompts?: string[]
  scenarios?: unknown[]
  route_templates?: unknown[]
  prompt_var_display?: Record<string, { label?: string; style?: 'code' | 'placeholder'; resolve?: string }>
  i18n?: { zh?: { name?: string; description?: string } }
  commands: Array<{ name: string; id: string; aliases?: string[]; runtime: string; execution?: { type: 'api'; runtime: 'background' }; safety: string; requires_confirmation?: boolean; description: string; schema: Record<string, unknown> }>
  managed: { enabled: boolean; profile: string; source: string | null; digest: string | null; version: string | null; canEnable: boolean; diagnostics: string[] }
}
/** Opaque catalog snapshot; only the fields the desktop host reads are typed. */
export interface DesktopAdapterCatalog {
  profile: string
  revision: number
  effective: Array<{ name: string; digest: string; version: string; source: string }>
  diagnostics: Array<{ name?: string; names?: string[]; source?: string; code: string }>
}
export interface DesktopAdapterPaths {
  profile: string
  builtinDir: string
  userDir: string
  stateDir: string
  packageDir: string
}
export interface DesktopAdapterState {
  revision: number
  installations: Record<string, { name?: string; digest?: string; profile?: string } | undefined>
  selections: Record<string, unknown>
  development: Record<string, { root?: string } | undefined>
}
/** Options shared by catalog readers. `catalog` reuses an already built snapshot. */
export interface DesktopAdapterCatalogOptions {
  catalog?: DesktopAdapterCatalog
  paths?: DesktopAdapterPaths
  state?: DesktopAdapterState
}
export function buildDesktopAdapterCatalog(options?: DesktopAdapterCatalogOptions): DesktopAdapterCatalog
export function readDesktopAdapterCatalogInputs(options?: object): { paths: DesktopAdapterPaths; state: DesktopAdapterState }
export function describeDesktopAdapters(options?: DesktopAdapterCatalogOptions): { adapters: DesktopAdapter[]; managedNames: Set<string>; revision: number }
export function toggleDesktopAdapter(name: string, options?: object): boolean | null
export function resolveDesktopUserAdaptersDir(): string
export function refreshDesktopAdapterSkills(target: string, options?: DesktopAdapterCatalogOptions): { installed: number; retired: number; preserved: string[] }
export function isManagedAdapterSkillCurrent(content: string, directoryName?: string): boolean
export function createManagedAdapterSkillValidator(options?: DesktopAdapterCatalogOptions): (content: string, directoryName?: string) => boolean
