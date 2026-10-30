import { DEFAULT_PROVIDER, configuredProvider, resolveConfiguredSettings } from './provider-config.js'
import { migrateChannelConfigurations, type ChannelConfigurations, type ChannelType } from './channels/channel-configurations.js'
import { resolveBuiltinSettings, resolveBankCodingSettings } from './builtin-provider.js'
import { PROVIDERS } from './provider-registry.js'
import fs from 'node:fs'

import path from 'node:path'

import os from 'node:os'
import {
  DEFAULT_RESOURCE_PREVIEW_EXTENSIONS,
  getEffectivePreviewExtensions,
  getPreviewExtensionSet,
  normalizePreviewExtensions,
} from './resource-preview-extensions.js'

import { createLogger } from './logger.js'

import {

  applySecrets,

  clearSecretsOnDisk,

  collectPlaintextSecretsFromRaw,

  extractSecrets,

  rawFileHasPlaintextSecrets,

} from './settings-secrets.js'

import {

  decryptSecrets,

  encryptSecrets,

  initSecretStore,

  isSecretStoreReady,

} from './secret-store.js'

import {

  DEFAULT_DOWNLOAD_SUBDIRECTORY,

  normalizeDownloadSubdirectory,

  resolveDownloadDirectory,

} from './download-directory.js'

import {
  normalizeUserDirectoryBlacklist,
  countInvalidBlacklistEntries,
  type UserDirectoryBlacklistEntry,
} from './user-directory-blacklist.js'
import {
  DEFAULT_STYLE_ID,
  normalizeCustomStyles,
  normalizeDefaultStyleId,
  normalizeEnabledStyles,
  stripObsoleteZcfSettings,
  type CustomStyle,
} from './style-settings.js'
import { DEFAULT_CONTEXT_LIMIT, normalizeContextLimit } from './context-window.js'
import { normalizeAddedProviders } from './provider-visibility.js'



const log = createLogger('config')



const CONFIG_DIR = path.join(os.homedir(), '.weworker')

const DEFAULT_USER_DIRECTORY = path.join(CONFIG_DIR, 'projects')

const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json')

const DEFAULT_MAX_CHAT_ATTACHMENTS = 60

const MIN_CHAT_ATTACHMENTS = 1

const MAX_CHAT_ATTACHMENTS = 200
const DEFAULT_PASTE_TEXT_ATTACHMENT_THRESHOLD = 20000
const MIN_PASTE_TEXT_ATTACHMENT_THRESHOLD = 1000
const MAX_PASTE_TEXT_ATTACHMENT_THRESHOLD = 200000
const DEFAULT_WELCOME_FEATURED_SITE_LIMIT = 50
const MIN_WELCOME_FEATURED_SITE_LIMIT = 1
const MAX_WELCOME_FEATURED_SITE_LIMIT = 50



export interface QQChannelConfig {

  enabled: boolean

  app_id: string

  app_secret: string

  owner_user_id: string

  owner_permission_level: OwnerPermissionLevel

}



export type OwnerPermissionLevel = 'qa_only' | 'no_bash' | 'full'



export interface WeixinChannelConfig {

  enabled: boolean

  token: string       // bot_token from QR login

  base_url: string    // iLink API base URL

  owner_user_id: string

  owner_permission_level: OwnerPermissionLevel

}



export interface WecomChannelConfig {

  enabled: boolean

  bot_id: string

  secret: string

  owner_user_id: string

  owner_permission_level: OwnerPermissionLevel

}

export interface FeishuChannelConfig {

  enabled: boolean

  app_id: string

  app_secret: string

  owner_user_id: string

  owner_permission_level: OwnerPermissionLevel

}



export interface ChannelsConfig {

  qq: QQChannelConfig

  weixin: WeixinChannelConfig

  wecom: WecomChannelConfig

  feishu: FeishuChannelConfig

}



/** 长期记忆按档位的 token 预算；`extension` 覆盖所有 `extension:*` 记录。 */
export interface MemoryBudgets {
  user_usage: number
  task_execution: number
  other: number
  extension: number
}

export const DEFAULT_MEMORY_BUDGETS: MemoryBudgets = {
  user_usage: 800,
  task_execution: 1600,
  other: 1200,
  extension: 800,
}

/** 单档位预算上限；超过上限的输入回退默认值而不是截断。 */
export const MAX_MEMORY_BUDGET = 20_000

export const DEFAULT_SCHEDULED_TASK_HISTORY_LIMIT = 50
export const MIN_SCHEDULED_TASK_HISTORY_LIMIT = 1
export const MAX_SCHEDULED_TASK_HISTORY_LIMIT = 500

