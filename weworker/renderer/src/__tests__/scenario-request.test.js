import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { streamChat } from '../api/backend.js'

const originalFetch = global.fetch
const originalWindow = global.window
afterEach(() => { global.fetch = originalFetch; global.window = originalWindow })
const hint = { adapterId: 'example.com', scenarioId: 'lookup', slots: { item: 'example' } }

async function capturedRequest(files = [], modelText = 'lookup example') {
  let body
  global.window = {}
  global.fetch = async (_url, options) => {
    body = JSON.parse(options.body)
    return new Response('data: {"type":"turn_end"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
  }
  await streamChat('fixture', 'lookup example', () => {}, new AbortController().signal, files, 60, modelText, false, 'off', 'workspace', hint)
  return body
}

test('request API sends structured hint only without attachments or model transformation', async () => {
  assert.deepEqual((await capturedRequest()).scenario, hint)
  assert.equal((await capturedRequest([{ path: 'C:/example/file.txt' }])).scenario, undefined)
  assert.equal((await capturedRequest([], 'augmented lookup example')).scenario, undefined)
})
