import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connectionMessage, explorationForm } from '../utils/model-connection.js'

test('connection failures identify the actionable cause rather than claiming protocol incompatibility', () => {
  for (const [error, text] of [['auth_failed', '密钥'], ['timeout', '超时'], ['network_error', '网络'], ['rate_limited', '限流'], ['model_unavailable', '模型']]) {
    const message = connectionMessage({ ok: false, error })
    assert.ok(message.includes(text))
    assert.ok(!message.includes('不支持'))
  }
})

test('the restored form distinguishes the saved exploration address from the active conversation endpoint', () => {
  assert.deepEqual(explorationForm({ base_url: 'https://example.com/messages', base_url_is_full: true,
    configured_base_url: '', configured_base_url_is_full: false, candidate_url: 'https://example.org/v1', main_model: 'main-model' }), {
    base_url: 'https://example.org/v1', base_url_is_full: false, use_main_key: true, model: '', api_key: '',
  })
  assert.deepEqual(explorationForm({ configured_base_url: 'https://example.org/infer/?version=1', configured_base_url_is_full: true,
    configured_model: 'explore-model', use_main_key: false }), {
    base_url: 'https://example.org/infer/?version=1', base_url_is_full: true, model: 'explore-model', use_main_key: false, api_key: '',
  })
})
