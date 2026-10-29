import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Settings } from './config.js'
import { createDecipheriv } from 'node:crypto'
import { DEFAULT_CONTEXT_LIMIT } from './context-window.js'
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
  if (!iv || !authTag || !encrypted) throw new Error('内置模型配置无效')
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

export function getBuiltinApiKey(id: string, env: NodeJS.ProcessEnv = process.env): string {
  const provider = configuredProvider(id)
  if (!provider?.builtin) return ''
  const variable = provider.apiKeyEnv
  const override = variable ? (env[variable] || '').trim() : ''
  if (override) return override
  const encrypted = configuredEncryptedApiKey(id)
  return encrypted ? decryptEmbeddedSecret(encrypted) : ''
}

function getBuiltinRuntimeProvider(provider: ProviderEntry, env: NodeJS.ProcessEnv = process.env): ProviderEntry {
  if (provider.id !== 'builtin_dev') return provider
  const baseUrl = (env[provider.baseUrlEnv || ''] || provider.weworker.baseUrl || '').trim()
  if (!baseUrl) throw new Error('内置模型服务尚未配置，请联系应用提供方或使用其他模型')
  const normalized = normalizeLlmBaseUrl(baseUrl)
  return {
    ...provider,
    weworker: { ...provider.weworker, baseUrl: normalized },
    webwright: { ...provider.webwright, baseUrl: env[provider.baseUrlEnv || ''] ? normalized : provider.webwright.baseUrl || normalized },
  }
}

export function isBuiltinProviderConfigured(provider: ProviderEntry, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    if (!getBuiltinApiKey(provider.id, env)) return false
    getBuiltinRuntimeProvider(provider, env)
    return true
  } catch {
    return false
  }
}

export function publicBuiltinProviders(providers: ProviderEntry[], env: NodeJS.ProcessEnv = process.env) {
  return Object.fromEntries(providers.filter(p => isBuiltinProvider(p.id)).map(p => [p.id, {
    has_key: isBuiltinProviderConfigured(p, env),
    model: p.defaultModel,
    context_limit: DEFAULT_CONTEXT_LIMIT,
    readonly: true,
  }]))
}

export function builtinProviderAccess(provider: ProviderEntry, env: NodeJS.ProcessEnv = process.env) {
  if (!isBuiltinProvider(provider.id)) throw new Error('不是内置模型')
  const apiKey = getBuiltinApiKey(provider.id, env)
  if (!apiKey) throw new Error('内置模型服务尚未配置，请联系应用提供方或使用其他模型')
  const runtimeProvider = getBuiltinRuntimeProvider(provider, env)
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
    // Only the selection is persisted. The deployment credential stays in memory.
    api_key: '',
    base_url: '',
    base_url_is_full: false,
    model: access.provider.defaultModel,
    context_limit: DEFAULT_CONTEXT_LIMIT,
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
    context_limit: DEFAULT_CONTEXT_LIMIT,
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
  return { ...provider, weworker: { ...provider.weworker, baseUrl: normalized }, webwright: { ...provider.webwright, baseUrl: normalized } }
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
