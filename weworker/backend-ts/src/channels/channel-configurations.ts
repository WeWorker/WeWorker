import { randomUUID } from 'node:crypto'
import type { ChannelsConfig, Settings, WecomChannelConfig } from '../config.js'
import { normalizeOwnerPermissionLevel, validateOwnerUserId } from './channel-permissions.js'
import { generatePairingCode } from './pairing-code.js'

export const CHANNEL_NAMES = { qq: 'QQ', feishu: '飞书', wecom: '企业微信', weixin: '微信' } as const
export type ChannelType = keyof typeof CHANNEL_NAMES
export type ChannelConfiguration = { id: string; type: ChannelType; name: string; config: ChannelsConfig[ChannelType] }
export type ChannelConfigurations = Record<string, ChannelConfiguration>
export const isChannelType = (value: unknown): value is ChannelType => typeof value === 'string' && Object.hasOwn(CHANNEL_NAMES, value)

export function emptyChannel(type: ChannelType): ChannelsConfig[ChannelType] {
  const base = { enabled: false, owner_user_id: '', owner_permission_level: 'qa_only' as const }
  return type === 'weixin' ? { ...base, token: '', base_url: '' }
    : type === 'wecom' ? { ...base, bot_id: '', secret: '', pairing_code: '' } : { ...base, app_id: '', app_secret: '' }
}

// Lazy, idempotent migration: keep the old runtime fields for existing consumers.
export function migrateChannelConfigurations(settings: Settings): Settings {
  if (settings.channel_configurations !== undefined) return settings
  const configurations: ChannelConfigurations = {}
  const active: Partial<Record<ChannelType, string>> = {}
  for (const type of Object.keys(CHANNEL_NAMES) as ChannelType[]) {
    const config = settings.channels[type]
    if (!config.enabled && !Object.entries(config).some(([key, value]) => key !== 'owner_permission_level' && typeof value === 'string' && value.trim())) continue
    const id = `legacy-${type}`
    configurations[id] = { id, type, name: `${CHANNEL_NAMES[type]}(1)`, config: { ...config } }
    active[type] = id
  }
  return { ...settings, channel_configurations: configurations, active_channel_configurations: active }
}

export function getChannelConfiguration(settings: Settings, type: ChannelType, id: unknown) {
  if (typeof id !== 'string' || !Object.hasOwn(settings.channel_configurations || {}, id)) throw new Error('机器人配置不存在，请刷新后重试')
  const entry = settings.channel_configurations![id]
  if (entry.type !== type) throw new Error('机器人类型不匹配')
  return entry
}

function publicConfig(config: ChannelsConfig[ChannelType]) {
  const { app_secret, secret, token, ...visible } = config as unknown as Record<string, unknown>
  return { ...visible, has_app_secret: !!app_secret, has_secret: !!secret, has_token: !!token }
}

export function publicChannelSettings(settings: Settings) {
  const state = migrateChannelConfigurations(settings)
  return {
    ...Object.fromEntries(Object.entries(state.channels).map(([type, config]) => [type, publicConfig(config)])),
    configurations: Object.fromEntries(Object.entries(state.channel_configurations!).map(([id, entry]) => [id, { ...entry, config: publicConfig(entry.config) }])),
    active_ids: state.active_channel_configurations || {},
  }
}

