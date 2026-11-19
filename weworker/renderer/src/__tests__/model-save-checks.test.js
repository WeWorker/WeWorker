import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runModelSaveChecks } from '../utils/model-save-checks.js'

const checks = [{ target: 'weworker', label: '对话' }, { target: 'webwright', label: '探索' }]

test('shows running checks then uses the save response without another probe', async () => {
  const updates = []
  let resolve
  let requests = 0
  const run = runModelSaveChecks(() => { requests++; return new Promise(done => { resolve = done }) }, checks, value => updates.push(value))
  assert.deepEqual(updates[0].map(item => item.status), ['running', 'running'])
  resolve({ model_checks: checks.map(check => ({ target: check.target, status: 'success', message: '已连接' })) })
  await run
  assert.equal(requests, 1)
  assert.deepEqual(updates[1].map(item => item.status), ['success', 'success'])
})

test('retains the successful interface and displays the failing interface on rejected save', async () => {
  const error = Object.assign(new Error('探索失败'), { modelChecks: [
    { target: 'weworker', status: 'success', message: '已连接' },
    { target: 'webwright', status: 'failure', message: '鉴权失败' },
  ] })
  let latest
  await assert.rejects(runModelSaveChecks(() => Promise.reject(error), checks, value => { latest = value }), /探索失败/)
  assert.deepEqual(latest.map(item => item.status), ['success', 'failure'])
  assert.equal(latest[1].message, '鉴权失败')
})

test('marks an unreached check skipped instead of showing success on a transport failure', async () => {
  let latest
  await assert.rejects(runModelSaveChecks(() => Promise.reject(new Error('网络断开')), checks, value => { latest = value }), /网络断开/)
  assert.deepEqual(latest.map(item => item.status), ['failure', 'skipped'])
})
