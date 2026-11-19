import type { ChannelPermissionMode } from './channels/channel-permissions.js'

export type DesktopChatPermissionMode = 'ask' | 'workspace' | 'full'

export interface DesktopChatPermission {
  channelPermissionMode: ChannelPermissionMode
  sdkPermissionMode: 'default' | 'acceptEdits' | 'bypassPermissions'
  allowDangerouslySkipPermissions: boolean
}

export function resolveDesktopChatPermission(value: unknown): DesktopChatPermission {
  switch (value) {
    case 'workspace':
      return {
        channelPermissionMode: 'workspace',
        sdkPermissionMode: 'acceptEdits',
        allowDangerouslySkipPermissions: false,
      }
    case 'ask':
      return {
        channelPermissionMode: 'ask',
        sdkPermissionMode: 'default',
        allowDangerouslySkipPermissions: false,
      }
    case 'full':
      return {
        channelPermissionMode: 'full',
        sdkPermissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      }
    default:
      return {
        channelPermissionMode: 'workspace',
        sdkPermissionMode: 'acceptEdits',
        allowDangerouslySkipPermissions: false,
      }
  }
}

/**
 * WeWorker Bot 会话的权限形态（企微/微信、桌面端、定时任务统一）。
 *
 * 与 IM 路径完全一致：channelPermissionMode 为 full，但 SDK 权限保持
 * default —— canUseTool 照常执行，Bot 的 extraToolGuard（webcli 站点范围
 * + MCP 工具白名单）正是在 canUseTool 里生效的。刻意不使用桌面 full 的
 * bypassPermissions 形态：那会跳过 canUseTool，反而失去 Bot 自己的边界。
 * 主聊天的 workspace URL 白名单不适用于 Bot Skill 中的固定端点（如内部
 * 库、企查查），本形态下不再拦截它们。
 */
export function agentConversationPermission(): DesktopChatPermission {
  return {
    channelPermissionMode: 'full',
    sdkPermissionMode: 'default',
    allowDangerouslySkipPermissions: false,
  }
}
