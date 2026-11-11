import test from 'node:test'
import assert from 'node:assert/strict'
import { configuredChannelIds } from '../utils/channel-configurations.js'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

test('empty defaults do not create robot entries', () => {
  assert.deepEqual(configuredChannelIds(), [])
  assert.deepEqual(configuredChannelIds({ qq: { enabled: false, app_id: '', owner_permission_level: 'qa_only' }, weixin: { base_url: 'https://example.com', has_token: false } }), [])
})

test('legacy disabled robots remain visible from credentials or identity', () => {
  assert.deepEqual(configuredChannelIds({
    qq: { enabled: false, has_app_secret: true },
    feishu: { app_id: 'fixture-app' },
    wecom: { bot_id: 'fixture-bot' },
    weixin: { has_token: true },
  }), ['qq', 'feishu', 'wecom', 'weixin'])
})

test('owner, permission and enabled settings are preserved as existing entries', () => {
  assert.deepEqual(configuredChannelIds({
    qq: { owner_user_id: 'fixture-user' },
    feishu: { enabled: true },
    wecom: { has_secret: true },
    weixin: { owner_permission_level: 'qa_only' },
  }), ['qq', 'feishu', 'wecom'])
})

test('channels page opens on enterprise WeChat by default', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../components/settings/ChannelsTab.jsx', import.meta.url)), 'utf8')
  assert.match(source, /const \[type, setType\] = useState\('wecom'\)/)
})
