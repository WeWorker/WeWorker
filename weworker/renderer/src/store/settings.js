import { BUILD_PROVIDERS, BUILD_DEFAULT_PROVIDER } from '../utils/provider-config.js'
import { create } from 'zustand'
import { appBotQrState } from '../utils/app-bot-qr-save.js'
import {
  DEFAULT_RESOURCE_PREVIEW_EXTENSIONS,
  getEffectivePreviewExtensions,
} from '../utils/resource-preview-extensions.js'
import { backendFetch } from '../api/http.js'
import { isFixedProvider } from '../utils/model-selection.js'

const API = 'http://127.0.0.1:8765'

const DEFAULT_STYLE = { subtitle: '', color: '#8B5CF6', bg: 'rgba(139,92,246,0.12)' }
const DEFAULT_WELCOME_FEATURED_SITE_LIMIT = 50
const DEFAULT_PASTE_TEXT_ATTACHMENT_THRESHOLD = 20000

function settingsPatch(data, fallback = {}) {
  const hasPreviewApi = Object.prototype.hasOwnProperty.call(data, 'resource_preview_extensions')
  const defaultResourcePreviewExtensions = data.default_resource_preview_extensions?.length
    ? data.default_resource_preview_extensions
    : (fallback.defaultResourcePreviewExtensions?.length
        ? fallback.defaultResourcePreviewExtensions
        : [...DEFAULT_RESOURCE_PREVIEW_EXTENSIONS])
  const resourcePreviewExtensions = hasPreviewApi
    ? getEffectivePreviewExtensions(data.resource_preview_extensions)
    : (fallback.resourcePreviewExtensions?.length
        ? fallback.resourcePreviewExtensions
        : [...DEFAULT_RESOURCE_PREVIEW_EXTENSIONS])

  return {
    activeProvider: data.active_provider,
    onboardingCompleted: data.onboarding_completed ?? fallback.onboardingCompleted ?? false,
    baseUrl: data.base_url,
    model: data.model,
    contextLimit: data.context_limit || fallback.contextLimit || 1000000,
    hasApiKey: data.has_api_key,
    userDirectory: data.user_directory || fallback.userDirectory || '',
    downloadSubdirectory: data.download_subdirectory || fallback.downloadSubdirectory || 'download',
    downloadDirectory: data.download_directory || fallback.downloadDirectory || '',
    maxChatAttachments: data.max_chat_attachments || fallback.maxChatAttachments || 60,
    pasteTextAttachmentThreshold: data.paste_text_attachment_threshold || fallback.pasteTextAttachmentThreshold || DEFAULT_PASTE_TEXT_ATTACHMENT_THRESHOLD,
    welcomeFeaturedSiteLimit: data.welcome_featured_site_limit || fallback.welcomeFeaturedSiteLimit || DEFAULT_WELCOME_FEATURED_SITE_LIMIT,
    userDirectoryBlacklist: data.user_directory_blacklist ?? fallback.userDirectoryBlacklist ?? [],
    defaultOpenBrowserAllowedOrigins: data.default_open_browser_allowed_origins ?? fallback.defaultOpenBrowserAllowedOrigins ?? [],
    openBrowserAllowedOrigins: data.open_browser_allowed_origins ?? fallback.openBrowserAllowedOrigins ?? [],
    resourcePreviewExtensions,
    resourcePreviewExtensionsCustomized: hasPreviewApi
      ? (data.resource_preview_extensions_customized ?? false)
      : (fallback.resourcePreviewExtensionsCustomized ?? false),
    defaultResourcePreviewExtensions,
    providers: data.providers ?? {},
    // 风格设置：沿用历史 `zcf_*` 字段名（改名需要数据迁移），语义上只是「风格」。
    // 纯 ZCF 字段（zcf_lang / zcf_default_mode / zcf_package_version / zcf_sync）已删除，
    // 老 settings.json 里的残留值被后端忽略，这里也不再读取。
    zcfDefaultRole: data.zcf_default_role || fallback.zcfDefaultRole || 'default',
    zcfEnabledRoles: data.zcf_enabled_roles ?? fallback.zcfEnabledRoles ?? ['default'],
    zcfCustomRoles: data.zcf_custom_roles ?? fallback.zcfCustomRoles ?? [],
  }
}

export { isBuiltinProvider, hasFixedModel } from '../utils/provider-config.js'
export const BUILTIN_PROVIDER_IDS = BUILD_PROVIDERS.filter(p => p.builtin).map(p => p.id)
export const PROVIDERS = BUILD_PROVIDERS.map(p => ({ ...p, ...(p.presentation || DEFAULT_STYLE) }))

