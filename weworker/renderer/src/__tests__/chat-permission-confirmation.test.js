import test from 'node:test'
import assert from 'node:assert/strict'
import { confirmChatPermissionMode } from '../utils/chat-permission-confirmation.js'

test('workspace and ask modes do not request elevated-permission confirmation', async () => {
  let calls = 0
  const confirm = async () => { calls += 1; return true }
  assert.equal(await confirmChatPermissionMode('workspace', confirm), true)
  assert.equal(await confirmChatPermissionMode('ask', confirm), true)
  assert.equal(calls, 0)
})

test('full mode explains unrestricted access and requires explicit confirmation', async () => {
  let args
  const confirm = async (...values) => { args = values; return false }
  assert.equal(await confirmChatPermissionMode('full', confirm), false)
  assert.match(args[0], /工作区外/)
  assert.match(args[0], /本机命令/)
  assert.equal(args[1], '启用完全权限')
  assert.deepEqual(args[2], { danger: true })
})
