import { expect, it } from 'vitest'
import type { Settings } from '../config.js'
import { changeChannelConfiguration, createChannelMutationQueue, emptyChannel, migrateChannelConfigurations, publicChannelSettings, type ChannelType } from '../channels/channel-configurations.js'
import { applySecrets, clearSecretsOnDisk, extractSecrets } from '../settings-secrets.js'

function initial(): Settings {
  return { channels: Object.fromEntries(['qq', 'feishu', 'wecom', 'weixin'].map(type => [type, emptyChannel(type as ChannelType)])) } as unknown as Settings
}
const credentials = (type: ChannelType) => type === 'weixin' ? { token: 'fixture-token' } : type === 'wecom' ? { bot_id: 'fixture-bot', secret: 'fixture-secret' } : { app_id: 'fixture-app', app_secret: 'fixture-secret' }

it('migrates disabled legacy robots once without losing credentials or permissions', () => {
  const state = initial()
  state.channels.qq = { ...state.channels.qq, app_id: 'fixture-app', app_secret: 'fixture-secret', owner_user_id: 'fixture-owner', owner_permission_level: 'full' }
  const migrated = migrateChannelConfigurations(state)
  expect(migrated.channel_configurations!['legacy-qq']).toMatchObject({ name: 'QQ(1)', config: state.channels.qq })
  expect(migrateChannelConfigurations(migrated)).toBe(migrated)
  expect(state.channel_configurations).toBeUndefined()
})

for (const type of ['qq', 'feishu', 'wecom', 'weixin'] as ChannelType[]) {
  it(`${type}: independent drafts, exclusive activation, rename and deletion`, () => {
    let state = initial()
    const first = changeChannelConfiguration(state, type, 'add')
    state = { ...state, ...first.updates }
    state = { ...state, ...changeChannelConfiguration(state, type, 'save', first.id, { ...credentials(type), enabled: true }).updates }
    const second = changeChannelConfiguration(state, type, 'add')
    state = { ...state, ...second.updates }
    expect(state.channel_configurations![second.id].config).toEqual(emptyChannel(type))
    expect(state.active_channel_configurations![type]).toBe(first.id)
    expect(() => changeChannelConfiguration(state, type, 'activate', second.id)).toThrow('凭证')
    state = { ...state, ...changeChannelConfiguration(state, type, 'save', second.id, { ...credentials(type) }).updates }
    expect(state.active_channel_configurations![type]).toBe(first.id)
    state = { ...state, ...changeChannelConfiguration(state, type, 'activate', second.id).updates }
    expect(state.channel_configurations![first.id].config.enabled).toBe(false)
    expect(state.channel_configurations![second.id].config.enabled).toBe(true)
    state = { ...state, ...changeChannelConfiguration(state, type, 'rename', second.id, { name: '工作机器人' }).updates }
    expect(state.channel_configurations![second.id].name).toBe('工作机器人')
    const key = type === 'weixin' ? 'token' : type === 'wecom' ? 'secret' : 'app_secret'
    state = { ...state, ...changeChannelConfiguration(state, type, 'save', second.id, { [key]: '' }).updates }
    expect((state.channel_configurations![second.id].config as any)[key]).toBe(credentials(type)[key])
    const secrets = extractSecrets(state)
    expect(JSON.stringify(clearSecretsOnDisk(state))).not.toContain('fixture-secret')
    const restored = applySecrets(clearSecretsOnDisk(state), secrets)
    expect(restored.channel_configurations).toEqual(state.channel_configurations)
    const visible = JSON.stringify(publicChannelSettings(state))
    expect(visible).not.toContain('fixture-secret')
    expect(visible).not.toContain('fixture-token')
    state = { ...state, ...changeChannelConfiguration(state, type, 'delete', first.id).updates }
    expect(state.channels[type].enabled).toBe(true)
    state = { ...state, ...changeChannelConfiguration(state, type, 'delete', second.id).updates }
    expect(state.channels[type]).toEqual(emptyChannel(type))
    expect(Object.values(state.channel_configurations!)).toHaveLength(0)
    expect(state.active_channel_configurations![type]).toBeUndefined()
  })
}

it('rejects stale QR targets and cross-type edits, and defaults ownerless grants to QA', () => {
  let state = initial()
  const entry = changeChannelConfiguration(state, 'qq', 'add')
  state = { ...state, ...entry.updates }
  expect(() => changeChannelConfiguration(state, 'feishu', 'save', entry.id, credentials('feishu'))).toThrow('类型')
  expect(() => changeChannelConfiguration(state, 'qq', 'save', '__proto__', credentials('qq'))).toThrow('不存在')
  state = { ...state, ...changeChannelConfiguration(state, 'qq', 'save', entry.id, { ...credentials('qq'), owner_permission_level: 'full' }).updates }
  expect(state.channel_configurations![entry.id].config.owner_permission_level).toBe('qa_only')
  state = { ...state, ...changeChannelConfiguration(state, 'qq', 'delete', entry.id).updates }
  expect(() => changeChannelConfiguration(state, 'qq', 'save', entry.id, credentials('qq'))).toThrow('不存在')
})

