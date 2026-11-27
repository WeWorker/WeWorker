import config from '../../model.json' with { type: 'json' }

declare const __BUILD_ANTHROPIC_BASE_URL__: string
export const DEFAULT_ANTHROPIC_BASE_URL = typeof __BUILD_ANTHROPIC_BASE_URL__ !== 'undefined'
  ? __BUILD_ANTHROPIC_BASE_URL__ : config.endpointDefaults.anthropic
