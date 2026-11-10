import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { parse as parseToml } from 'smol-toml'
import { parse as parseJsonc, type ParseError } from 'jsonc-parser'
import type { Settings } from './config.js'
import { DEFAULT_CONTEXT_LIMIT } from './context-window.js'
import { activateModelConfiguration, type ModelConfiguration } from './model-configurations.js'
import { normalizeLlmUrlInput, type LlmProtocol } from './llm-egress.js'

type RecordValue = Record<string, any>
type Product = 'Claude Code' | 'Codex' | 'WorkBuddy' | 'CodeBuddy' | 'OpenCode'
export interface DiscoveredProvider {
  sourceId: string
  product: Product
  configuration: ModelConfiguration
}
export interface DiscoveryOptions {
  home?: string
  env?: NodeJS.ProcessEnv
}
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : ''

// Only product configuration files are read. Never run credential helpers or
// inspect session histories, project directories, browser data or login tokens.
export async function discoverLocalProviders(options: DiscoveryOptions = {}) {
  const home = options.home ?? os.homedir()
  const env = options.env ?? process.env
  const providers: DiscoveredProvider[] = []
  const issues = new Set<Product>()
  async function read(file: string, product: Product, toml = false, modelsArray = false): Promise<RecordValue> {
    let handle: fs.FileHandle | undefined
    try {
      handle = await fs.open(file, 'r')
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > 1024 * 1024) { issues.add(product); return {} }
      const input = (await handle.readFile('utf8')).replace(/^\uFEFF/, '')
      if (toml) return record(parseToml(input))
      const errors: ParseError[] = []
      const parsed = parseJsonc(input, errors, { allowTrailingComma: true })
      if (errors.length) { issues.add(product); return {} }
      return modelsArray && Array.isArray(parsed) ? { models: parsed } : record(parsed)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issues.add(product)
      return {}
    } finally { await handle?.close() }
  }
  function expand(value: unknown, variables: RecordValue = env): string {
    let missing = false
    const expanded = text(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, dollarKey, envKey) => {
      const replacement = text(variables[dollarKey || envKey])
      if (!replacement) missing = true
      return replacement
    })
    return missing || /\{file:/.test(expanded) ? '' : expanded
  }
  function add(product: Product, slot: string, key: unknown, url: unknown, model: unknown,
    protocol: LlmProtocol, authType: 'api_key' | 'auth_token' = 'api_key', full = false) {
    const apiKey = expand(key)
    const baseUrl = expand(url)
    const modelName = text(model)
    if (!apiKey || !baseUrl || modelName.length > 200 || /[\r\n]/.test(apiKey)) return
    try {
      const endpoint = new URL(baseUrl)
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return
      const normalized = normalizeLlmUrlInput(baseUrl, full)
      const sourceId = createHash('sha256').update(`${product}\0${slot}`).digest('hex').slice(0, 24)
      if (providers.some(item => item.sourceId === sourceId)) return
      providers.push({ sourceId, product, configuration: {
        name: product, provider_id: 'custom', api_key: apiKey, model: modelName,
        base_url: normalized, base_url_is_full: full, auth_type: authType,
        weworker_protocol: protocol, openai_api_key: '', openai_base_url: '',
        context_limit: DEFAULT_CONTEXT_LIMIT, external_source_id: sourceId, external_product: product,
      } })
    } catch { issues.add(product) }
  }

  const claudeRoot = text(env.CLAUDE_CONFIG_DIR) || path.join(home, '.claude')
  const claude = await read(path.join(claudeRoot, 'settings.json'), 'Claude Code')
  const claudeLocal = await read(path.join(claudeRoot, 'settings.local.json'), 'Claude Code')
  const claudeEnv = { ...record(claude.env), ...record(claudeLocal.env) }
  const claudeKey = claudeEnv.ANTHROPIC_AUTH_TOKEN || claudeEnv.ANTHROPIC_API_KEY
  const claudeModel = claudeEnv.ANTHROPIC_MODEL || claudeLocal.model || claude.model
  const claudeAliases: Record<string, string> = {
    sonnet: claudeEnv.ANTHROPIC_DEFAULT_SONNET_MODEL,
    opus: claudeEnv.ANTHROPIC_DEFAULT_OPUS_MODEL,
    haiku: claudeEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL,
  }
  add('Claude Code', 'default', claudeKey, claudeEnv.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    Object.hasOwn(claudeAliases, text(claudeModel)) ? claudeAliases[text(claudeModel)] : claudeModel,
    'anthropic_messages', claudeEnv.ANTHROPIC_AUTH_TOKEN ? 'auth_token' : 'api_key')

  const codexRoot = text(env.CODEX_HOME) || path.join(home, '.codex')
  const codex = await read(path.join(codexRoot, 'config.toml'), 'Codex', true)
  const codexAuth = await read(path.join(codexRoot, 'auth.json'), 'Codex')
  const codexProfiles = record(codex.profiles)
  const selectedProfile = record(codexProfiles[text(codex.profile)])
  const codexConfig = { ...codex, ...selectedProfile }
  const codexProviderId = text(codexConfig.model_provider) || 'openai'
  const codexProvider = record(record(codex.model_providers)[codexProviderId])
  // OAuth sessions are product-specific and cannot be used as API credentials.
  const codexKey = codexProvider.env_key ? env[text(codexProvider.env_key)]
    : codexProvider.experimental_bearer_token || codexAuth.OPENAI_API_KEY
      || (codexProviderId === 'openai' && Object.keys(codex).length ? env.OPENAI_API_KEY : '')
  const wireApi = text(codexProvider.wire_api) || 'responses'
  if (wireApi === 'responses' || wireApi === 'chat') add('Codex', codexProviderId, codexKey,
    codexProvider.base_url || (codexProviderId === 'openai' ? 'https://api.openai.com/v1' : ''),
    codexConfig.model, wireApi === 'chat' ? 'openai_chat_completions' : 'openai_responses', 'auth_token')

  for (const [product, directory] of [['WorkBuddy', '.workbuddy'], ['CodeBuddy', '.codebuddy']] as const) {
    const root = (product === 'WorkBuddy' ? text(env.WORKBUDDY_CONFIG_DIR) : '')
      || text(env.CODEBUDDY_CONFIG_DIR) || path.join(home, directory)
    const settings = await read(path.join(root, 'settings.json'), product)
    const variables = { ...env, ...record(settings.env) }
    const models = await read(path.join(root, 'models.json'), product, false, true)
    for (const model of Array.isArray(models.models) ? models.models.slice(0, 100) : []) {
      const item = record(model)
      const responses = item.api === 'openai-responses'
      if (item.api && !['openai-responses', 'openai-completions'].includes(item.api)) continue
      const url = expand(item.url, variables)
      const full = !responses && (product === 'CodeBuddy' || item.useCustomProtocol === true || /\/chat\/completions\/?$/.test(url))
      add(product, text(item.id), expand(item.apiKey, variables), url, item.id,
        responses ? 'openai_responses' : 'openai_chat_completions', 'auth_token', full)
    }
  }

  const openCodeRoot = path.join(text(env.XDG_CONFIG_HOME) || path.join(home, '.config'), 'opencode')
  const openCode = { ...await read(path.join(openCodeRoot, 'opencode.json'), 'OpenCode'),
    ...await read(path.join(openCodeRoot, 'opencode.jsonc'), 'OpenCode') }
  const openCodeAuth = await read(path.join(text(env.XDG_DATA_HOME) || path.join(home, '.local', 'share'), 'opencode', 'auth.json'), 'OpenCode')
  const selection = text(openCode.model)
  const separator = selection.indexOf('/')
  if (separator > 0) {
    const providerId = selection.slice(0, separator)
    const definition = record(record(openCode.provider)[providerId])
    const apiOptions = record(definition.options)
    const auth = record(openCodeAuth[providerId])
    const key = apiOptions.apiKey || (auth.type === 'api' ? auth.key : '')
    const protocols: Record<string, LlmProtocol> = {
      '@ai-sdk/anthropic': 'anthropic_messages', '@ai-sdk/openai': 'openai_responses',
      '@ai-sdk/openai-compatible': 'openai_chat_completions',
    }
    const defaults: Record<string, { npm: string; url: string }> = {
      anthropic: { npm: '@ai-sdk/anthropic', url: 'https://api.anthropic.com' },
      openai: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
    }
    const protocol = protocols[text(definition.npm) || defaults[providerId]?.npm]
    if (protocol) add('OpenCode', providerId, key, apiOptions.baseURL || defaults[providerId]?.url, selection.slice(separator + 1), protocol,
      protocol === 'anthropic_messages' ? 'api_key' : 'auth_token')
  }
  return { providers, issues: [...issues] }
}