export function normalizeScheduledTaskHistoryLimit(value: unknown): number {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : Number.NaN
  if (!Number.isFinite(numeric)) return DEFAULT_SCHEDULED_TASK_HISTORY_LIMIT
  const limit = Math.floor(numeric)
  if (limit < MIN_SCHEDULED_TASK_HISTORY_LIMIT || limit > MAX_SCHEDULED_TASK_HISTORY_LIMIT) {
    return DEFAULT_SCHEDULED_TASK_HISTORY_LIMIT
  }
  return limit
}

/**
 * 规范化记忆预算：缺失、非数字、负数或超过上限的档位回退默认值。
 * 0 是合法值（表示该档位压缩到最少保留 1 条）。
 */
export function normalizeMemoryBudgets(value: unknown): MemoryBudgets {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const normalize = (raw: unknown, fallback: number): number => {
    const numeric = typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim()
        ? Number(raw)
        : Number.NaN
    if (!Number.isFinite(numeric)) return fallback
    const budget = Math.floor(numeric)
    if (budget < 0 || budget > MAX_MEMORY_BUDGET) return fallback
    return budget
  }
  return {
    user_usage: normalize(record.user_usage, DEFAULT_MEMORY_BUDGETS.user_usage),
    task_execution: normalize(record.task_execution, DEFAULT_MEMORY_BUDGETS.task_execution),
    other: normalize(record.other, DEFAULT_MEMORY_BUDGETS.other),
    extension: normalize(record.extension, DEFAULT_MEMORY_BUDGETS.extension),
  }
}

export interface Settings {

  // Whether the first-run model/API key setup has been completed.
  onboarding_completed: boolean

  // Active provider (which one is currently in use)

  active_provider: string

  // Active key/url/model (derived from active provider, used by agent)

  api_key: string

  base_url: string
  base_url_is_full?: boolean

  model: string

  context_limit: number

  // Per-provider stored configs

  api_key_anthropic: string

  model_anthropic: string

  context_limit_anthropic: number

  api_key_glm: string

  api_key_bank_coding?: string
  context_limit_bank_coding?: number
  model_bank_coding?: string
  model_glm: string

  context_limit_glm: number

  api_key_deepseek: string

  model_deepseek: string

  context_limit_deepseek: number

  api_key_custom: string
  openai_api_key_custom: string

  model_custom: string
  openai_model_custom: string

  context_limit_custom: number

  base_url_custom: string
  models_url_custom?: string
  models_url_is_full_custom?: boolean
  models_auth_type_custom?: import('./model-catalog-config.js').ModelCatalogAuthType
  openai_models_url_custom?: string
  openai_models_url_is_full_custom?: boolean
  base_url_is_full_custom?: boolean

  openai_base_url_custom: string
  openai_base_url_is_full_custom?: boolean

  exploration_base_url: string
  exploration_base_url_is_full?: boolean
  exploration_api_key: string
  exploration_model: string
  exploration_use_main_key: boolean

  custom_auth_type: import('./anthropic-auth.js').AnthropicAuthType

  // Provider ids (non-builtin) explicitly added by the user through settings.
  // Providers absent from this list stay hidden unless legacy config exists.
  added_providers: string[]

  model_configurations?: Record<string, import('./model-configurations.js').ModelConfiguration>
  model_configuration_names?: Record<string, string>
  active_model_configuration?: string
  active_auth_type?: import('./anthropic-auth.js').AnthropicAuthType
  active_weworker_protocol?: import('./llm-egress.js').LlmProtocol
  weworker_protocol_custom?: import('./llm-egress.js').LlmProtocol

  channel_configurations?: ChannelConfigurations
  active_channel_configurations?: Partial<Record<ChannelType, string>>
  channels: ChannelsConfig

  // Per-site tool enable/disable toggles (adapter id → state)

  // Missing keys default to true (enabled + visible)

  // true = enabled + visible, 'hidden' = enabled but not shown on welcome page, false = fully disabled

  site_toggles: Record<string, boolean | 'hidden'>

  // Per-site custom test prompts (adapter id → string[])

  // null = use registry defaults; string[] = user-managed (fully overrides registry)

  custom_test_prompts: Record<string, string[] | null>

  // Label color → custom name mapping

  label_names: Record<string, string>

  user_directory: string

  download_directory: string

  max_chat_attachments: number
  paste_text_attachment_threshold: number
  welcome_featured_site_limit: number
  // null = built-in defaults; non-null array replaces defaults entirely
  resource_preview_extensions: string[] | null
  user_directory_blacklist: UserDirectoryBlacklistEntry[]
  open_browser_allowed_origins: string[]

  /** P2 API 查询路由的 LLM 分类层开关（默认开；env WEWORKER_LLM_ROUTE=1|0 可覆盖）。 */
  api_query_llm_route: boolean