export const useSettingsStore = create((set, get) => ({
  activeProvider: BUILD_DEFAULT_PROVIDER,
  onboardingCompleted: false,
  baseUrl: BUILD_PROVIDERS.find(p => p.id === BUILD_DEFAULT_PROVIDER)?.weworker.baseUrl || '',
  model: BUILD_PROVIDERS.find(p => p.id === BUILD_DEFAULT_PROVIDER)?.defaultModel || '',
  contextLimit: 1000000,
  hasApiKey: false,
  userDirectory: '',
  downloadSubdirectory: 'download',
  downloadDirectory: '',
  maxChatAttachments: 60,
  pasteTextAttachmentThreshold: DEFAULT_PASTE_TEXT_ATTACHMENT_THRESHOLD,
  welcomeFeaturedSiteLimit: DEFAULT_WELCOME_FEATURED_SITE_LIMIT,
  resourcePreviewExtensions: [...DEFAULT_RESOURCE_PREVIEW_EXTENSIONS],
  resourcePreviewExtensionsCustomized: false,
  defaultResourcePreviewExtensions: [...DEFAULT_RESOURCE_PREVIEW_EXTENSIONS],
  userDirectoryBlacklist: [],
  defaultOpenBrowserAllowedOrigins: [],
  openBrowserAllowedOrigins: [],
  zcfDefaultRole: 'default',
  zcfEnabledRoles: ['default'],
  zcfCustomRoles: [],
  providers: Object.fromEntries(BUILD_PROVIDERS.map(provider => [provider.id, {
    has_key: false, model: provider.defaultModel, context_limit: 1000000,
    readonly: provider.builtin === true, added: provider.fixed === true || provider.builtin === true,
    visible: provider.fixed === true || provider.builtin === true,
  }])),
  loaded: false,
  loadError: '',
  explorationModelRevision: 0,
  customModelsSaving: {},
  channels: { qq: { enabled: false, app_id: '', has_app_secret: false, owner_user_id: '' }, weixin: { enabled: false, has_token: false, base_url: '', owner_user_id: '' }, wecom: { enabled: false, bot_id: '', has_secret: false, owner_user_id: '' }, feishu: { enabled: false, app_id: '', has_app_secret: false, owner_user_id: '' } },

  load: async () => {
    set({ loadError: '' })
    try {
      const signal = AbortSignal.timeout(15000)
      const [res, chRes] = await Promise.all([
        backendFetch(`${API}/settings`, { signal }),
        backendFetch(`${API}/settings/channels`, { signal }),
      ])
      if (!res.ok || !chRes.ok) throw new Error(`初始化配置请求失败（HTTP ${!res.ok ? res.status : chRes.status}）`)
      const data = await res.json()
      const chData = await chRes.json()
      set({ ...settingsPatch(data), loaded: true, loadError: '', channels: chData })
    } catch (error) {
      set({ loadError: error?.message?.startsWith('初始化配置请求失败') ? error.message : '无法加载初始化配置，请检查本地服务后重试。' })
    }
  },

  // Save config for one provider (does not switch active)
  addProvider: async (provider) => {
    const res = await backendFetch(`${API}/settings/provider/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || '添加模型失败')
    set(settingsPatch(data, get()))
    return data.created_provider
  },

  deleteProvider: async (provider) => {
    const res = await backendFetch(`${API}/settings/provider/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || '删除模型失败')
    set(settingsPatch(data, get()))
  },

  saveProvider: async (provider, updates) => {
    const res = await backendFetch(`${API}/settings/provider`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, ...updates }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || '保存失败')
    set(settingsPatch(data, get()))
  },

  // Keep the operation alive across settings-page unmounts. Only model fields
  // are saved here; unfinished credentials and other form edits stay drafts.
  saveCustomModels: async (provider, model, customModels) => {
    if (get().customModelsSaving[provider]) throw new Error('自定义模型正在保存，请稍候')
    set(state => ({ customModelsSaving: { ...state.customModelsSaving, [provider]: true } }))
    try {
      await get().saveProvider(provider, { model, custom_models: customModels })
    } finally {
      set(state => {
        const customModelsSaving = { ...state.customModelsSaving }
        delete customModelsSaving[provider]
        return { customModelsSaving }
      })
    }
  },

  configurePresetProvider: async (provider, apiKey) => {
    if (!isFixedProvider(provider) || !PROVIDERS.some(item => item.id === provider)) {
      throw new Error('请选择预定义供应商')
    }
    const key = String(apiKey || '').trim()
    if (!key) throw new Error('请填写 API Key')
    await get().saveProvider(provider, { api_key: key })
    await get().activateProvider(provider)
  },

  completeOnboarding: async (provider) => {
    const res = await backendFetch(`${API}/settings/onboarding/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || '初始化模型失败')
    set(settingsPatch(data, get()))
    return data
  },

  // Switch which provider is active
  activateProvider: async (provider) => {
    const res = await backendFetch(`${API}/settings/provider/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || '切换失败')
    set(settingsPatch(data, get()))
  },

  saveUserDirectory: async (userDirectory) => {
    const res = await backendFetch(`${API}/settings/user-directory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_directory: userDirectory }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || '保存失败')
    set(settingsPatch(data, get()))
    return data.user_directory || ''
  },

  saveDownloadDirectory: async (downloadSubdirectory) => {
    const res = await backendFetch(`${API}/settings/download-directory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ download_subdirectory: downloadSubdirectory }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || '保存失败')
    set(settingsPatch(data, get()))
    return {
      downloadSubdirectory: data.download_subdirectory || downloadSubdirectory,
      downloadDirectory: data.download_directory || get().downloadDirectory,
    }
  },

  saveMaxChatAttachments: async (maxChatAttachments) => {
    const res = await backendFetch(`${API}/settings/chat-attachments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ max_chat_attachments: maxChatAttachments }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || '保存失败')
    set(settingsPatch(data, get()))
    return data.max_chat_attachments || 60
  },

  savePasteTextAttachmentThreshold: async (pasteTextAttachmentThreshold) => {
    const res = await backendFetch(`${API}/settings/paste-text-attachment-threshold`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paste_text_attachment_threshold: pasteTextAttachmentThreshold }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || '淇濆瓨澶辫触')
    set(settingsPatch(data, get()))
    return data.paste_text_attachment_threshold || DEFAULT_PASTE_TEXT_ATTACHMENT_THRESHOLD
  },

  saveWelcomeFeaturedSiteLimit: async (welcomeFeaturedSiteLimit) => {
    const res = await backendFetch(`${API}/settings/welcome-featured-sites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ welcome_featured_site_limit: welcomeFeaturedSiteLimit }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || '保存失败')
    set(settingsPatch(data, get()))
    return data.welcome_featured_site_limit || DEFAULT_WELCOME_FEATURED_SITE_LIMIT
  },

  saveResourcePreviewExtensions: async (resourcePreviewExtensions) => {
    const res = await backendFetch(`${API}/settings/resource-preview-extensions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resource_preview_extensions: resourcePreviewExtensions }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || '保存失败')
    set(settingsPatch(data, get()))
    return data.resource_preview_extensions || []
  },

  resetResourcePreviewExtensions: async () => {
    const res = await backendFetch(`${API}/settings/resource-preview-extensions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reset: true }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || '恢复默认失败')
    set(settingsPatch(data, get()))
    return data.resource_preview_extensions || []
  },

  saveUserDirectoryBlacklist: async (userDirectoryBlacklist) => {
    const res = await backendFetch(`${API}/settings/user-directory-blacklist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_directory_blacklist: userDirectoryBlacklist }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || '保存失败')
    const entries = data.user_directory_blacklist || userDirectoryBlacklist
    set({ userDirectoryBlacklist: entries })
    return { entries, dropped: Number(data.blacklist_dropped || 0) }
  },

  savePermissions: async ({ openBrowserAllowedOrigins }) => {
    const res = await backendFetch(`${API}/settings/permissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ open_browser_allowed_origins: openBrowserAllowedOrigins }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || '保存失败')
    set(settingsPatch(data, get()))
    return data.open_browser_allowed_origins || []
  },

  // Keep unsuccessful imports across page unmounts, in memory only.
  ...appBotQrState(set, get),
  wecomQrPending: null,
  wecomQrSaving: false,
  saveWecomQr: async (credentials = get().wecomQrPending) => {
    if (get().wecomQrSaving) throw new Error('机器人配置正在保存，请稍候')
    if (!credentials?.bot_id || !credentials?.secret) throw new Error('未获取完整机器人配置')
    const pending = { bot_id: credentials.bot_id, secret: credentials.secret }
    set({ wecomQrPending: pending, wecomQrSaving: true })
    try {
      // Omitted fields retain saved owner/permissions and other channels.
      await get().saveChannels({ wecom: { ...pending, enabled: true } })
      set({ wecomQrPending: null })
    } catch {
      throw new Error('机器人已创建，但配置保存失败。请点击“重试保存”，无需重新扫码。')
    } finally {
      set({ wecomQrSaving: false })
    }
  },

  channelProfileQrPending: {},
  channelProfileQrSaving: {},
  saveChannelProfileQr: async (id, credentials = get().channelProfileQrPending[id]) => {
    const profile = get().channels.configurations?.[id]
    if (!profile) throw new Error('机器人配置不存在，请重新选择')
    if (get().channelProfileQrSaving[id]) throw new Error('机器人配置正在保存，请稍候')
    if (!credentials) throw new Error('未获取完整机器人配置')
    set(state => ({ channelProfileQrPending: { ...state.channelProfileQrPending, [id]: credentials }, channelProfileQrSaving: { ...state.channelProfileQrSaving, [id]: true } }))
    try {
      const identity = profile.type === 'wecom' ? 'bot_id' : 'app_id'
      const changed = profile.config[identity] !== credentials[identity]
      await get().channelProfileAction(profile.type, 'save', id, { config: { ...credentials, enabled: true,
        ...(changed ? { owner_user_id: '', owner_permission_level: 'qa_only' } : {}) } })
      set(state => ({ channelProfileQrPending: { ...state.channelProfileQrPending, [id]: null } }))
    } catch {
      throw new Error('扫码已完成，但配置保存失败。请点击“重试保存”，无需重新扫码。')
    } finally {
      set(state => ({ channelProfileQrSaving: { ...state.channelProfileQrSaving, [id]: false } }))
    }
  },

  channelProfileAction: async (channel, action, id, input = {}) => {
    const res = await backendFetch(`${API}/settings/channels/configuration`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, action, id, ...input }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || '机器人操作失败')
    set(state => ({ channels: { ...state.channels, [channel]: data[channel],
      configurations: { ...Object.fromEntries(Object.entries(state.channels.configurations || {}).filter(([, entry]) => entry.type !== channel)),
        ...Object.fromEntries(Object.entries(data.configurations || {}).filter(([, entry]) => entry.type === channel)) },
      active_ids: { ...state.channels.active_ids, [channel]: data.active_ids?.[channel] },
    } }))
    if (action === 'delete') set(state => ({
      channelProfileQrPending: Object.fromEntries(Object.entries(state.channelProfileQrPending).filter(([key]) => key !== id)),
      channelProfileQrSaving: Object.fromEntries(Object.entries(state.channelProfileQrSaving).filter(([key]) => key !== id)),
    }))
    return data.selected_id
  },

  saveChannels: async (updates) => {
    const res = await backendFetch(`${API}/settings/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || '保存失败')
    // Concurrent QR imports must not replace another channel with an older snapshot.
    set(state => ({ channels: { ...state.channels, ...Object.fromEntries(Object.keys(updates).filter(key => data[key]).map(key => [key, data[key]])) } }))
  },

  /**
   * 保存风格设置（当前风格 + 已启用列表 + 自定义风格）。
   *
   * 走 `/settings/styles`；请求体字段名沿用历史 `zcf_*` 键（后端 `Settings`
   * 类型与 settings.json 同名字段，改名需要数据迁移）。风格互斥，`zcf_enabled_roles`
   * 恒为 `[当前风格]`。
   */
  saveStyleSettings: async ({ zcfDefaultRole, zcfEnabledRoles, zcfCustomRoles }) => {
    const activeStyle = zcfDefaultRole || zcfEnabledRoles?.[0] || 'default'
    const body = {
      zcf_default_role: activeStyle,
      zcf_enabled_roles: [activeStyle],
    }
    if (zcfCustomRoles !== undefined) body.zcf_custom_roles = zcfCustomRoles
    const res = await backendFetch(`${API}/settings/styles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || '保存失败')
    set(settingsPatch(data, get()))
    return data
  },
}))



export function detectProvider(baseUrl) {
  if (!baseUrl || baseUrl === 'https://api.anthropic.com') return 'anthropic'
  if (baseUrl.includes('bigmodel.cn')) return 'glm'
  if (baseUrl.includes('deepseek.com')) return 'deepseek'
  return 'custom'
}