export function changeChannelConfiguration(settings: Settings, type: ChannelType, action: string, id?: unknown, input: Record<string, unknown> = {}) {
  const state = migrateChannelConfigurations(settings)
  const entries = structuredClone(state.channel_configurations!)
  const active = { ...state.active_channel_configurations }
  const channels = structuredClone(state.channels)
  let entry: ChannelConfiguration
  if (action === 'add') {
    let index = 1
    const names = new Set(Object.values(entries).filter(item => item.type === type).map(item => item.name))
    while (names.has(`${CHANNEL_NAMES[type]}(${index})`)) index++
    const newId = randomUUID()
    entry = { id: newId, type, name: `${CHANNEL_NAMES[type]}(${index})`, config: emptyChannel(type) }
    entries[newId] = entry
  } else {
    entry = entries[getChannelConfiguration(state, type, id).id]
    if (action === 'rename') {
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 60) throw new Error('机器人名称需要为 1–60 个字符')
      entry.name = input.name.trim()
    } else if (action === 'delete') {
      delete entries[entry.id]
      if (active[type] === entry.id) { delete active[type]; Object.assign(channels[type], emptyChannel(type)) }
    } else if (type === 'wecom' && (action === 'pair' || action === 're-pair')) {
      const config = entry.config as WecomChannelConfig
      if (!config.enabled || active.wecom !== entry.id || !config.bot_id || !config.secret) throw new Error('请先保存并启用这个企业微信机器人')
      if (action === 're-pair') {
        config.owner_user_id = ''
        config.owner_permission_level = 'qa_only'
        config.pairing_code = generatePairingCode(config.pairing_code)
      } else if (!config.owner_user_id && !config.pairing_code) {
        config.pairing_code = generatePairingCode()
      }
      Object.assign(channels.wecom, config)
    } else if (action === 'save' || action === 'activate') {
      const previousBotId = type === 'wecom' ? (entry.config as WecomChannelConfig).bot_id : ''
      if (action === 'save') {
        // WeCom owner identity is written only by verified inbound pairing.
        const allowed = Object.keys(emptyChannel(type)).filter(key => type !== 'wecom' || !['owner_user_id', 'pairing_code'].includes(key))
        const config = entry.config as unknown as Record<string, unknown>
        for (const key of allowed) {
          if (input[key] === undefined) continue
          if (key === 'enabled') { if (typeof input[key] !== 'boolean') throw new Error('启用状态无效') }
          else if (typeof input[key] !== 'string') throw new Error('机器人配置格式无效')
          const value = typeof input[key] === 'string' ? (input[key] as string).trim() : input[key]
          if (['app_secret', 'secret', 'token'].includes(key) && !value) continue
          config[key] = value
        }
        const error = type === 'wecom' ? null : validateOwnerUserId(type, entry.config.owner_user_id)
        if (error) throw new Error(error)
        entry.config.owner_permission_level = entry.config.owner_user_id ? normalizeOwnerPermissionLevel(entry.config.owner_permission_level) : 'qa_only'
      } else entry.config.enabled = true
      if (type === 'wecom') {
        const config = entry.config as WecomChannelConfig
        if (previousBotId !== config.bot_id) {
          config.owner_user_id = ''
          config.owner_permission_level = 'qa_only'
          config.pairing_code = ''
        }
        if (config.owner_user_id) config.pairing_code = ''
        else if (config.bot_id && config.secret && !config.pairing_code) config.pairing_code = generatePairingCode()
      }
      if (entry.config.enabled) {
        const config = entry.config as unknown as Record<string, unknown>
        const required = type === 'weixin' ? ['token'] : type === 'wecom' ? ['bot_id', 'secret'] : ['app_id', 'app_secret']
        if (required.some(key => !config[key])) throw new Error('请先填写并保存完整的机器人凭证')
        for (const item of Object.values(entries)) if (item.type === type && item.id !== entry.id) item.config.enabled = false
        active[type] = entry.id
      }
      if (active[type] === entry.id) Object.assign(channels[type], entry.config)
    } else throw new Error('不支持的机器人操作')
  }
  return { id: entry.id, updates: { channels, channel_configurations: entries, active_channel_configurations: active } }
}

// Serialize saves/switches so asynchronous stop/start cannot overlap within a type.
export function createChannelMutationQueue() {
  const pending = new Map<string, Promise<unknown>>()
  return function run<T>(type: string, task: () => Promise<T>): Promise<T> {
    const result = (pending.get(type) || Promise.resolve()).catch(() => {}).then(task)
    pending.set(type, result)
    void result.finally(() => { if (pending.get(type) === result) pending.delete(type) }).catch(() => {})
    return result
  }
}
