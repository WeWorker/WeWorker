import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { showNotification, useNotificationsStore } from '../store/notifications.js'

afterEach(() => useNotificationsStore.setState({ notices: [] }))

test('repeated errors remain independently dismissible and preserve other notices', () => {
  const first = showNotification('示例错误', { type: 'error' })
  const second = showNotification('示例错误', { type: 'error' })
  const success = showNotification('已保存', { type: 'success' })
  useNotificationsStore.getState().dismiss(first)
  useNotificationsStore.getState().dismiss(first)
  assert.deepEqual(useNotificationsStore.getState().notices.map((notice) => notice.id), [second, success])
  assert.equal(useNotificationsStore.getState().notices[1].type, 'success')
})

test('bursts of notifications keep a bounded stack with the newest warning visible', () => {
  for (let i = 0; i < 6; i++) showNotification(`示例消息 ${i}`)
  const warning = showNotification('需要处理', { type: 'warning', duration: 0 })
  const notices = useNotificationsStore.getState().notices
  assert.equal(notices.length, 3)
  assert.equal(notices.at(-1).id, warning)
  assert.equal(notices.at(-1).duration, 0)
  assert.deepEqual(notices.map((notice) => notice.message), ['示例消息 4', '示例消息 5', '需要处理'])
})
