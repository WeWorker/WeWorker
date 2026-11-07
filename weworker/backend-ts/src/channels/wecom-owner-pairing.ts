import { getSettings, updateSettings, type WecomChannelConfig } from '../config.js'
import { migrateChannelConfigurations } from './channel-configurations.js'
import type { ChannelAccessDecision } from './channel-profile.js'
import { extractPairingCode } from './pairing-code.js'

const LOCK_MS = 10 * 60_000
const MAX_ATTEMPTS = 5
export const WECOM_PAIRING_HINT = '请在 WeWorker「设置 → 通道 → 企业微信」查看绑定码，私聊机器人发送“绑定 六位绑定码”，即可自动绑定主人。'

/** Bound to the socket credentials, so a stale connection cannot claim a new bot. */
export function createWecomOwnerPairing(identity: { bot_id: string; secret: string }) {
  const attempts = new Map<string, { failures: number; expiresAt: number }>()
  let pendingCode = ''
  return (userId: string, text: string, chatType?: string): ChannelAccessDecision | null => {
    const settings = migrateChannelConfigurations(getSettings())
    const id = settings.active_channel_configurations?.wecom
    const entry = id ? settings.channel_configurations?.[id] : undefined
    const config = entry?.config as WecomChannelConfig | undefined
    const code = extractPairingCode(text)
    const bindingCommand = /^(?:绑定|配对|\/bind|bind|\/绑定)(?:\s|[:：\d]|$)/i.test(text.trim())
    if (!bindingCommand && (!code || config?.owner_user_id)) return null
    if (!config?.enabled || entry?.type !== 'wecom' || config.bot_id !== identity.bot_id || config.secret !== identity.secret) {
      return { kind: 'reply', text: '当前机器人配置已停用或切换，请在 WeWorker 中确认正在使用的机器人后再绑定。' }
    }
    if (chatType !== 'single') return { kind: 'reply', text: '请私聊机器人发送绑定码，不要在群聊中发送。' }
    if (!userId.trim()) return { kind: 'reply', text: '无法识别发送者，请重新发送绑定消息。' }
    if (config.owner_user_id) return { kind: 'reply', text: '该机器人已绑定主人。如需更换，请先在 WeWorker「设置 → 通道 → 企业微信」点击“重新绑定”。' }
    if (!config.pairing_code || !code) return { kind: 'reply', text: WECOM_PAIRING_HINT }
    if (pendingCode !== config.pairing_code) { attempts.clear(); pendingCode = config.pairing_code }
    const now = Date.now()
    for (const [sender, record] of attempts) if (record.expiresAt <= now) attempts.delete(sender)
    const record = attempts.get(userId)
    if ((record?.failures ?? 0) >= MAX_ATTEMPTS || (!record && attempts.size >= 1000)) {
      return { kind: 'reply', text: '绑定码错误次数过多，请 10 分钟后再试。' }
    }
    if (code !== config.pairing_code) {
      attempts.set(userId, { failures: (record?.failures ?? 0) + 1, expiresAt: now + LOCK_MS })
      return { kind: 'reply', text: '绑定码不正确，请核对 WeWorker「设置 → 通道 → 企业微信」显示的绑定码。' }
    }
    const paired = { ...config, owner_user_id: userId, pairing_code: '' }
    try {
      // Synchronous read/check/write: consume once, before another message can run.
      updateSettings({
        channels: { ...settings.channels, wecom: paired },
        channel_configurations: { ...settings.channel_configurations, [id!]: { ...entry!, config: paired } },
        active_channel_configurations: { ...settings.active_channel_configurations },
      })
    } catch {
      return { kind: 'reply', text: '绑定保存失败，请稍后重试。' }
    }
    attempts.clear()
    return { kind: 'reply', ownerPaired: true, text: '✅ 主人绑定成功！无需手动填写用户 ID。可在 WeWorker「设置 → 通道 → 企业微信」选择主人权限，之后直接给我发送消息即可。' }
  }
}
