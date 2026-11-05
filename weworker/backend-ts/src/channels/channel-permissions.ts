import { getSettings } from '../config.js'

export type ChannelName = 'qq' | 'weixin' | 'wecom' | 'feishu'
export type OwnerPermissionLevel = 'qa_only' | 'no_bash' | 'full'
// Desktop modes permit native commands while retaining access guards.
// Persisted channel owner levels keep their existing meaning.
export type ChannelPermissionMode = OwnerPermissionLevel | 'workspace' | 'ask'

export function allowsNativeCommands(mode: ChannelPermissionMode): boolean {
  return mode === 'full' || mode === 'workspace' || mode === 'ask'
}

export function isGuardedDesktopMode(mode: ChannelPermissionMode): boolean {
  return mode === 'workspace' || mode === 'ask'
}

export const CHANNEL_LABELS: Record<ChannelName, string> = {
  qq: 'QQ',
  weixin: '微信',
  wecom: '企业微信',
  feishu: '飞书',
}

const OWNER_USER_ID_MIN_LENGTH = 6
const OWNER_USER_ID_MAX_LENGTH = 128
const OWNER_USER_ID_PATTERN = /^[A-Za-z0-9_-]+$/

export function normalizeOwnerUserId(value: unknown): string {
  return String(value ?? '').trim()
}

/** Returns an error message, or null when empty or valid. Keep in sync with renderer owner-user-id.js */
export function validateOwnerUserId(channel: ChannelName, value: unknown): string | null {
  const id = normalizeOwnerUserId(value)
  if (!id) return null

  const label = CHANNEL_LABELS[channel]
  if (id.length < OWNER_USER_ID_MIN_LENGTH) {
    return `${label} 主人 ID 过短，请在该通道发送 /myid 获取完整 ID 后粘贴（至少 ${OWNER_USER_ID_MIN_LENGTH} 个字符）`
  }
  if (id.length > OWNER_USER_ID_MAX_LENGTH) {
    return `${label} 主人 ID 过长（最多 ${OWNER_USER_ID_MAX_LENGTH} 个字符）`
  }
  if (!OWNER_USER_ID_PATTERN.test(id)) {
    return `${label} 主人 ID 格式不正确，请发送 /myid 获取后原样粘贴（仅允许字母、数字、下划线、连字符）`
  }
  return null
}

export function normalizeOwnerPermissionLevel(value: unknown): OwnerPermissionLevel {
  const next = String(value ?? '').trim()
  if (next === 'qa_only' || next === 'no_bash' || next === 'full') return next
  return 'qa_only'
}

export function resolveChannelName(channelType: string): ChannelName | null {
  if (channelType.startsWith('qq')) return 'qq'
  if (channelType === 'weixin') return 'weixin'
  if (channelType.startsWith('wecom')) return 'wecom'
  if (channelType.startsWith('feishu')) return 'feishu'
  return null
}

export function isChannelOwner(channel: ChannelName, userId: string): boolean {
  const ownerId = normalizeOwnerUserId(getSettings().channels[channel].owner_user_id)
  if (!ownerId) return false
  return normalizeOwnerUserId(userId) === ownerId
}

export function getOwnerPermissionLevel(channel: ChannelName): OwnerPermissionLevel {
  const ownerId = normalizeOwnerUserId(getSettings().channels[channel].owner_user_id)
  if (!ownerId) return 'qa_only'
  return normalizeOwnerPermissionLevel(getSettings().channels[channel].owner_permission_level)
}

export function getChannelPermissionMode(channel: ChannelName, userId: string): ChannelPermissionMode {
  if (!isChannelOwner(channel, userId)) return 'qa_only'
  return getOwnerPermissionLevel(channel)
}

export function getChannelPermissionModeByType(channelType: string, userId: string): ChannelPermissionMode {
  const channel = resolveChannelName(channelType)
  if (!channel) return 'qa_only'
  return getChannelPermissionMode(channel, userId)
}

export const CHANNEL_MYID_HINT = '可在 设置 → 通道 中配置主人 ID 与权限级别；未配置主人 ID 时所有用户仅有问答权限。'

export const CHANNEL_EMPTY_REPLY_FALLBACK = '抱歉，本次未能生成文字回复。请换个方式提问；若需执行命令或操作网站，请联系管理员在 设置 → 通道 中配置主人 ID。'
