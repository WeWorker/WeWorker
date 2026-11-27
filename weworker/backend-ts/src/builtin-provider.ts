import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Settings } from './config.js'
import { createDecipheriv } from 'node:crypto'
import { DEFAULT_BUILTIN_CONTEXT_LIMIT, DEFAULT_CONTEXT_LIMIT, normalizeModelContextLimit, parseContextLimit } from './context-window.js'
import { normalizeLlmBaseUrl, type ProviderEntry } from './llm-egress.js'

import { configuredProvider, configuredEncryptedApiKey, CONFIGURED_PROVIDERS, explorationResetPatch } from './provider-config.js'

// Credential material remains Backend-only; all public metadata comes from JSON.
export const BUILTIN_PROVIDER = configuredProvider('builtin')!
export const BUILTIN_DEV_PROVIDER = configuredProvider('builtin_dev')!
export const BANK_CODING_PROVIDER = configuredProvider('bank_coding')!
export const BUILTIN_PROVIDERS = CONFIGURED_PROVIDERS.filter(provider => provider.builtin)

const EMBEDDED_SECRET_KEY = Buffer.from('33cfebfe2c3549b3de27164524c466c12dd9caac3f2f7fac50cf076b8b5b0b6f', 'hex')

function decryptEmbeddedSecret(payload: string): string {
  const [iv, authTag, encrypted] = payload.split('.')
  if (!iv || !authTag || !encrypted) throw new Error('免费模型配置无效')
  const decipher = createDecipheriv('aes-256-gcm', EMBEDDED_SECRET_KEY, Buffer.from(iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(authTag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8')
}

export function isBuiltinProvider(id: string | undefined): boolean {
  return configuredProvider(id)?.builtin === true
}

// Deployment values are local to the Backend and never part of provider metadata.
function bankCodingDeployment(env: NodeJS.ProcessEnv): { baseUrl: string } {
  let local: Record<string, unknown> = {}
  try {
    const file = env.WEWORKER_PROVIDER_DEPLOYMENTS_FILE || path.join(os.homedir(), '.weworker', 'provider-deployments.json')
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))?.bank_coding
    if (value && typeof value === 'object' && !Array.isArray(value)) local = value
  } catch { /* Unconfigured deployments remain unavailable. */ }
  return {
    baseUrl: (env[configuredProvider('bank_coding')?.baseUrlEnv || ''] || (typeof local.baseUrl === 'string' ? local.baseUrl : '')).trim(),
  }
}

const BUILTIN_NOT_CONFIGURED = '免费模型服务尚未配置，请联系应用提供方或使用其他模型'

type BuiltinWorkshopGateway = ProviderEntry['webwright'] & { baseUrlEnv?: string }

function deploymentValue(env: NodeJS.ProcessEnv, name: string | undefined): string {
  return name ? env[name]?.trim() || '' : ''
}

function validBuiltinBaseUrl(value: string): string {
  try { return value ? normalizeLlmBaseUrl(value) : '' }
  catch { return '' }
}

function getBuiltinRuntimeProvider(provider: ProviderEntry, env: NodeJS.ProcessEnv, hasDeploymentKey: boolean): ProviderEntry {
  if (provider.id !== 'builtin_dev') return provider
  const defaultMain = validBuiltinBaseUrl(provider.weworker.baseUrl)
  const mainOverride = deploymentValue(env, provider.baseUrlEnv)
  const mainBaseUrl = mainOverride ? validBuiltinBaseUrl(mainOverride) : defaultMain
  if (!mainBaseUrl || (mainBaseUrl !== defaultMain && !hasDeploymentKey)) throw new Error(BUILTIN_NOT_CONFIGURED)

  const workshop = provider.webwright as BuiltinWorkshopGateway
  const defaultWorkshop = validBuiltinBaseUrl(workshop.baseUrl)
  const workshopOverride = deploymentValue(env, workshop.baseUrlEnv)
  // A different chat gateway needs an explicit Workshop address.
  const workshopBaseUrl = workshopOverride ? validBuiltinBaseUrl(workshopOverride)
    : mainBaseUrl === defaultMain ? defaultWorkshop : ''
  // Embedded credentials are scoped to the bundled endpoints.
  const canUseWorkshop = workshop.protocol === 'openai_chat_completions'
    && (workshopBaseUrl === defaultWorkshop || hasDeploymentKey)
  return {
    ...provider,
    weworker: { ...provider.weworker, baseUrl: mainBaseUrl },
    webwright: { ...workshop, baseUrl: canUseWorkshop ? workshopBaseUrl : '' },
  }
}

export function getBuiltinApiKey(id: string, env: NodeJS.ProcessEnv = process.env): string {
  const provider = configuredProvider(id)
  if (!provider?.builtin) return ''
  try { return builtinProviderAccess(provider, env).apiKey }
  catch { return '' }
}

export function isBuiltinProviderConfigured(provider: ProviderEntry, env: NodeJS.ProcessEnv = process.env): boolean {
  try { return Boolean(builtinProviderAccess(provider, env).apiKey) }
  catch { return false }
}

export function normalizeBuiltinContextLimits(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).flatMap(([id, limit]) => {
    const parsed = parseContextLimit(limit)
    return parsed === null ? [] : [[id, normalizeModelContextLimit(parsed)]]
  }))
}

