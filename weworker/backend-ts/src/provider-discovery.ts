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
import { discoverHarnessProviders } from './harness-provider-discovery.js'

type RecordValue = Record<string, any>
type Product = 'Claude Code' | 'Codex' | 'WorkBuddy' | 'CodeBuddy' | 'OpenCode' | 'DeepSeek Harness'
export interface ProviderValidation {
  ok: boolean
  reason: '' | 'format' | 'auth' | 'unreachable' | 'unsupported'
  detail: string
}
export interface DiscoveredProvider {
  sourceId: string
  legacySourceIds?: string[]
  product: Product
  configuration: ModelConfiguration
  validation?: ProviderValidation
}
export interface DiscoveryOptions {
  home?: string
  env?: NodeJS.ProcessEnv
  /** 校验格式与连通性；测试里可以关掉，避免真实网络请求。 */
  validate?: boolean
  fetchImpl?: typeof fetch
  validateTimeoutMs?: number
}
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : ''

/** 只做格式判断：可打印 ASCII、无空白、长度合理。 */
export function looksLikeApiKey(key: string): boolean {
  return /^[\x21-\x7e]{8,512}$/.test(String(key || '')) && !/\s/.test(String(key || ''))
}

/**
 * 连通性校验：用模型列表接口做一次轻量探测。
 * 401/403 视为 key 无效；其它失败视为不可达；200 视为可用。
 */
export async function validateProviderConnection(
  configuration: Pick<ModelConfiguration, 'api_key' | 'base_url' | 'weworker_protocol'>,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 6000,
): Promise<ProviderValidation> {
  if (!looksLikeApiKey(configuration.api_key)) {
    return { ok: false, reason: 'format', detail: 'API Key 格式不合法（需为 8-512 个非空白可见字符）' }
  }
  const anthropic = configuration.weworker_protocol === 'anthropic_messages'
  const url = anthropic
    ? `${configuration.base_url.replace(/\/+$/, '')}/v1/models?limit=1`
    : `${configuration.base_url.replace(/\/+$/, '')}/models`
  const headers: Record<string, string> = anthropic
    ? { 'x-api-key': configuration.api_key, 'anthropic-version': '2023-06-01' }
    : { authorization: `Bearer ${configuration.api_key}` }
  try {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    if (response.ok) return { ok: true, reason: '', detail: '' }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'auth', detail: `鉴权失败（HTTP ${response.status}），该 Key 无法调用此接口` }
    }
    if (response.status === 404 || response.status === 405) {
      // 有些网关不提供模型列表接口，不能据此判定 key 无效。
      return { ok: true, reason: '', detail: '' }
    }
    return { ok: false, reason: 'unsupported', detail: `接口返回 HTTP ${response.status}` }
  } catch (error) {
    return { ok: false, reason: 'unreachable', detail: `无法连接接口：${error instanceof Error ? error.message : String(error)}` }
  }
}

// Connection identity excludes the app and model. Only a digest is exposed.
function connectionId(configuration: ModelConfiguration): string {
  const protocol = configuration.weworker_protocol || 'anthropic_messages'
  const suffix = protocol === 'anthropic_messages' ? '/v1/messages'
    : protocol === 'openai_responses' ? '/responses' : '/chat/completions'
  const endpoint = new URL(configuration.base_url_is_full ? configuration.base_url
    : configuration.base_url.replace(/\/+$/, '') + suffix)
  const auth = protocol === 'anthropic_messages' ? configuration.auth_type : 'bearer'
  return createHash('sha256').update(JSON.stringify([
    endpoint.href.replace(/\/+$/, ''), configuration.api_key, protocol, auth,
  ])).digest('hex').slice(0, 24)
}

function sourceIds(item: DiscoveredProvider): string[] {
  return [item.sourceId, ...(item.legacySourceIds || [])]
}

function matchesSource(configuration: ModelConfiguration, item: DiscoveredProvider): boolean {
  return configuration.external_source_id === item.sourceId ||
    Boolean(item.legacySourceIds?.includes(configuration.external_source_id || '') && sameConnection(configuration, item))
}

function sameConnection(configuration: ModelConfiguration, item: DiscoveredProvider): boolean {
  try { return connectionId(configuration) === connectionId(item.configuration) } catch { return false }
}

function groupedProviders(providers: DiscoveredProvider[]): DiscoveredProvider[] {
  const groups = new Map<string, DiscoveredProvider>()
  for (const item of providers) {
    const id = connectionId(item.configuration)
    const group = groups.get(id)
    if (group) {
      group.legacySourceIds!.push(item.sourceId)
      group.configuration.custom_models = [...new Set([
        ...group.configuration.custom_models!, item.configuration.model,
      ].filter(Boolean))]
      if (!group.configuration.model) group.configuration.model = item.configuration.model
    } else groups.set(id, { ...item, sourceId: id, legacySourceIds: [item.sourceId], configuration: {
      ...item.configuration, external_source_id: id,
      custom_models: item.configuration.model ? [item.configuration.model] : [],
    } })
  }
  return [...groups.values()]
}