it('serializes asynchronous mutations and recovers after a rejected operation', async () => {
  const queue = createChannelMutationQueue()
  const events: string[] = []
  let finish!: () => void
  const first = queue('settings', async () => { events.push('stop'); await new Promise<void>(resolve => { finish = resolve }); events.push('start') })
  const second = queue('settings', async () => { events.push('next'); throw new Error('fixture-failure') })
  const rejected = expect(second).rejects.toThrow('fixture-failure')
  const third = queue('settings', async () => events.push('recovered'))
  await new Promise(resolve => setImmediate(resolve))
  expect(events).toEqual(['stop'])
  finish()
  await first; await rejected; await third
  expect(events).toEqual(['stop', 'start', 'next', 'recovered'])
})

it.each(['wecom', 'qq', 'feishu'] as ChannelType[])('%s: QR imports cannot replace a saved robot and new profiles retain the old one', type => {
  let state = initial()
  const first = changeChannelConfiguration(state, type, 'add')
  state = { ...state, ...first.updates }
  state = { ...state, ...changeChannelConfiguration(state, type, 'save', first.id, { ...credentials(type), enabled: true }).updates }
  const identity = type === 'wecom' ? 'bot_id' : 'app_id'
  const replacement = { ...credentials(type), [identity]: 'fixture-new-bot', enabled: true }
  const original = structuredClone(state)
  expect(() => changeChannelConfiguration(state, type, 'qr-import', first.id, replacement)).toThrow('已关联机器人')
  expect(state).toEqual(original)
  const second = changeChannelConfiguration(state, type, 'add')
  state = { ...state, ...second.updates }
  state = { ...state, ...changeChannelConfiguration(state, type, 'qr-import', second.id, replacement).updates }
  expect(Object.keys(state.channel_configurations!)).toHaveLength(2)
  expect(state.channel_configurations![first.id].config).toMatchObject({ ...credentials(type), enabled: false })
  expect(state.active_channel_configurations![type]).toBe(second.id)
  // A retry after a lost response must remain idempotent.
  expect(changeChannelConfiguration(state, type, 'qr-import', second.id, replacement).updates.channel_configurations).toEqual(state.channel_configurations)
})

it('issues an independent WeCom binding code after credentials are saved', () => {
  let state = initial()
  const first = changeChannelConfiguration(state, 'wecom', 'add')
  state = { ...state, ...first.updates }
  state = { ...state, ...changeChannelConfiguration(state, 'wecom', 'save', first.id, { ...credentials('wecom'), enabled: true }).updates }
  const firstCode = state.channels.wecom.pairing_code
  expect(firstCode).toMatch(/^\d{6}$/)
  state = { ...state, ...changeChannelConfiguration(state, 'wecom', 'pair', first.id).updates }
  expect(state.channels.wecom.pairing_code).toBe(firstCode)
  const second = changeChannelConfiguration(state, 'wecom', 'add')
  state = { ...state, ...second.updates }
  state = { ...state, ...changeChannelConfiguration(state, 'wecom', 'save', second.id, { bot_id: 'other-fixture-bot', secret: 'fixture-secret', enabled: true }).updates }
  expect(state.channels.wecom.pairing_code).toMatch(/^\d{6}$/)
  expect(state.channel_configurations![first.id].config).toMatchObject({ pairing_code: firstCode, enabled: false })
  expect(() => changeChannelConfiguration(state, 'wecom', 'pair', first.id)).toThrow('启用')
})

it('keeps the bound owner when a stale form saves, and resets on explicit re-pair or bot replacement', () => {
  let state = initial()
  state.channels.wecom = { ...state.channels.wecom, ...credentials('wecom'), enabled: true, owner_user_id: 'fixture-owner', owner_permission_level: 'full', pairing_code: '' }
  state = migrateChannelConfigurations(state)
  const id = state.active_channel_configurations!.wecom!
  state = { ...state, ...changeChannelConfiguration(state, 'wecom', 'save', id, { owner_user_id: '', pairing_code: '111111' }).updates }
  expect(state.channels.wecom).toMatchObject({ owner_user_id: 'fixture-owner', owner_permission_level: 'full', pairing_code: '' })
  expect(changeChannelConfiguration(state, 'wecom', 'pair', id).updates.channels.wecom.owner_user_id).toBe('fixture-owner')
  const reset = changeChannelConfiguration(state, 'wecom', 're-pair', id)
  expect(reset.updates.channels.wecom).toMatchObject({ owner_user_id: '', owner_permission_level: 'qa_only' })
  expect(reset.updates.channels.wecom.pairing_code).toMatch(/^\d{6}$/)
  const replaced = changeChannelConfiguration(state, 'wecom', 'save', id, { bot_id: 'replacement-fixture-bot' })
  expect(replaced.updates.channels.wecom.owner_user_id).toBe('')
  expect(replaced.updates.channels.wecom.pairing_code).toMatch(/^\d{6}$/)
})

it('does not generate codes for incomplete or non-WeCom configurations', () => {
  let state = initial()
  const draft = changeChannelConfiguration(state, 'wecom', 'add')
  state = { ...state, ...draft.updates }
  expect(() => changeChannelConfiguration(state, 'wecom', 'pair', draft.id)).toThrow()
  const qq = changeChannelConfiguration(state, 'qq', 'add')
  state = { ...state, ...qq.updates }
  expect(() => changeChannelConfiguration(state, 'qq', 'pair', qq.id)).toThrow()
})
