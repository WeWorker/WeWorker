import test from 'node:test'
import assert from 'node:assert/strict'
import { useSettingsStore } from '../store/settings.js'
import { requestChannelProbe } from '../utils/channel-probe.js'

globalThis.window = {}
const profile = (id, type, app = '') => ({ id, type, name: id, config: { app_id: app, enabled: false } })
function setup(t) {
  const previous = useSettingsStore.getState()
  t.after(() => useSettingsStore.setState(previous, true))
  useSettingsStore.setState({ channelProfileQrPending: {}, channelProfileQrSaving: {}, channels: {
    configurations: { first: profile('first', 'qq', 'fixture-old'), second: profile('second', 'qq'), other: profile('other', 'feishu') }, active_ids: { qq: 'first' },
  } })
}

test('QR retry stays bound to its original profile and never uses another robot credentials', async t => {
  setup(t)
  let failed = true
  const requests = []
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body)
    return failed ? Response.json({}, { status: 503 }) : Response.json({ qq: { enabled: true }, configurations: { second: profile('second', 'qq', 'fixture-new') }, active_ids: { qq: 'second' } })
  })
  const credentials = { app_id: 'fixture-new', app_secret: 'fixture-secret' }
  await assert.rejects(useSettingsStore.getState().saveChannelProfileQr('second', credentials), /重试保存/)
  assert.deepEqual(useSettingsStore.getState().channelProfileQrPending.second, credentials)
  assert.equal(useSettingsStore.getState().channelProfileQrPending.first, undefined)
  failed = false
  await useSettingsStore.getState().saveChannelProfileQr('second')
  assert.ok(requests.every(body => body.id === 'second' && body.channel === 'qq'))
  assert.ok(requests.every(body => body.action === 'qr-import'))
  assert.equal(requests[1].config.owner_permission_level, 'qa_only')
  assert.equal(useSettingsStore.getState().channelProfileQrPending.second, null)
  assert.ok(useSettingsStore.getState().channels.configurations.other)
})

test('scanning cannot overwrite an existing robot or leave replacement credentials pending', async t => {
  setup(t)
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; return Response.json({}) })
  const before = useSettingsStore.getState().channels
  await assert.rejects(useSettingsStore.getState().saveChannelProfileQr('first', { app_id: 'fixture-new', app_secret: 'fixture-secret' }), /已关联机器人/)
  assert.equal(requests, 0)
  assert.equal(useSettingsStore.getState().channels, before)
  assert.equal(useSettingsStore.getState().channelProfileQrPending.first, undefined)
})

test('out of order responses for different types cannot drop each other profiles', async t => {
  setup(t)
  const replies = {}
  t.mock.method(globalThis, 'fetch', (_url, options) => new Promise(resolve => { replies[JSON.parse(options.body).channel] = resolve }))
  const qq = useSettingsStore.getState().channelProfileAction('qq', 'delete', 'first')
  const feishu = useSettingsStore.getState().channelProfileAction('feishu', 'add')
  await new Promise(resolve => setImmediate(resolve))
  replies.feishu(Response.json({ configurations: { other: profile('other', 'feishu'), third: profile('third', 'feishu'), first: profile('first', 'qq') }, active_ids: {} }))
  await feishu
  replies.qq(Response.json({ configurations: { second: profile('second', 'qq'), other: profile('other', 'feishu') }, active_ids: {} }))
  await qq
  assert.deepEqual(Object.keys(useSettingsStore.getState().channels.configurations).sort(), ['other', 'second', 'third'])
})

test('connectivity tests carry the exact profile ID for masked credential lookup', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body)
    assert.equal(body.profile_id, 'second')
    assert.equal(body.config.app_secret, '')
    return Response.json({ ok: true, checks: [{ status: 'success', label: '平台验证', message: '通过' }] })
  })
  await requestChannelProbe('qq', { profile_id: 'second', app_id: 'fixture-app' })
})

test('deleting a robot clears its failed QR import from memory', async t => {
  setup(t)
  useSettingsStore.setState({ channelProfileQrPending: { second: { app_secret: 'fixture-pending-secret' } }, channelProfileQrSaving: { second: false } })
  t.mock.method(globalThis, 'fetch', async () => Response.json({ configurations: {}, active_ids: {} }))
  await useSettingsStore.getState().channelProfileAction('qq', 'delete', 'second')
  assert.equal(useSettingsStore.getState().channelProfileQrPending.second, undefined)
  assert.equal(useSettingsStore.getState().channelProfileQrSaving.second, undefined)
})

test('binding refresh updates only owner state and preserves another robot configuration', async t => {
  setup(t)
  const saved = { id: 'main', type: 'wecom', name: 'Fixture', config: { bot_id: 'fixture-bot', enabled: true, has_secret: true, pairing_code: '123456', owner_user_id: '', owner_permission_level: 'qa_only' } }
  useSettingsStore.setState({ channels: { configurations: { main: saved, other: profile('other', 'qq') }, active_ids: { wecom: 'main' }, wecom: saved.config } })
  t.mock.method(globalThis, 'fetch', async () => Response.json({ configurations: { main: { ...saved, config: { ...saved.config, owner_user_id: 'fixture-owner', pairing_code: '' } } }, active_ids: { wecom: 'main' } }))
  await useSettingsStore.getState().refreshChannelOwnerBinding('main')
  assert.equal(useSettingsStore.getState().channels.configurations.main.config.owner_user_id, 'fixture-owner')
  assert.equal(useSettingsStore.getState().channels.configurations.main.config.pairing_code, '')
  assert.equal(useSettingsStore.getState().channels.wecom.owner_user_id, 'fixture-owner')
  assert.ok(useSettingsStore.getState().channels.configurations.other)
})

test('a delayed binding poll cannot overwrite a newer save or restore a deleted profile', async t => {
  setup(t)
  const saved = { id: 'main', type: 'wecom', name: 'Fixture', config: { bot_id: 'fixture-bot', pairing_code: '123456' } }
  useSettingsStore.setState({ channels: { configurations: { main: saved }, active_ids: { wecom: 'main' } } })
  let reply
  t.mock.method(globalThis, 'fetch', async () => new Promise(resolve => { reply = resolve }))
  const polling = useSettingsStore.getState().refreshChannelOwnerBinding('main')
  await new Promise(resolve => setImmediate(resolve))
  const newer = { ...saved, config: { ...saved.config, pairing_code: '654321' } }
  useSettingsStore.setState({ channels: { configurations: { main: newer }, active_ids: { wecom: 'main' } } })
  reply(Response.json({ configurations: { main: saved } }))
  await polling
  assert.equal(useSettingsStore.getState().channels.configurations.main.config.pairing_code, '654321')
  const deletedPoll = useSettingsStore.getState().refreshChannelOwnerBinding('main')
  await new Promise(resolve => setImmediate(resolve))
  useSettingsStore.setState({ channels: { configurations: {}, active_ids: {} } })
  reply(Response.json({ configurations: { main: saved } }))
  await deletedPoll
  assert.equal(useSettingsStore.getState().channels.configurations.main, undefined)
})
