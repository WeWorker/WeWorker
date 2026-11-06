import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { explorationDevelopmentPermissionSettings, readChatPermissionMode, saveChatPermissionMode } from '../utils/chat-permission-preferences.js'
const originalWindow = globalThis.window
afterEach(() => { globalThis.window = originalWindow })
function storage(values = new Map()) {
  globalThis.window = { localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) } }
  return values
}
test('development defaults to full regardless of the main conversation preference', () => {
  const values = storage()
  for (const mode of ['ask', 'workspace', 'full']) {
    values.set('weworker.chat.permission-mode', mode)
    assert.equal(readChatPermissionMode(), mode)
    assert.equal(readChatPermissionMode(explorationDevelopmentPermissionSettings('new-' + mode)), 'full')
  }
})
test('explicit lower permissions survive reopening and stay scoped to that development', () => {
  const values = storage(new Map([['weworker.chat.permission-mode', 'ask']]))
  const settings = explorationDevelopmentPermissionSettings('manual')
  saveChatPermissionMode('workspace', settings.permissionScope)
  assert.equal(readChatPermissionMode(settings), 'workspace')
  assert.equal(values.get('weworker.chat.permission-mode:' + settings.permissionScope), 'workspace')
  assert.equal(readChatPermissionMode(explorationDevelopmentPermissionSettings('other')), 'full')
  assert.equal(readChatPermissionMode(), 'ask')
})
test('stored scoped mode is restored while invalid values use the scoped default', () => {
  storage(new Map([
    ['weworker.chat.permission-mode:exploration-development:restored', 'ask'],
    ['weworker.chat.permission-mode:exploration-development:invalid', 'invalid'],
  ]))
  assert.equal(readChatPermissionMode(explorationDevelopmentPermissionSettings('restored')), 'ask')
  assert.equal(readChatPermissionMode(explorationDevelopmentPermissionSettings('invalid')), 'full')
})
test('unavailable storage keeps UI and sender preferences consistent in memory', () => {
  globalThis.window = { get localStorage() { throw new Error('Unavailable') } }
  const settings = explorationDevelopmentPermissionSettings('no-storage')
  assert.equal(readChatPermissionMode(settings), 'full')
  saveChatPermissionMode('ask', settings.permissionScope)
  assert.equal(readChatPermissionMode(settings), 'ask')
})
