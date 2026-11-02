import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { submitUserChoice } from '../api/backend.js'

const originalFetch = globalThis.fetch
const originalWindow = globalThis.window
afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalWindow === undefined) delete globalThis.window
  else globalThis.window = originalWindow
})

test('sends the exact displayed choice id with the confirmation answer', async () => {
  globalThis.window = {}
  let request
  globalThis.fetch = async (url, options) => {
    request = { url, body: JSON.parse(options.body) }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }
  assert.deepEqual(await submitUserChoice('fixture-work', '允许本次', 'permission-current'), { ok: true })
  assert.deepEqual(request, {
    url: 'http://127.0.0.1:8765/works/fixture-work/user-choice',
    body: { answer: '允许本次', choiceId: 'permission-current' },
  })
})

test('rejects stale confirmations so the UI cannot mark them successfully answered', async () => {
  globalThis.window = {}
  globalThis.fetch = async () => new Response(JSON.stringify({ detail: 'No pending choice for this work' }), { status: 404 })
  await assert.rejects(submitUserChoice('fixture-work', '允许本次', 'permission-old'), /No pending choice/)
})