  /**
   * 当前生效的风格 id（默认 / 预定义内置风格 / 自定义风格）。
   * 键名沿用历史字段以避免数据迁移；与 ZCF 已无关系。
   */
  zcf_default_role: string

  /** 生效的风格 id 列表（风格互斥，恒为 1 项）；随 zcf_default_role 一起维护 */
  zcf_enabled_roles: string[]

  /** User-defined styles (id, label, prompt)；键名沿用历史字段以避免数据迁移 */
  zcf_custom_roles: CustomStyle[]

  /** 长期记忆按档位的估算 token 预算（extension 覆盖所有 extension:*）。 */
  memory_budgets: MemoryBudgets

  /** 保留在定时任务项目中的普通执行对话数量。 */
  scheduled_task_history_limit: number
}



interface EncryptedSettingsBlob {

  v: 1

  fields: Record<string, string>

}



const DEFAULTS: Settings = {

  onboarding_completed: false,

  active_provider: DEFAULT_PROVIDER,

  api_key: '',

  base_url: configuredProvider(DEFAULT_PROVIDER)?.weworker.baseUrl || '',

  // 模型名是供应商侧的数据（随时会改名或上下架），构建期不写死默认值；
  // 激活供应商时以模型列表接口返回为准，取不到则由用户在模型下拉中手填。
  model: configuredProvider(DEFAULT_PROVIDER)?.defaultModel || '',

  context_limit: DEFAULT_CONTEXT_LIMIT,

  api_key_anthropic: '',

  model_anthropic: '',

  context_limit_anthropic: DEFAULT_CONTEXT_LIMIT,

  api_key_bank_coding: '',
  model_bank_coding: '',
  context_limit_bank_coding: DEFAULT_CONTEXT_LIMIT,
  api_key_glm: '',

  model_glm: '',

  context_limit_glm: DEFAULT_CONTEXT_LIMIT,

  api_key_deepseek: '',

  model_deepseek: '',

  context_limit_deepseek: DEFAULT_CONTEXT_LIMIT,

  api_key_custom: '',
  openai_api_key_custom: '',

  model_custom: '',
  openai_model_custom: '',

  context_limit_custom: DEFAULT_CONTEXT_LIMIT,

  base_url_custom: '',
  weworker_protocol_custom: 'anthropic_messages',
  models_url_custom: '',
  models_auth_type_custom: 'inherit',
  openai_models_url_custom: '',
  base_url_is_full_custom: false,

  api_query_llm_route: true,

  openai_base_url_custom: '',
  openai_base_url_is_full_custom: false,

  exploration_base_url: '',
  exploration_base_url_is_full: false,
  exploration_api_key: '',
  exploration_model: '',
  exploration_use_main_key: true,

  custom_auth_type: 'auth_token',

  added_providers: [] as string[],

  channels: {

    qq: { enabled: false, app_id: '', app_secret: '', owner_user_id: '', owner_permission_level: 'qa_only' },

    weixin: { enabled: false, token: '', base_url: '', owner_user_id: '', owner_permission_level: 'qa_only' },

    wecom: { enabled: false, bot_id: '', secret: '', owner_user_id: '', owner_permission_level: 'qa_only' },

    feishu: { enabled: false, app_id: '', app_secret: '', owner_user_id: '', owner_permission_level: 'qa_only' },

  },

  site_toggles: {},

  custom_test_prompts: {},

  label_names: {},

  user_directory: DEFAULT_USER_DIRECTORY,

  download_directory: DEFAULT_DOWNLOAD_SUBDIRECTORY,

  max_chat_attachments: DEFAULT_MAX_CHAT_ATTACHMENTS,
  paste_text_attachment_threshold: DEFAULT_PASTE_TEXT_ATTACHMENT_THRESHOLD,
  welcome_featured_site_limit: DEFAULT_WELCOME_FEATURED_SITE_LIMIT,
  resource_preview_extensions: null,
  user_directory_blacklist: [],
  open_browser_allowed_origins: [],

  zcf_default_role: DEFAULT_STYLE_ID,

  zcf_enabled_roles: [DEFAULT_STYLE_ID],

  zcf_custom_roles: [],
  memory_budgets: { ...DEFAULT_MEMORY_BUDGETS },
  scheduled_task_history_limit: DEFAULT_SCHEDULED_TASK_HISTORY_LIMIT,
}



let _settings: Settings | null = null

let _settingsInitialized = false



function cloneDefaults(): Settings {

  return {

    ...DEFAULTS,

    channels: {

      qq: { ...DEFAULTS.channels.qq },

      weixin: { ...DEFAULTS.channels.weixin },

      wecom: { ...DEFAULTS.channels.wecom },

      feishu: { ...DEFAULTS.channels.feishu },

    },

    site_toggles: { ...DEFAULTS.site_toggles },

    custom_test_prompts: { ...DEFAULTS.custom_test_prompts },

    label_names: { ...DEFAULTS.label_names },
    open_browser_allowed_origins: [...DEFAULTS.open_browser_allowed_origins],
    added_providers: [...DEFAULTS.added_providers],
    memory_budgets: { ...DEFAULTS.memory_budgets },

  }

}



