import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileChangeToolState, fileChangeEntries, fileChangeTotals, fileChangeLabel, fileChangeName } from '../utils/file-changes.js'

test('collects only mutation candidates and keeps each tool call associated with its message', () => {
  const content = [
    { type: 'text', text: 'Edited example.txt' },
    { type: 'tool_use', id: 'read', name: 'Read', status: 'done' },
    { type: 'tool_use', id: 'edit', name: 'Edit', status: 'done' },
    { type: 'tool_use', id: 'shell', name: 'mcp__weworker__weworker_powershell', status: 'running' },
  ]
  assert.deepEqual(JSON.parse(fileChangeToolState(content)), [['edit', 'done'], ['shell', 'running']])
  assert.equal(fileChangeToolState([{ type: 'text', text: 'pretend Write changed a file' }]), '[]')
})

test('preserves repeated edits as distinct historical versions with cumulative counts', () => {
  const records = [
    { id: 'first', status: 'completed', files: [{ path: '/example/report.txt', added: 2, removed: 1 }] },
    { id: 'second', status: 'failed', files: [{ path: '/example/report.txt', added: 1, removed: 2 }, { path: '/example/new.txt', added: 3, removed: 0 }] },
  ]
  assert.deepEqual(fileChangeTotals(records), { files: 2, edits: 3, added: 6, removed: 3 })
  assert.deepEqual(fileChangeEntries(records).map(entry => [entry.recordId, entry.fileIndex]), [['first', 0], ['second', 0], ['second', 1]])
})

test('uses compact file names and explicit operation labels without guessing missing types', () => {
  assert.equal(fileChangeName('C:\\example\\workspace\\report.txt'), 'report.txt')
  assert.equal(fileChangeName('/example/site/style.css'), 'style.css')
  assert.equal(fileChangeLabel('create'), '新建')
  assert.equal(fileChangeLabel('edit'), '编辑')
  assert.equal(fileChangeLabel('delete'), '删除')
  assert.equal(fileChangeLabel(undefined), '待确认')
})
