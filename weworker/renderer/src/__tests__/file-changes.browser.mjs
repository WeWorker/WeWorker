// Isolated UI fixture: no model calls, real files, or desktop control.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createServer } from 'vite'
const require = createRequire(import.meta.url)
const { chromium } = require('playwright-core')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-file-change-ui-'))
const server = await createServer({ root: fileURLToPath(new URL('../..', import.meta.url)), cacheDir: path.join(directory, 'vite'), server: { host: '127.0.0.1', port: 5190, strictPort: false, hmr: false, ws: false, watch: null } })
const records = [
  { id: 'title-record', toolCallId: 'edit-title', tool: 'Write', status: 'completed', startedAt: '2026-11-13T10:00:00Z', files: [{ path: '/example/site/title.txt', operation: 'create', added: 1, removed: 0 }], fileCount: 1, added: 1, removed: 0 },
  { id: 'style-record', toolCallId: 'edit-style', tool: 'Edit', status: 'completed', startedAt: '2026-11-13T10:00:10Z', files: [{ path: '/example/site/style.css', operation: 'edit', added: 1, removed: 1 }], fileCount: 1, added: 1, removed: 1 },
]
let browser
try {
  await server.listen()
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 } })
  const errors = [], mutations = []
  let failDetail = false
  page.on('pageerror', error => errors.push(error.message))
  await page.route('http://127.0.0.1:8765/**', async route => {
    const request = route.request(), url = new URL(request.url())
    if (request.method() !== 'GET') mutations.push(request.method())
    if (url.pathname.includes('/other-work/')) return route.fulfill({ json: { records: [] } })
    if (url.pathname.endsWith('/file-changes')) return route.fulfill({ json: { records, total: 2, nextOffset: null } })
    const record = records.find(record => url.pathname.endsWith('/' + record.id))
    if (record) {
      if (failDetail) return route.fulfill({ status: 500, json: { detail: 'Example failure' } })
      const created = record.files[0].operation === 'create'
      const before = created ? '' : 'gap: 20px;'
      const after = record.id === 'title-record' ? 'title: Updated title' : 'gap: 12px;'
      return route.fulfill({ json: { ...record, fileIndex: 0, file: { ...record.files[0], before: created ? { state: 'missing' } : { state: 'text', text: before }, after: { state: 'text', text: after } }, diff: { added: 1, removed: created ? 0 : 1, rows: [
        ...(created ? [] : [{ kind: 'remove', beforeLine: 1, text: before }]), { kind: 'add', afterLine: 1, text: after },
      ] } } })
    }
    return route.fulfill({ json: {} })
  })
  const url = `http://127.0.0.1:${server.httpServer.address().port}/src/__tests__/fixtures/file-changes.html`
  await page.goto(url)
  assert.equal(await page.title(), 'File changes fixture')
  const card = page.getByRole('region', { name: '文件修改记录' })
  await card.waitFor()
  assert.match(await card.innerText(), /2 个文件/)
  assert.equal(await card.getByText('新建', { exact: true }).count(), 1)
  assert.equal(await card.getByText('编辑', { exact: true }).count(), 1)
  assert.equal((await card.innerText()).includes('/example/site'), false)
  assert.equal(await page.getByRole('button', { name: /撤回|撤销|Undo|恢复/ }).count(), 0)
  await page.screenshot({ path: path.join(directory, 'card.png') })
  await card.getByRole('button', { name: '查看修改', exact: true }).click()
  const panel = page.getByRole('complementary', { name: '修改前后对比' })
  await panel.getByText('title: Updated title', { exact: true }).waitFor()
  assert.equal(await panel.getByText('新建', { exact: true }).count(), 1)
  assert.equal((await panel.innerText()).includes('历史修改前后快照'), false)
  assert.equal((await panel.innerText()).includes('/example/site'), false)
  assert.match(await panel.getByRole('button', { name: /title\.txt/ }).getAttribute('title'), /\/example\/site\/title\.txt/)
  await page.waitForFunction(() => document.querySelector('.workspace-side-panel')?.getBoundingClientRect().width >= 400)
  await page.screenshot({ path: path.join(directory, 'compare-light.png') })
  await panel.getByRole('button', { name: /style\.css/ }).click()
  await panel.getByText('gap: 12px;', { exact: true }).waitFor()
  assert.equal(await panel.getByText('gap: 20px;', { exact: true }).count(), 1)
  assert.match(await panel.locator('[aria-current="true"]').innerText(), /编辑/)
  assert.equal(await panel.getByText('title: Updated title', { exact: true }).count(), 0)
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await page.screenshot({ path: path.join(directory, 'compare-dark.png') })
  await panel.getByRole('button', { name: '关闭修改对比' }).click()
  await panel.waitFor({ state: 'detached' })
  failDetail = true
  await card.getByRole('button', { name: '查看修改', exact: true }).click()
  const retry = panel.getByRole('button', { name: '无法读取对比，点击重试' })
  await retry.waitFor()
  failDetail = false
  await retry.click()
  await panel.getByText('title: Updated title', { exact: true }).waitFor()
  await page.setViewportSize({ width: 620, height: 800 })
  await page.waitForFunction(() => document.querySelector('.workspace-side-panel')?.dataset.fullWidth === 'true')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: path.join(directory, 'compare-narrow.png') })
  records[0].status = 'recording'
  await page.evaluate(() => window.streamFixtureWork(true))
  await panel.getByText('记录未完成', { exact: true }).waitFor()
  records[0].status = 'completed'
  records[0].completedAt = '2026-11-13T10:01:00Z'
  await panel.getByText('记录未完成', { exact: true }).waitFor({ state: 'detached' })
  await panel.getByText('title: Updated title', { exact: true }).waitFor()
  await page.evaluate(() => window.streamFixtureWork(false))
  await page.evaluate(() => window.changeFixtureWork('other-work'))
  await panel.waitFor({ state: 'detached' })
  await card.waitFor({ state: 'detached' })
  assert.equal(await page.locator('vite-error-overlay').count(), 0)
  assert.deepEqual(errors, [])
  assert.deepEqual(mutations, [])
  console.log(JSON.stringify({ passed: true, checks: 'card, before/after, file switching, no undo, read-only requests, retry, themes, narrow panel, live completion, conversation isolation', screenshots: directory }))
} finally { await browser?.close(); await server.close() }