function readRawSettingsFile(): Record<string, unknown> | null {

  try {

    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8')

    const data = JSON.parse(raw)

    if (!data || typeof data !== 'object' || Array.isArray(data)) return null
    const settings = data as Record<string, unknown>
    migrateLegacyProjectsDirectory(settings)
    return settings

  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      migrateLegacyProjectsDirectory({})
    }
    return null

  }

}

function migrateLegacyProjectsDirectory(settings: Record<string, unknown>): void {
  const legacyDirectory = path.join(CONFIG_DIR, 'user-files')
  const configured = typeof settings.user_directory === 'string'
    ? path.resolve(expandHomePath(settings.user_directory))
    : path.resolve(DEFAULT_USER_DIRECTORY)
  if (configured !== path.resolve(legacyDirectory) && (settings.user_directory || !fs.existsSync(legacyDirectory))) return

  const projectsDirectory = path.resolve(DEFAULT_USER_DIRECTORY)
  if (fs.existsSync(legacyDirectory)) {
    fs.mkdirSync(projectsDirectory, { recursive: true })
    for (const name of fs.readdirSync(legacyDirectory)) {
      const from = path.join(legacyDirectory, name)
      mergeLegacyEntry(from, path.join(projectsDirectory, name))
    }
    fs.rmdirSync(legacyDirectory)
  }
  settings.user_directory = projectsDirectory
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2))
}

function mergeLegacyEntry(source: string, destination: string): void {
  if (!fs.existsSync(destination)) {
    fs.renameSync(source, destination)
    return
  }
  const sourceStat = fs.lstatSync(source)
  const destinationStat = fs.lstatSync(destination)
  if (sourceStat.isDirectory() && destinationStat.isDirectory()) {
    for (const name of fs.readdirSync(source)) {
      mergeLegacyEntry(path.join(source, name), path.join(destination, name))
    }
    fs.rmdirSync(source)
    return
  }
  const extension = sourceStat.isFile() ? path.extname(source) : ''
  const stem = path.basename(source, extension)
  let index = 1
  let alternative: string
  do {
    alternative = path.join(path.dirname(destination), `${stem} (legacy ${index++})${extension}`)
  } while (fs.existsSync(alternative))
  fs.renameSync(source, alternative)
}



function normalizeOwnerPermissionLevel(value: unknown, ownerId: string): OwnerPermissionLevel {
  if (!ownerId?.trim()) return 'qa_only'
  const next = String(value ?? '').trim()
  if (next === 'qa_only' || next === 'no_bash' || next === 'full') return next
  return 'qa_only'
}

function normalizeChannelsConfig(channels: ChannelsConfig): ChannelsConfig {
  return {
    qq: {
      ...channels.qq,
      owner_permission_level: normalizeOwnerPermissionLevel(channels.qq.owner_permission_level, channels.qq.owner_user_id),
    },
    weixin: {
      ...channels.weixin,
      owner_permission_level: normalizeOwnerPermissionLevel(channels.weixin.owner_permission_level, channels.weixin.owner_user_id),
    },
    wecom: {
      ...channels.wecom,
      owner_permission_level: normalizeOwnerPermissionLevel(channels.wecom.owner_permission_level, channels.wecom.owner_user_id),
    },
    feishu: {
      ...channels.feishu,
      owner_permission_level: normalizeOwnerPermissionLevel(channels.feishu.owner_permission_level, channels.feishu.owner_user_id),
    },
  }
}

