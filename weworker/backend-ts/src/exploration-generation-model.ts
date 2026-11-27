import type { Settings } from './config.js'
import { explorationProviderId, parseConversationModel, type ConversationModel } from './conversation-models.js'
import { explorationConversationSettings } from './exploration-model-settings.js'
import { defaultWebwrightModelSelection, resolveWebwrightModelConfig } from './webwright-model-config.js'

export type WorkshopModelReference = Pick<ConversationModel, 'provider' | 'model' | 'selection_revision'>

const generationRuntime = Symbol('generationRuntime')
export function isGenerationModelSettings(settings: Settings): boolean {
  return generationRuntime in settings
}

export function workshopModelReference(input: unknown): WorkshopModelReference {
  const { provider, model, selection_revision } = parseConversationModel(input)
  return { provider, model, ...(selection_revision === undefined ? {} : { selection_revision }) }
}

function workshopConfig(settings: Settings, reference?: WorkshopModelReference) {
  try {
    return resolveWebwrightModelConfig(settings, reference)
  } catch {
    throw new Error('Adapter 工坊模型不可用，请在设置 → 模型中检查对应的 OpenAI 接口配置')
  }
}

/** Apply the source exploration's selection revision at handoff, then pin its effective model. */
export function selectGenerationModel(settings: Settings, sourceSelection: unknown): WorkshopModelReference {
  const source = explorationConversationSettings(settings, sourceSelection)
  const selection = defaultWebwrightModelSelection(source)
  const provider = selection.provider === '__exploration__' || selection.provider.startsWith('__exploration__:')
    ? explorationProviderId(source, selection) : selection.provider
  return workshopModelReference({ ...selection, provider, model: workshopConfig(source).model })
}

/** Resolve current credentials for the pinned reference. Legacy works use the current Workshop default. */
export function resolveGenerationModelSettings(settings: Settings, reference?: WorkshopModelReference): Settings {
  const config = workshopConfig(settings, reference)
  const runtime = {
    ...settings,
    [generationRuntime]: true,
    active_provider: config.provider_id,
    active_model_configuration: '',
    active_weworker_protocol: config.protocol,
    active_auth_type: config.auth_type,
    model: config.model,
    api_key: config.api_key,
    base_url: config.base_url,
    base_url_is_full: config.base_url_is_full,
    context_limit: config.context_limit,
    compaction_ratio: config.compaction_ratio,
    compaction_max_attempts: config.compaction_max_attempts,
    exploration_thinking_effort: config.thinking_effort === 'xhigh' || config.thinking_effort === 'max' ? 'high' : config.thinking_effort,
  } satisfies Settings & { [generationRuntime]: true }
  return runtime
}
