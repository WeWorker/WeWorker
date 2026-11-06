export interface V2Command {
  id: string
  runtime: string
  module: string
  description: string
  schema: Record<string, unknown>
  [key: string]: unknown
}
export interface V2Manifest {
  name: string
  version: string
  description: string
  match?: string[]
  runtime_allowed_hosts?: string[]
  commands: V2Command[]
  [key: string]: any
}
export interface V2Package {
  name: string
  version: string
  digest: string
  root: string
  manifest: V2Manifest
  commands: V2Command[]
  files: Map<string, Buffer>
  origin?: { kind: 'generated' | 'local' | 'development' | 'hub'; service?: string } | null
}
export function buildAdapterCatalog(options?: object): {
  profile: string
  revision: number
  effective: Array<V2Package & { source: string }>
  candidates: Array<V2Package & { source: string }>
  diagnostics: Array<{ name?: string; names?: string[]; code: string }>
}
