import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { cancelActiveQrForModelSwitch, registerModelSwitchCanceler } from '../utils/model-switch-cancel.js'

test('model switch waits for active QR sessions to cancel and unregisters completed sessions', async () => {
  const calls = []
  const unregister = registerModelSwitchCanceler(async () => { calls.push('cancel'); await Promise.resolve(); calls.push('done') })
  await cancelActiveQrForModelSwitch()
  assert.deepEqual(calls, ['cancel', 'done'])
  unregister()
  await cancelActiveQrForModelSwitch()
  assert.deepEqual(calls, ['cancel', 'done'])
})

test('chat and settings model changes cancel QR sessions before switching', () => {
  const selector = fs.readFileSync(new URL('../components/chat/ModelSelector.jsx', import.meta.url), 'utf8')
  const settings = fs.readFileSync(new URL('../components/settings/SettingsModal.jsx', import.meta.url), 'utf8')
  assert.match(selector, /await cancelActiveQrForModelSwitch\(\)[\s\S]*?await activateProvider\(value\)/)
  assert.match(settings, /await cancelActiveQrForModelSwitch\(\)[\s\S]*?await activateProvider\(pid\)/)
})

test('WeChat QR cancellation invalidates only its matching backend session', () => {
  const server = fs.readFileSync(new URL('../../../backend-ts/src/server.ts', import.meta.url), 'utf8')
  assert.match(server, /app\.post\('\/settings\/weixin\/qr-cancel'[\s\S]*?cancelWeixinQrSession\(_weixinQrState, req\.body\?\.session_id\)/)
})
