import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'

it('encrypts every instance, retains legacy saves and persists deletions without resurrection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-channel-fixture-'))
  const home = vi.spyOn(os, 'homedir').mockReturnValue(root)
  vi.resetModules()
  const config = await import('../config.js')
  const { setMasterKeyForTests } = await import('../secret-store.js')
  const { changeChannelConfiguration } = await import('../channels/channel-configurations.js')
  setMasterKeyForTests('0123456789abcdef0123456789abcdef')
  try {
    let state = config.getSettings()
    state = config.updateSettings({ channels: { ...state.channels, qq: { ...state.channels.qq, enabled: true, app_id: 'fixture-app', app_secret: 'fixture-legacy-secret' } } })
    const legacy = state.active_channel_configurations!.qq!
    const second = changeChannelConfiguration(state, 'qq', 'add')
    state = config.updateSettings(second.updates)
    state = config.updateSettings(changeChannelConfiguration(state, 'qq', 'save', second.id, { app_id: 'fixture-two', app_secret: 'fixture-two-secret' }).updates)
    state = config.updateSettings(changeChannelConfiguration(state, 'qq', 'activate', second.id).updates)
    state = config.updateSettings({ channels: { ...state.channels, qq: { ...state.channels.qq, owner_user_id: 'fixture-owner' } } })
    expect(state.channel_configurations![second.id].config.owner_user_id).toBe('fixture-owner')
    const diskPath = path.join(root, '.weworker', 'settings.json')
    const raw = fs.readFileSync(diskPath, 'utf8')
    expect(raw).not.toContain('fixture-legacy-secret')
    expect(raw).not.toContain('fixture-two-secret')
    config.resetSettingsStateForTests()
    state = config.getSettings()
    expect(state.channels.qq.app_secret).toBe('fixture-two-secret')
    expect((state.channel_configurations![legacy].config as typeof state.channels.qq).app_secret).toBe('fixture-legacy-secret')
    state = config.updateSettings(changeChannelConfiguration(state, 'qq', 'delete', legacy).updates)
    state = config.updateSettings(changeChannelConfiguration(state, 'qq', 'delete', second.id).updates)
    config.resetSettingsStateForTests()
    state = config.getSettings()
    expect(state.channels.qq.enabled).toBe(false)
    expect(state.channels.qq.app_secret).toBe('')
    expect(state.channel_configurations).toEqual({})
    expect(state.active_channel_configurations).toEqual({})
    expect(fs.readFileSync(diskPath, 'utf8')).not.toContain(second.id)
  } finally { home.mockRestore(); setMasterKeyForTests(null); config.resetSettingsStateForTests(); vi.resetModules() }
})

it('persists WeCom pairing across restart and leaves the owner unbound when saving fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-pairing-fixture-'))
  const home = vi.spyOn(os, 'homedir').mockReturnValue(root)
  vi.resetModules()
  const config = await import('../config.js')
  const { setMasterKeyForTests } = await import('../secret-store.js')
  const { changeChannelConfiguration } = await import('../channels/channel-configurations.js')
  const { createWecomOwnerPairing } = await import('../channels/wecom-owner-pairing.js')
  setMasterKeyForTests('0123456789abcdef0123456789abcdef')
  let writer: ReturnType<typeof vi.spyOn> | undefined
  try {
    const identity = { bot_id: 'fixture-bot', secret: 'fixture-secret', enabled: true }
    const added = changeChannelConfiguration(config.getSettings(), 'wecom', 'add')
    config.updateSettings(added.updates)
    let state = config.updateSettings(changeChannelConfiguration(config.getSettings(), 'wecom', 'save', added.id, identity).updates)
    const code = state.channels.wecom.pairing_code
    config.resetSettingsStateForTests()
    expect(config.getSettings().channels.wecom.pairing_code).toBe(code)
    const authorize = createWecomOwnerPairing(identity)
    const original = fs.writeFileSync
    writer = vi.spyOn(fs, 'writeFileSync').mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
      if (String(args[0]).endsWith('settings.json')) throw new Error('fixture write failure')
      return original(...args)
    })
    expect(authorize('fixture-owner', `绑定 ${code}`, 'single')).toMatchObject({ kind: 'reply', text: expect.stringContaining('失败') })
    expect(config.getSettings().channels.wecom.owner_user_id).toBe('')
    writer.mockRestore()
    expect(authorize('fixture-owner', `绑定 ${code}`, 'single')).toMatchObject({ ownerPaired: true })
    config.resetSettingsStateForTests()
    state = config.getSettings()
    expect(state.channels.wecom).toMatchObject({ owner_user_id: 'fixture-owner', owner_permission_level: 'full', pairing_code: '', secret: 'fixture-secret' })
    expect(state.channel_configurations![added.id].config.owner_user_id).toBe('fixture-owner')
  } finally { writer?.mockRestore(); home.mockRestore(); setMasterKeyForTests(null); config.resetSettingsStateForTests(); vi.resetModules() }
})
