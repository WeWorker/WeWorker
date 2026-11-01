import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { showAlert, showConfirm, useDialogStore } from '../store/dialog.js'

afterEach(() => useDialogStore.setState({ queue: [] }))

test('danger confirmation keeps cancellation semantics and does not leak into the next dialog', async () => {
  const deletion = showConfirm('删除示例任务？', '删除任务', { danger: true })
  const ordinary = showConfirm('继续操作？')
  assert.equal(useDialogStore.getState().queue[0].danger, true)
  useDialogStore.getState().resolve(false)
  assert.equal(await deletion, false)
  assert.equal(useDialogStore.getState().queue[0].danger, false)
  useDialogStore.getState().resolve(true)
  assert.equal(await ordinary, true)
  assert.deepEqual(useDialogStore.getState().queue, [])
})

test('ordinary alerts and existing confirmation callers remain non-destructive', async () => {
  const alert = showAlert('示例提示')
  const confirm = showConfirm('继续？', '请确认')
  assert.equal(useDialogStore.getState().queue[0].kind, 'alert')
  assert.notEqual(useDialogStore.getState().queue[0].danger, true)
  useDialogStore.getState().resolve(true)
  assert.equal(await alert, true)
  assert.equal(useDialogStore.getState().queue[0].title, '请确认')
  assert.equal(useDialogStore.getState().queue[0].danger, false)
  useDialogStore.getState().resolve(false)
  assert.equal(await confirm, false)
})
