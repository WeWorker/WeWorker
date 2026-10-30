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
        channelPermissionMode: 'no_bash',
        sdkPermissionMode: 'acceptEdits',
        allowDangerouslySkipPermissions: false,
      }
    case 'ask':
      return {
        channelPermissionMode: 'no_bash',
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
        channelPermissionMode: 'no_bash',
        sdkPermissionMode: 'acceptEdits',
        allowDangerouslySkipPermissions: false,
      }
  }
}
