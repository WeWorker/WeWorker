import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { saveFormattedBody } from '../formatted-body.js'

test('body snapshot is a UTF-8 args-file with exact HTML and Markdown and no extra keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'formatted-body-test-'))
  const body = { content: '<ul><li>Sample 中文</li></ul>', 'markdown-content': '- Sample 中文\n', __confirmed: true, path: '../bad' }
  const first = saveFormattedBody(body, dir)
  const second = saveFormattedBody(body, dir)
  assert.notEqual(first.path, second.path)
  assert.equal(path.dirname(first.path), dir)
  assert.deepEqual(JSON.parse(fs.readFileSync(first.path, 'utf8')), { content: body.content, 'markdown-content': body['markdown-content'] })
  for (const invalid of [null, {}, { content: '', 'markdown-content': 'x' }, { content: 'x', 'markdown-content': 123 }, { content: 'x'.repeat(2 * 1024 * 1024), 'markdown-content': 'x' }]) {
    assert.throws(() => saveFormattedBody(invalid, dir))
  }
  // Only remove the exact files created by this test, without recursive deletion.
  fs.unlinkSync(first.path); fs.unlinkSync(second.path); fs.rmdirSync(dir)
})
