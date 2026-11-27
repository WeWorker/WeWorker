import config from '../../../model.json' with { type: 'json' }

export const BUILD_PROVIDERS = typeof __BUILD_PROVIDERS__ !== 'undefined'
  ? __BUILD_PROVIDERS__ : config.providers.map(({ encryptedApiKey, ...provider }) => provider)
export const BUILD_DEFAULT_PROVIDER = typeof __BUILD_DEFAULT_PROVIDER__ !== 'undefined'
  ? __BUILD_DEFAULT_PROVIDER__ : config.defaultProvider
export const DEFAULT_ANTHROPIC_BASE_URL = config.endpointDefaults.anthropic
export const configuredProvider = id => BUILD_PROVIDERS.find(provider => provider.id === id)
export const isBuiltinProvider = id => configuredProvider(id)?.builtin === true
export const hasFixedModel = id => configuredProvider(id)?.fixedModel === true
export const isFixedProvider = id => configuredProvider(id)?.fixed === true
