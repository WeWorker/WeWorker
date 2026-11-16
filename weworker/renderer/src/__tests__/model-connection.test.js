import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connectionMessage } from '../utils/model-connection.js'

test('connection failures identify the actionable cause rather than claiming protocol incompatibility', () => {
  for (const [error, text] of [['auth_failed', '密钥'], ['timeout', '超时'], ['network_error', '网络'], ['rate_limited', '限流'], ['model_unavailable', '模型']]) {
    const message = connectionMessage({ ok: false, error })
    assert.ok(message.includes(text))
    assert.ok(!message.includes('不支持'))
  }
})
