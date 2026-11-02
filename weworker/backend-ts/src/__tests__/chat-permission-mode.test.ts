import { describe, expect, it } from 'vitest'
import { resolveDesktopChatPermission } from '../chat-permission-mode.js'

describe('desktop chat permission modes', () => {
  it('asks before edits and disables shell tools', () => {
    expect(resolveDesktopChatPermission('ask')).toEqual({
      channelPermissionMode: 'no_bash',
      sdkPermissionMode: 'default',
      allowDangerouslySkipPermissions: false,
    })
  })

  it('auto-accepts workspace edits while allowing guarded native commands and Adapters', () => {
    expect(resolveDesktopChatPermission('workspace')).toEqual({
      channelPermissionMode: 'workspace',
      sdkPermissionMode: 'acceptEdits',
      allowDangerouslySkipPermissions: false,
    })
  })

  it('keeps the configured workspace as cwd while lifting tool permission checks', () => {
    expect(resolveDesktopChatPermission('full')).toEqual({
      channelPermissionMode: 'full',
      sdkPermissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    })
  })

  it('defaults missing and unknown client values to workspace editing', () => {
    expect(resolveDesktopChatPermission(undefined)).toEqual(resolveDesktopChatPermission('workspace'))
    expect(resolveDesktopChatPermission('unexpected')).toEqual(resolveDesktopChatPermission('workspace'))
  })
})