export function publicBuiltinProviders(providers: ProviderEntry[], env: NodeJS.ProcessEnv = process.env, contextLimits: Settings['builtin_context_limits'] = {}) {
  return Object.fromEntries(providers.filter(p => isBuiltinProvider(p.id)).map(p => [p.id, {
    has_key: isBuiltinProviderConfigured(p, env),
    model: p.defaultModel,
    context_limit: normalizeModelContextLimit(contextLimits?.[p.id], DEFAULT_BUILTIN_CONTEXT_LIMIT),
    readonly: true,
  }]))
}

export function builtinProviderAccess(provider: ProviderEntry, env: NodeJS.ProcessEnv = process.env) {
  const configured = configuredProvider(provider.id)
  if (!configured?.builtin) throw new Error('不是免费模型')
  const deploymentKey = deploymentValue(env, configured.apiKeyEnv)
  const runtimeProvider = getBuiltinRuntimeProvider(configured, env, Boolean(deploymentKey))
  const encrypted = deploymentKey ? '' : configuredEncryptedApiKey(configured.id)
  const apiKey = deploymentKey || (encrypted ? decryptEmbeddedSecret(encrypted) : '')
  if (!apiKey) throw new Error(BUILTIN_NOT_CONFIGURED)
  return {
    provider: runtimeProvider,
    apiKey,
    model: runtimeProvider.defaultModel,
    anthropicBaseUrl: runtimeProvider.weworker.baseUrl,
    openaiBaseUrl: runtimeProvider.webwright.baseUrl,
    anthropicAuthType: runtimeProvider.authType || 'api_key' as const,
  }
}

export function activateBuiltinProvider(provider: ProviderEntry, env: NodeJS.ProcessEnv = process.env): Partial<Settings> {
  const access = builtinProviderAccess(provider, env)
  return {
    active_provider: access.provider.id,
    active_model_configuration: '',
    active_auth_type: access.anthropicAuthType,
    active_weworker_protocol: access.provider.weworker.protocol,
    // Only the selection is persisted. The deployment credential stays in memory.
    api_key: '',
    base_url: '',
    base_url_is_full: false,
    model: access.provider.defaultModel,
    context_limit: DEFAULT_BUILTIN_CONTEXT_LIMIT,
    ...explorationResetPatch(access.provider.id),
  }
}

export function resolveBuiltinSettings(settings: Settings, providers: ProviderEntry[], env: NodeJS.ProcessEnv = process.env): Settings {
  if (!isBuiltinProvider(settings.active_provider)) return settings
  const provider = providers.find(p => p.id === settings.active_provider)
  let access: ReturnType<typeof builtinProviderAccess> | undefined
  try {
    if (provider) access = builtinProviderAccess(provider, env)
  } catch {
    access = undefined
  }
  return {
    ...settings,
    // Never reuse a stale saved key or address, especially when a profile excludes the provider.
    api_key: access?.apiKey || '',
    base_url: access?.provider.weworker.baseUrl || '',
    base_url_is_full: false,
    model: access?.provider.defaultModel || '',
    active_auth_type: access?.anthropicAuthType || settings.active_auth_type,
    active_weworker_protocol: access?.provider.weworker.protocol || 'anthropic_messages',
    context_limit: normalizeModelContextLimit(settings.builtin_context_limits?.[settings.active_provider], DEFAULT_BUILTIN_CONTEXT_LIMIT),
  }
}

// The deployment supplies only the gateway address. User keys follow normal settings storage.
export function resolveBankCodingProvider(provider: ProviderEntry, env: NodeJS.ProcessEnv = process.env): ProviderEntry {
  if (provider.id !== 'bank_coding') return provider
  // Explicit JSON gateways take precedence over the legacy local deployment file.
  if (provider.weworker.baseUrl && !(env[provider.baseUrlEnv || ''] || '').trim()) return provider
  const baseUrl = bankCodingDeployment(env).baseUrl
  if (!baseUrl) return provider
  const normalized = normalizeLlmBaseUrl(baseUrl)
  const workshopBaseUrl = provider.webwright.protocol === 'openai_chat_completions' && !/\/v1$/i.test(normalized)
    ? `${normalized}/v1` : normalized
  return { ...provider, weworker: { ...provider.weworker, baseUrl: normalized }, webwright: { ...provider.webwright, baseUrl: workshopBaseUrl } }
}

export function resolveBankCodingSettings(settings: Settings, providers: ProviderEntry[], env: NodeJS.ProcessEnv = process.env): Settings {
  if (settings.active_provider !== 'bank_coding' || settings.active_model_configuration) return settings
  const provider = providers.find(p => p.id === 'bank_coding')
  return {
    ...settings,
    api_key: provider ? settings.api_key_bank_coding || '' : '',
    model: provider ? (provider.fixedModel ? provider.defaultModel : settings.model_bank_coding || provider.defaultModel || '') : '',
    base_url: provider ? resolveBankCodingProvider(provider, env).weworker.baseUrl : '',
    active_auth_type: provider?.authType || 'auth_token',
    base_url_is_full: false,
    context_limit: settings.context_limit_bank_coding || DEFAULT_CONTEXT_LIMIT,
  }
}
