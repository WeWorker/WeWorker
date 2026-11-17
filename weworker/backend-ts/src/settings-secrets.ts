import type { Settings } from './config.js'

export const SECRET_FIELD_PATHS = [
  ['api_key'],
  ['api_key_anthropic'],
  ['api_key_glm'],
  ['api_key_bank_coding'],
  ['api_key_deepseek'],
  ['api_key_custom'],
  ['openai_api_key_custom'],
  ['exploration_api_key'],
  ['exploration_providers', 'anthropic', 'api_key'],
  ['exploration_providers', 'glm', 'api_key'],
  ['exploration_providers', 'deepseek', 'api_key'],
  ['exploration_providers', 'custom', 'api_key'],
  ['channels', 'qq', 'app_secret'],
  ['channels', 'weixin', 'token'],
  ['channels', 'wecom', 'secret'],
  ['channels', 'feishu', 'app_secret'],
] as const

export type SecretFieldKey = typeof SECRET_FIELD_PATHS[number] extends readonly (infer P)[]
  ? P extends readonly string[] ? P : never
  : never

export function secretFieldId(path: readonly string[]): string {
  return path.join('.')
}

function secretFieldPaths(settings: unknown): readonly (readonly string[])[] {
  const configurations = (settings as Settings | null)?.model_configurations
  return [
    ...SECRET_FIELD_PATHS,
    ...Object.entries((settings as Settings | null)?.channel_configurations || {}).map(([id, entry]) =>
      ['channel_configurations', id, 'config', entry.type === 'weixin' ? 'token' : entry.type === 'wecom' ? 'secret' : 'app_secret']),
    ...Object.keys(configurations || {}).map(id => ['model_configurations', id, 'api_key']),
    ...Object.keys(configurations || {}).map(id => ['model_configurations', id, 'openai_api_key']),
  ]
}

function getByPath(source: unknown, path: readonly string[]): string {
  let current: unknown = source
  for (const segment of path) {
    if (!current || typeof current !== 'object') return ''
    current = (current as Record<string, unknown>)[segment]
  }
  return typeof current === 'string' ? current : ''
}

function setByPath(target: Record<string, unknown>, path: readonly string[], value: string): void {
  let current: Record<string, unknown> = target
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]
    const next = current[segment]
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      current[segment] = {}
    }
    current = current[segment] as Record<string, unknown>
  }
  current[path[path.length - 1]] = value
}

export function extractSecrets(settings: Settings): Record<string, string> {
  const secrets: Record<string, string> = {}
  for (const path of secretFieldPaths(settings)) {
    const value = getByPath(settings, path).trim()
    if (value) secrets[secretFieldId(path)] = value
  }
  return secrets
}

export function applySecrets(settings: Settings, secrets: Record<string, string>): Settings {
  const next = structuredClone(settings) as unknown as Record<string, unknown>
  for (const path of secretFieldPaths(settings)) {
    const value = secrets[secretFieldId(path)] ?? ''
    setByPath(next, path, value)
  }
  return next as unknown as Settings
}

export function clearSecretsOnDisk(settings: Settings): Settings {
  const next = structuredClone(settings) as unknown as Record<string, unknown>
  for (const path of secretFieldPaths(settings)) {
    setByPath(next, path, '')
  }
  return next as unknown as Settings
}

export function collectPlaintextSecretsFromRaw(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {}
  const secrets: Record<string, string> = {}
  for (const path of secretFieldPaths(raw)) {
    const value = getByPath(raw, path).trim()
    if (value) secrets[secretFieldId(path)] = value
  }
  return secrets
}

export function rawFileHasPlaintextSecrets(raw: unknown): boolean {
  return Object.keys(collectPlaintextSecretsFromRaw(raw)).length > 0
}
