import { describe, expect, it } from 'vitest'
import { resolveDesktopChatPermission } from '../chat-permission-mode.js'
import { createWeWorkerToolPolicy } from '../agent-tool-policy.js'

describe('desktop chat permission modes', () => {
  it('keeps native commands available for per-operation confirmation', async () => {
    expect(resolveDesktopChatPermission('ask')).toEqual({
      channelPermissionMode: 'ask',
      sdkPermissionMode: 'default',
      allowDangerouslySkipPermissions: false,
    })
    const policy = createWeWorkerToolPolicy(resolveDesktopChatPermission('ask').channelPermissionMode)
    for (const command of ['npm test', 'webcli call example.com.read', 'webcli call example-toolkit.list']) {
      await expect(policy('PowerShell', { command }, {} as never)).resolves.toMatchObject({ behavior: 'allow' })
    }
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
