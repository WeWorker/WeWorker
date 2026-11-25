import config from '../../model.json' with { type: 'json' }
import type { ProviderEntry } from './llm-egress.js'
import type { Settings } from './config.js'

declare const __BUILD_PROVIDERS__: ProviderEntry[]
declare const __BUILD_MODEL_CONFIG__: boolean
declare const __BUILD_PROVIDER_CREDENTIALS__: Record<string, string>
declare const __BUILD_DEFAULT_PROVIDER__: string

// Build injection honors profile exclusions; source execution uses the same JSON.
const deployedProviders: ProviderEntry[] = typeof __BUILD_MODEL_CONFIG__ !== 'undefined' && __BUILD_MODEL_CONFIG__
  ? __BUILD_PROVIDERS__ : typeof __BUILD_PROVIDERS__ !== 'undefined'
  ? __BUILD_PROVIDERS__ : config.providers.map(({ encryptedApiKey, ...provider }) => provider) as ProviderEntry[]
export const CONFIGURED_PROVIDERS = deployedProviders.map(provider => {
  if (!provider.desktopAccount) return provider
  const port = Number(process.env.WEWORKER_MODEL_ACCOUNT_PORT)
  const baseUrl = Number.isInteger(port) && port > 0 && port <= 65535 ? `http://127.0.0.1:${port}/v1` : ''
  return { ...provider, weworker: { ...provider.weworker, baseUrl }, webwright: { ...provider.webwright, baseUrl } }
})
const credentials: Record<string, string> = typeof __BUILD_MODEL_CONFIG__ !== 'undefined' && __BUILD_MODEL_CONFIG__
  ? __BUILD_PROVIDER_CREDENTIALS__
  : Object.fromEntries(config.providers.filter(p => p.builtin && 'encryptedApiKey' in p).map(p => [p.id, (p as { encryptedApiKey: string }).encryptedApiKey]))
export const configuredEncryptedApiKey = (id: string) => configuredProvider(id)?.builtin ? credentials[id] || '' : ''
export const DEFAULT_PROVIDER = typeof __BUILD_MODEL_CONFIG__ !== 'undefined' && __BUILD_MODEL_CONFIG__
  ? __BUILD_DEFAULT_PROVIDER__ : typeof __BUILD_DEFAULT_PROVIDER__ !== 'undefined'
  ? __BUILD_DEFAULT_PROVIDER__ : config.defaultProvider
export const configuredProvider = (id: string | undefined) => CONFIGURED_PROVIDERS.find(provider => provider.id === id)

export const configuredModel = (id: string, model: string) => {
  const provider = configuredProvider(id)
  return provider?.fixedModel ? provider.defaultModel : model || provider?.defaultModel || ''
}

// Stored account references are scoped to this desktop process before use on loopback.
export function desktopAccountKey(reference: string | undefined): string {
  const nonce = process.env.WEWORKER_MODEL_ACCOUNT_NONCE
  const binding = reference?.split('.').at(-1)
  return nonce && binding ? `${nonce}.${binding}` : ''
}

export function storedModelAccountReferences(settings: Settings): Settings {
  const configs = Object.entries(settings.model_configurations || {})
    .filter(([, value]) => configuredProvider(value.provider_id)?.desktopAccount)
  const active = configuredProvider(settings.active_provider)?.desktopAccount
  if (!configs.length && !active) return settings
  const reference = (key: string | undefined) => key?.split('.').at(-1) || ''
  return { ...settings,
    ...(active ? { api_key: reference(settings.api_key), base_url: '' } : {}),
    ...(configs.length ? { model_configurations: { ...settings.model_configurations,
      ...Object.fromEntries(configs.map(([id, value]) => [id, { ...value,
        api_key: reference(value.api_key), openai_api_key: reference(value.openai_api_key),
        base_url: '', openai_base_url: '' }])) } } : {}),
  }
}

// Preset gateways and authentication follow the current build configuration,
// even when a previous version persisted a different active address.
export function resolveConfiguredSettings(settings: Settings, providers: ProviderEntry[]): Settings {
  const provider = providers.find(p => p.id === settings.active_provider)
  if (!provider) return { ...settings, api_key: '', base_url: '', model: '' }
  if (provider.builtin) return settings // Deployment-only values are resolved separately.
  return {
    ...settings,
    ...(provider.desktopAccount ? { api_key: desktopAccountKey(settings.api_key) } : {}),
    model: provider.fixedModel ? provider.defaultModel : settings.model || provider.defaultModel || '',
    ...(provider.id === 'custom' ? {} : {
      base_url: provider.weworker.baseUrl,
      base_url_is_full: false,
      active_auth_type: provider.authType || 'api_key',
      active_weworker_protocol: provider.weworker.protocol,
    }),
  }
}

// Activating or persisting a preset provider returns the exploration agent to that provider's preset webwright config.
export function explorationResetPatch(provider: string): Partial<Pick<Settings, 'exploration_base_url' | 'exploration_base_url_is_full' | 'exploration_model' | 'exploration_api_key' | 'exploration_use_main_key'>> {
  if (provider === 'custom') return {}
  return {
    exploration_base_url: '',
    exploration_base_url_is_full: false,
    exploration_model: '',
    exploration_api_key: '',
    exploration_use_main_key: true,
  }
}