function loadSettingsFromRaw(raw: Record<string, unknown> | null): Settings {

  const merged = deepMerge(cloneDefaults(), raw ?? {}) as Settings

  // ZCF 机制已整体移除：老 settings.json 里的纯 ZCF 残留字段不再读取，也不再写回磁盘。
  // （`zcf_default_role` / `zcf_enabled_roles` / `zcf_custom_roles` 是风格字段，保留。）
  stripObsoleteZcfSettings(merged as unknown as Record<string, unknown>)

  merged.custom_auth_type = raw?.custom_auth_type === 'api_key' ? 'api_key' : 'auth_token'
  merged.weworker_protocol_custom = raw?.weworker_protocol_custom === 'openai_responses' ? 'openai_responses' : raw?.weworker_protocol_custom === 'openai_chat_completions' ? 'openai_chat_completions' : 'anthropic_messages'
  merged.active_weworker_protocol = raw?.active_weworker_protocol === 'openai_responses' ? 'openai_responses' : raw?.active_weworker_protocol === 'openai_chat_completions' ? 'openai_chat_completions' : 'anthropic_messages'
  for (const configuration of Object.values(merged.model_configurations || {})) {
    if (configuration?.provider_id === 'custom') {
      configuration.weworker_protocol = configuration.weworker_protocol === 'openai_responses'
        ? 'openai_responses'
        : configuration.weworker_protocol === 'openai_chat_completions'
          ? 'openai_chat_completions'
        : 'anthropic_messages'
    }
  }

  merged.added_providers = normalizeAddedProviders(raw?.added_providers)

  merged.context_limit_anthropic = normalizeContextLimit(raw?.context_limit_anthropic)
  merged.context_limit_glm = normalizeContextLimit(raw?.context_limit_glm)
  merged.context_limit_bank_coding = normalizeContextLimit(raw?.context_limit_bank_coding)
  merged.context_limit_deepseek = normalizeContextLimit(raw?.context_limit_deepseek)
  merged.context_limit_custom = normalizeContextLimit(raw?.context_limit_custom)
  merged.context_limit = merged.active_provider === 'glm'
    ? merged.context_limit_glm
    : merged.active_provider === 'deepseek'
      ? merged.context_limit_deepseek
      : merged.active_provider === 'custom'
        ? merged.context_limit_custom
        : merged.context_limit_anthropic

  const activeConfiguration = merged.model_configurations?.[merged.active_model_configuration || '']
  if (activeConfiguration) {
    merged.context_limit = normalizeContextLimit(activeConfiguration.context_limit)
    merged.active_weworker_protocol = activeConfiguration.weworker_protocol || 'anthropic_messages'
  } else if (raw?.active_weworker_protocol === undefined && merged.active_provider === 'custom') {
    merged.active_weworker_protocol = merged.weworker_protocol_custom
  }

  merged.max_chat_attachments = normalizeMaxChatAttachments(merged.max_chat_attachments)
  merged.paste_text_attachment_threshold = normalizePasteTextAttachmentThreshold(merged.paste_text_attachment_threshold)

  merged.download_directory = normalizeDownloadSubdirectory(
    merged.download_directory,
    path.resolve(expandHomePath(merged.user_directory || DEFAULT_USER_DIRECTORY)),
  )

  merged.channels = normalizeChannelsConfig(merged.channels)

  merged.user_directory_blacklist = normalizeUserDirectoryBlacklist(merged.user_directory_blacklist)
  merged.open_browser_allowed_origins = normalizeOpenBrowserAllowedOrigins(merged.open_browser_allowed_origins)
  merged.zcf_custom_roles = normalizeCustomStyles(merged.zcf_custom_roles)
  merged.memory_budgets = normalizeMemoryBudgets(merged.memory_budgets)
  merged.scheduled_task_history_limit = normalizeScheduledTaskHistoryLimit(merged.scheduled_task_history_limit)
  merged.zcf_default_role = normalizeDefaultStyleId(merged.zcf_default_role)
  merged.zcf_enabled_roles = normalizeEnabledStyles(
    merged.zcf_enabled_roles,
    merged.zcf_custom_roles,
    merged.zcf_default_role,
  )
  merged.zcf_default_role = merged.zcf_enabled_roles[0] || DEFAULT_STYLE_ID

  const plaintextSecrets = collectPlaintextSecretsFromRaw(raw)

  const encryptedBlob = raw?._encrypted as EncryptedSettingsBlob | undefined

  const decryptedSecrets = encryptedBlob?.fields && isSecretStoreReady()

    ? decryptSecrets(encryptedBlob.fields)

    : {}



  const secrets = { ...decryptedSecrets, ...plaintextSecrets }
  const resolved = applySecrets(merged, secrets)

  // Older settings files do not have the onboarding flag. Preserve a user's
  // existing configured setup while showing the flow for a genuinely new one.
  if (raw?.onboarding_completed === undefined) {
    const hasConfiguredModelKey = Boolean(
      resolved.api_key
      || resolved.api_key_anthropic
      || resolved.api_key_bank_coding
      || resolved.api_key_glm
      || resolved.api_key_deepseek
      || resolved.api_key_custom
      || Object.values(resolved.model_configurations || {}).some(configuration => Boolean(configuration.api_key?.trim())),
    )
    const legacyActiveProvider = typeof raw?.active_provider === 'string' ? raw.active_provider : ''
    resolved.onboarding_completed = hasConfiguredModelKey
      || legacyActiveProvider === 'builtin'
      || legacyActiveProvider === 'builtin_dev'
  }

  return migrateChannelConfigurations(resolved)

}