export function publicDiscoveredProviders(settings: Settings, discovered: DiscoveredProvider[]) {
  return discovered.map(item => {
    const existing = Object.entries(settings.model_configurations || {})
      .find(([, configuration]) => configuration.external_source_id === item.sourceId)
    return {
      source_id: item.sourceId,
      product: item.product,
      name: existing?.[1].name || item.configuration.name,
      model: item.configuration.model,
      base_url: item.configuration.base_url,
      weworker_protocol: item.configuration.weworker_protocol,
      imported: Boolean(existing),
      configuration_id: existing?.[0] || '',
    }
  })
}

export function importDiscoveredProviders(settings: Settings, discovered: DiscoveredProvider[], manual = false) {
  const configurations = { ...(settings.model_configurations || {}) }
  const dismissed = new Set(Array.isArray(settings.dismissed_model_sources) ? settings.dismissed_model_sources : [])
  const imported: string[] = []
  let existing = 0
  for (const item of discovered) {
    if (Object.values(configurations).some(configuration => configuration.external_source_id === item.sourceId)) { existing++; continue }
    if (!manual && dismissed.has(item.sourceId)) continue
    const usedNames = new Set(Object.values(configurations).map(configuration => configuration.name))
    let name: string = item.product
    for (let suffix = 2; usedNames.has(name); suffix++) name = `${item.product} (${suffix})`
    const id = `model-discovered-${item.sourceId}`
    if (Object.hasOwn(configurations, id)) { existing++; continue }
    configurations[id] = { ...item.configuration, name }
    dismissed.delete(item.sourceId)
    imported.push(id)
  }
  const updates: Partial<Settings> = imported.length ? {
    model_configurations: configurations, dismissed_model_sources: [...dismissed],
  } : {}
  // Existing working selections always win; only fill an unconfigured setup.
  const ready = imported.find(id => configurations[id].model)
  if (ready && !settings.api_key?.trim()) Object.assign(updates,
    activateModelConfiguration({ ...settings, ...updates }, ready), { onboarding_completed: true })
  return { updates, imported, existing }
}
