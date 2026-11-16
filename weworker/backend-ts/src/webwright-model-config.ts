import { timingSafeEqual } from 'node:crypto'
import type { Settings } from './config.js'
import { normalizeLlmUrlInput } from './llm-egress.js'
import { normalizeCompactionMaxAttempts, normalizeCompactionRatio } from './context/conversation-compaction.js'
import { defaultConversationModel, resolveConversationModelSettings } from './conversation-models.js'
import { findProviderByWeWorkerBaseUrl } from './provider-registry.js'
import { usesAnthropicBearerToken } from './anthropic-auth.js'
export { explorationResetPatch } from './provider-config.js'

export function isAuthorizedModelConfigRequest(authorization: string | undefined, expectedToken: string): boolean {
  const actual = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
  if (!actual || !expectedToken) return false
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expectedToken)
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
}

// Resolve the same connection as normal chat. Legacy exploration/openai_* fields
// remain stored for compatibility but no longer override this interface.
function selectedExplorationSettings(settings: Settings): Settings {
  return resolveConversationModelSettings(settings, settings.exploration_model_selection || defaultConversationModel(settings))
}

export function resolveWebwrightModelConfig(saved: Settings) {
  const settings = selectedExplorationSettings(saved)
  if (!settings.api_key || !settings.model) throw new Error('请先配置对话接口的 API Key 和模型')
  if (!settings.base_url) throw new Error('请填写对话接口地址')
  const protocol = settings.active_weworker_protocol || 'anthropic_messages'
  const authProvider = settings.active_provider === 'custom'
    ? findProviderByWeWorkerBaseUrl(settings.base_url)?.id || settings.active_provider : settings.active_provider
  const modelClass = protocol === 'anthropic_messages' ? 'anthropic'
    : protocol === 'openai_responses' ? 'openai' : 'openai_chat'
  const structuredOutput = protocol === 'anthropic_messages' ? 'anthropic_json_schema'
    : protocol === 'openai_responses' ? 'openai_json_schema' : 'openai_json_object'
  return {
    provider_id: settings.active_provider,
    protocol,
    model_class: modelClass,
    base_url: normalizeLlmUrlInput(settings.base_url, settings.base_url_is_full === true),
    ...(settings.base_url_is_full ? { base_url_is_full: true } : {}),
    auth_type: protocol === 'anthropic_messages'
      ? usesAnthropicBearerToken(authProvider, settings.active_auth_type) ? 'auth_token' : 'api_key'
      : settings.active_auth_type || 'api_key',
    model: settings.model,
    api_key: settings.api_key,
    structured_output: structuredOutput,
    context_limit: settings.context_limit,
    compaction_ratio: normalizeCompactionRatio(settings.compaction_ratio),
    compaction_max_attempts: normalizeCompactionMaxAttempts(settings.compaction_max_attempts),
    thinking_effort: settings.exploration_thinking_effort || 'off',
  } as const
}