// Preserve renamed configurations and any differing user settings.
function canFold(a: ModelConfiguration, b: ModelConfiguration): boolean {
  const generated = (c: ModelConfiguration) => Boolean(c.external_product) &&
    (c.name === c.external_product || (c.name || '').startsWith(c.external_product!) &&
      /^ \(\d+\)$/.test((c.name || '').slice(c.external_product!.length)))
  const comparable = (c: ModelConfiguration) => Object.fromEntries(Object.entries(c)
    .filter(([key]) => !['name', 'model', 'custom_models', 'external_source_id', 'external_product'].includes(key))
    .sort(([a], [b]) => a.localeCompare(b)))
  return generated(a) && generated(b) && JSON.stringify(comparable(a)) === JSON.stringify(comparable(b))
}

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
  const harness = await discoverHarnessProviders(home, env)
  if (harness.issue) issues.add('DeepSeek Harness')
  for (const item of harness.providers) add('DeepSeek Harness', item.slot, item.key, item.url, item.model,
    item.protocol, item.protocol === 'anthropic_messages' ? 'api_key' : 'auth_token')

  const grouped = groupedProviders(providers)
  // Probe once per connection, not once per model.
  // 校验不通过也保留在列表里（带原因），但导入时会被拒绝。
  if (options.validate !== false && providers.length > 0) {
    const fetchImpl = options.fetchImpl ?? fetch
    const timeoutMs = options.validateTimeoutMs ?? 6000
    await Promise.all(grouped.map(async (item) => {
      item.validation = await validateProviderConnection(item.configuration, fetchImpl, timeoutMs)
    }))
  }
  return { providers: grouped, issues: [...issues] }
}

export function publicDiscoveredProviders(settings: Settings, discovered: DiscoveredProvider[]) {
  return discovered.map(item => {
    const existing = Object.entries(settings.model_configurations || {})
      .find(([, configuration]) => matchesSource(configuration, item) || sameConnection(configuration, item))
    return {
      source_id: item.sourceId,
      product: item.product,
      name: existing?.[1].name || item.configuration.name,
      model: item.configuration.model,
      models: item.configuration.custom_models || [],
      base_url: item.configuration.base_url,
      weworker_protocol: item.configuration.weworker_protocol,
      imported: Boolean(existing),
      configuration_id: existing?.[0] || '',
      api_key_hint: item.configuration.api_key ? item.configuration.api_key.slice(-4) : '',
      validation: item.validation ?? { ok: true, reason: '' as const, detail: '' },
    }
  })
}

export function importDiscoveredProviders(settings: Settings, discovered: DiscoveredProvider[], manual = false) {
  const configurations = { ...(settings.model_configurations || {}) }
  const dismissed = new Set(Array.isArray(settings.dismissed_model_sources) ? settings.dismissed_model_sources : [])
  const imported: string[] = []
  let existing = 0
  let merged = 0
  let updated = 0
  let changed = false
  for (const item of discovered) {
    // 自动导入只接受校验通过的来源；用户手动导入则由用户决定（列表里仍然展示）。
    if (!manual && item.validation && !item.validation.ok) continue
    const matches = Object.entries(configurations).filter(([, configuration]) =>
      matchesSource(configuration, item) || sameConnection(configuration, item))
    const match = matches.find(([id]) => id === settings.active_model_configuration) || matches[0]
    if (match) {
      existing++
      const [id, saved] = match
      // An edited source is preserved; do not add models from its former route.
      if (!sameConnection(saved, item)) continue
      const models = new Set([...(saved.custom_models || []), saved.model,
        ...(item.configuration.custom_models || []), item.configuration.model].filter(Boolean))
      for (const [otherId, other] of matches) {
        if (otherId === id || !other.external_source_id || !canFold(saved, other)) continue
        for (const model of [...(other.custom_models || []), other.model].filter(Boolean)) models.add(model)
        delete configurations[otherId]
        merged++
        changed = true
      }
      const next = { ...saved, custom_models: [...models],
        ...(saved.external_source_id ? { external_source_id: item.sourceId } : {}),
      }
      if (JSON.stringify(next) !== JSON.stringify(saved)) {
        configurations[id] = next
        updated++
        changed = true
      }
      continue
    }
    if (!manual && sourceIds(item).some(id => dismissed.has(id))) continue
    const usedNames = new Set(Object.values(configurations).map(configuration => configuration.name))
    let name: string = item.product
    for (let suffix = 2; usedNames.has(name); suffix++) name = `${item.product} (${suffix})`
    const id = `model-discovered-${item.sourceId}`
    if (Object.hasOwn(configurations, id)) { existing++; continue }
    configurations[id] = { ...item.configuration, name,
      custom_models: [...new Set([...(item.configuration.custom_models || []), item.configuration.model].filter(Boolean))],
    }
    for (const sourceId of sourceIds(item)) dismissed.delete(sourceId)
    imported.push(id)
  }
  const updates: Partial<Settings> = imported.length || changed ? {
    model_configurations: configurations, dismissed_model_sources: [...dismissed],
  } : {}
  // Existing working selections always win; only fill an unconfigured setup.
  const ready = imported.find(id => configurations[id].model)
  if (ready && !settings.api_key?.trim()) Object.assign(updates,
    activateModelConfiguration({ ...settings, ...updates }, ready), { onboarding_completed: true })
  return { updates, imported, existing, merged, updated }
}