function buildPersistedSettings(settings: Settings): Record<string, unknown> {

  const secrets = extractSecrets(settings)

  const publicSettings = clearSecretsOnDisk(settings) as unknown as Record<string, unknown>

  delete publicSettings._encrypted



  if (!isSecretStoreReady()) {

    const legacy = structuredClone(settings) as unknown as Record<string, unknown>

    delete legacy._encrypted

    return legacy

  }



  return {

    ...publicSettings,

    _encrypted: {

      v: 1,

      fields: encryptSecrets(secrets),

    },

  }

}



function persistSettingsToDisk(settings: Settings): void {

  fs.mkdirSync(CONFIG_DIR, { recursive: true })

  const payload = buildPersistedSettings(settings)

  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(payload, null, 2))

}



export async function initSettings(): Promise<void> {

  await initSecretStore()

  const raw = readRawSettingsFile()

  _settings = loadSettingsFromRaw(raw)

  _settingsInitialized = true

  if (raw && countInvalidBlacklistEntries(raw.user_directory_blacklist) > 0) {
    persistSettingsToDisk(_settings)
    log.info('Removed invalid user directory blacklist entries from settings')
  }



  if (raw && rawFileHasPlaintextSecrets(raw) && isSecretStoreReady()) {

    persistSettingsToDisk(_settings)

    log.info('Migrated plaintext settings secrets to SM4 encrypted storage')

  }

}



export function resetSettingsStateForTests(): void {

  _settings = null

  _settingsInitialized = false

}



export function getSettings(): Settings {
  if (!_settings) _settings = loadSettingsFromRaw(readRawSettingsFile())
  return resolveBankCodingSettings(resolveBuiltinSettings(resolveConfiguredSettings(_settings, PROVIDERS), PROVIDERS), PROVIDERS)
}



export function updateSettings(updates: Partial<Settings>): Settings {

  getSettings() // Ensure the persisted settings have been loaded.
  // Merge the stored state, not the runtime projection containing deployment credentials.
  _settings = deepMerge(_settings!, updates) as Settings
  // Model configuration operations supply the complete collection. Deep merging
  // it would resurrect removed IDs, including when the last entry is deleted.
  if (updates.model_configurations !== undefined) {
    _settings.model_configurations = structuredClone(updates.model_configurations)
  }

  if (updates.channel_configurations !== undefined) {
    _settings.channel_configurations = structuredClone(updates.channel_configurations)
    _settings.active_channel_configurations = { ...updates.active_channel_configurations }
  } else if (updates.channels) {
    // Legacy API callers still update the selected instance, never other robots.
    for (const type of Object.keys(updates.channels) as ChannelType[]) {
      const id = _settings.active_channel_configurations?.[type]
      const entry = id ? _settings.channel_configurations?.[id] : undefined
      if (entry) entry.config = { ..._settings.channels[type] }
      else {
        const migrated = migrateChannelConfigurations({ ..._settings, channel_configurations: undefined })
        const legacyId = migrated.active_channel_configurations?.[type]
        if (legacyId) {
          _settings.channel_configurations = { ..._settings.channel_configurations, [legacyId]: migrated.channel_configurations![legacyId] }
          _settings.active_channel_configurations = { ..._settings.active_channel_configurations, [type]: legacyId }
        }
      }
    }
  }

  _settings.max_chat_attachments = normalizeMaxChatAttachments(_settings.max_chat_attachments)
  _settings.context_limit = normalizeContextLimit(_settings.context_limit)
  _settings.context_limit_anthropic = normalizeContextLimit(_settings.context_limit_anthropic)
  _settings.context_limit_glm = normalizeContextLimit(_settings.context_limit_glm)
  _settings.context_limit_bank_coding = normalizeContextLimit(_settings.context_limit_bank_coding)
  _settings.context_limit_deepseek = normalizeContextLimit(_settings.context_limit_deepseek)
  _settings.context_limit_custom = normalizeContextLimit(_settings.context_limit_custom)
  _settings.paste_text_attachment_threshold = normalizePasteTextAttachmentThreshold(_settings.paste_text_attachment_threshold)
  _settings.welcome_featured_site_limit = normalizeWelcomeFeaturedSiteLimit(_settings.welcome_featured_site_limit)
  _settings.user_directory_blacklist = normalizeUserDirectoryBlacklist(_settings.user_directory_blacklist)
  _settings.open_browser_allowed_origins = normalizeOpenBrowserAllowedOrigins(_settings.open_browser_allowed_origins)
  _settings.zcf_custom_roles = normalizeCustomStyles(_settings.zcf_custom_roles)
  _settings.memory_budgets = normalizeMemoryBudgets(_settings.memory_budgets)
  _settings.scheduled_task_history_limit = normalizeScheduledTaskHistoryLimit(_settings.scheduled_task_history_limit)
  if (updates.zcf_default_role !== undefined) {
    _settings.zcf_default_role = normalizeDefaultStyleId(_settings.zcf_default_role)
  }
  _settings.zcf_enabled_roles = normalizeEnabledStyles(
    _settings.zcf_enabled_roles,
    _settings.zcf_custom_roles,
    _settings.zcf_default_role,
  )
  _settings.zcf_default_role = _settings.zcf_enabled_roles[0] || DEFAULT_STYLE_ID

  _settings.added_providers = normalizeAddedProviders(_settings.added_providers)

  persistSettingsToDisk(_settings)

  _settingsInitialized = true

  return getSettings()

}



