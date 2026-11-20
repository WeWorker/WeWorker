import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { withModelSettingsNotice } from '../utils/model-settings-notice.js'
import { useNotificationsStore } from '../store/notifications.js'

afterEach(() => useNotificationsStore.setState({ notices: [] }))
const messages = { pending: '检测中', success: '保存成功', failure: '保存失败' }

test('keeps one loading toast until the model check completes, then shows success', async () => {
  let finish
  const action = withModelSettingsNotice(() => new Promise(resolve => { finish = resolve }), messages)
  const pending = useNotificationsStore.getState().notices[0]
  assert.equal(pending.type, 'loading')
  assert.equal(pending.duration, 0)
  finish('saved')
  assert.equal(await action, 'saved')
  const notices = useNotificationsStore.getState().notices
  assert.equal(notices.length, 1)
  assert.equal(notices[0].id, pending.id)
  assert.equal(notices[0].type, 'success')
  assert.equal(notices[0].message, '保存成功')
  assert.ok(notices[0].duration > 0)
})

test('replaces loading with the actual error and keeps the failed action rejected', async () => {
  await assert.rejects(withModelSettingsNotice(async () => { throw new Error('模型不可用') }, messages), /模型不可用/)
  assert.equal(useNotificationsStore.getState().notices[0].type, 'error')
  assert.equal(useNotificationsStore.getState().notices[0].message, '模型不可用')
})

test('does not recreate a loading notice dismissed while a check was running', async () => {
  let finish
  const action = withModelSettingsNotice(() => new Promise(resolve => { finish = resolve }), messages)
  useNotificationsStore.getState().dismiss(useNotificationsStore.getState().notices[0].id)
  finish()
  await action
  assert.deepEqual(useNotificationsStore.getState().notices, [])
})