function deepMerge(base: unknown, override: unknown): unknown {

  if (typeof base !== 'object' || base === null) return override ?? base

  if (typeof override !== 'object' || override === null) return override ?? base

  // Arrays should be replaced, not merged

  if (Array.isArray(override)) return override

  const result = { ...(base as Record<string, unknown>) }

  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {

    if (k === '_encrypted') continue

    if (v !== undefined) {

      result[k] = v === null ? null : deepMerge(result[k], v)

    }

  }

  return result

}



/** Check if a site (adapter) is enabled. Missing keys use the provided default (true if not specified). */

export function getSiteEnabled(adapterId: string, defaultEnabled = true, managedEnabled?: boolean): boolean {
  if (managedEnabled !== undefined) return managedEnabled

  const s = getSettings()

  const toggle = s.site_toggles[adapterId]

  if (toggle !== undefined) {

    // User has explicitly set: 'hidden' counts as enabled, false is disabled

    return toggle !== false

  }

  // No user setting: use provided default (from registry)

  return defaultEnabled

}



/** Check if a site should be visible on the welcome page. Missing keys default to true. */

export function getSiteVisible(adapterId: string): boolean {

  const s = getSettings()

  const toggle = s.site_toggles[adapterId]

  // false = disabled (not visible), 'hidden' = enabled but not visible, true/undefined = visible

  return toggle !== false && toggle !== 'hidden'

}



/** Toggle a site's enabled state (enabled ↔ disabled). Preserves 'hidden' → false transition. Returns the new enabled value. */

export function toggleSite(adapterId: string): boolean {

  const s = getSettings()

  const current = s.site_toggles[adapterId]

  // If currently enabled (true, 'hidden', or undefined) → disable (false)

  // If currently disabled (false) → enable (true)

  const newState: boolean | 'hidden' = current === false ? true : false

  updateSettings({ site_toggles: { ...s.site_toggles, [adapterId]: newState } })

  return newState !== false

}



/** Set a site's visibility on the welcome page. Only works when site is enabled. */

export function setSiteVisibility(adapterId: string, visible: boolean, managedEnabled?: boolean): void {

  const s = getSettings()

  const current = s.site_toggles[adapterId]

  // Only change visibility if site is enabled (not false)

  if (!(managedEnabled ?? (current !== false))) return

  const newState: boolean | 'hidden' = visible ? true : 'hidden'

  updateSettings({ site_toggles: { ...s.site_toggles, [adapterId]: newState } })

}

/** Bulk set welcome-page visibility for all enabled adapters. */
export function setAllEnabledSitesWelcomeVisibility(
  adapterIds: string[],
  visible: boolean,
  managedStates = new Map<string, boolean>(),
): void {
  const s = getSettings()
  const toggles = { ...s.site_toggles }
  for (const id of adapterIds) {
    if (!(managedStates.get(id) ?? (toggles[id] !== false))) continue
    toggles[id] = visible ? true : 'hidden'
  }
  updateSettings({ site_toggles: toggles })
}


/** Get the set of currently enabled adapter IDs. */

export function getEnabledAdapterIds(): Set<string> {

  const s = getSettings()

  // All adapters are enabled by default; only explicitly disabled ones are excluded

  // We return a special marker: if site_toggles is empty, caller should treat all as enabled

  const disabled = Object.entries(s.site_toggles).filter(([, v]) => v === false).map(([k]) => k)

  // Return null-like signal via empty set only if everything is disabled (unlikely)

  // Caller should check: if adapterId is not in the set AND set is non-empty → disabled

  return new Set(

    Object.entries(s.site_toggles).filter(([, v]) => v !== false).map(([k]) => k)

  )

}



export function expandHomePath(input: string): string {

  if (!input) return DEFAULT_USER_DIRECTORY

  if (input === '~') return os.homedir()

  if (input.startsWith('~/') || input.startsWith('~\\')) {

    return path.join(os.homedir(), input.slice(2))

  }

  return input

}



export function normalizeMaxChatAttachments(value: unknown): number {

  const next = Number(value)

  if (!Number.isFinite(next)) return DEFAULT_MAX_CHAT_ATTACHMENTS

  return Math.min(MAX_CHAT_ATTACHMENTS, Math.max(MIN_CHAT_ATTACHMENTS, Math.floor(next)))

}

export function normalizePasteTextAttachmentThreshold(value: unknown): number {
  const next = Number(value)
  if (!Number.isFinite(next)) return DEFAULT_PASTE_TEXT_ATTACHMENT_THRESHOLD
  return Math.min(
    MAX_PASTE_TEXT_ATTACHMENT_THRESHOLD,
    Math.max(MIN_PASTE_TEXT_ATTACHMENT_THRESHOLD, Math.floor(next)),
  )
}

export function normalizeWelcomeFeaturedSiteLimit(value: unknown): number {
  const next = Number(value)
  if (!Number.isFinite(next)) return DEFAULT_WELCOME_FEATURED_SITE_LIMIT
  return Math.min(MAX_WELCOME_FEATURED_SITE_LIMIT, Math.max(MIN_WELCOME_FEATURED_SITE_LIMIT, Math.floor(next)))
}

export function normalizeOpenBrowserAllowedOrigin(value: unknown): string | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.hash = ''
    url.search = ''
    url.pathname = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

export function normalizeOpenBrowserAllowedOrigins(value: unknown): string[] {
  const rawItems = Array.isArray(value)
    ? value
    : String(value ?? '').split(',')
  const origins = new Set<string>()
  for (const item of rawItems) {
    const origin = normalizeOpenBrowserAllowedOrigin(item)
    if (origin) origins.add(origin)
  }
  return [...origins]
}

export function getUserDirectory(): string {

  const s = getSettings()

  return path.resolve(expandHomePath(s.user_directory || DEFAULT_USER_DIRECTORY))

}

export function getConfigDirectory(): string {
  return CONFIG_DIR
}

export function getDownloadSubdirectory(): string {

  const s = getSettings()

  return normalizeDownloadSubdirectory(s.download_directory, getUserDirectory())

}

export function getDownloadDirectory(): string {

  return resolveDownloadDirectory(getUserDirectory(), getSettings().download_directory)

}



export function ensureDownloadDirectory(): string {

  const dir = getDownloadDirectory()

  fs.mkdirSync(dir, { recursive: true })

  return dir

}



export function getMaxChatAttachments(): number {

  const s = getSettings()

  const next = normalizeMaxChatAttachments(s.max_chat_attachments)

  if (next !== s.max_chat_attachments) {

    updateSettings({ max_chat_attachments: next })

  }

  return next

}

export function getPasteTextAttachmentThreshold(): number {
  const s = getSettings()
  const next = normalizePasteTextAttachmentThreshold(s.paste_text_attachment_threshold)
  if (next !== s.paste_text_attachment_threshold) {
    updateSettings({ paste_text_attachment_threshold: next })
  }
  return next
}

export function getWelcomeFeaturedSiteLimit(): number {
  const s = getSettings()
  const next = normalizeWelcomeFeaturedSiteLimit(s.welcome_featured_site_limit)
  if (next !== s.welcome_featured_site_limit) {
    updateSettings({ welcome_featured_site_limit: next })
  }
  return next
}

export { DEFAULT_RESOURCE_PREVIEW_EXTENSIONS }

export function getResourcePreviewExtensions(): string[] {
  return getEffectivePreviewExtensions(getSettings().resource_preview_extensions)
}

export function getResourcePreviewExtensionSet(): Set<string> {
  return getPreviewExtensionSet(getSettings().resource_preview_extensions)
}

export function isResourcePreviewExtensionsCustomized(): boolean {
  return getSettings().resource_preview_extensions !== null
}

export function updateResourcePreviewExtensions(extensions: string[]): Settings {
  return updateSettings({ resource_preview_extensions: normalizePreviewExtensions(extensions) })
}

export function resetResourcePreviewExtensions(): Settings {
  return updateSettings({ resource_preview_extensions: null })
}

export function getUserDirectoryBlacklist(): UserDirectoryBlacklistEntry[] {

  return normalizeUserDirectoryBlacklist(getSettings().user_directory_blacklist)

}

export function getOpenBrowserAllowedOrigins(): string[] {
  return normalizeOpenBrowserAllowedOrigins(getSettings().open_browser_allowed_origins)
}



export function ensureUserDirectory(): string {

  const dir = getUserDirectory()

  fs.mkdirSync(dir, { recursive: true })

  return dir

}

export function ensureProjectDirectory(...segments: string[]): string {
  const root = path.resolve(ensureUserDirectory())
  const directory = path.resolve(root, ...segments)
  if (directory !== root && !directory.startsWith(`${root}${path.sep}`)) {
    throw new Error('project directory must stay inside projects root')
  }
  fs.mkdirSync(directory, { recursive: true })
  return directory
}
