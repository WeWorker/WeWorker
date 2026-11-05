/** Real Renderer + HTTP/SSE + real handoff persistence; deterministic model/browser fixture.
 * Run from repo root: node weworker/backend-ts/node_modules/tsx/dist/cli.mjs weworker/backend-ts/scripts/exploration-chat-e2e.mts
 * Never connects to the user's running backend, browser profile or model account.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { createServer as createVite } from '../../renderer/node_modules/vite/dist/node/index.js'
import { chromium } from '../../node_modules/playwright-core/index.mjs'
import * as works from '../src/works-store.js'
import { resolveDesktopChatPermission } from '../src/chat-permission-mode.js'
import { createDevelopmentChatHandoff } from '../src/website-exploration-handoff.js'
import { prepareExplorationConversation, listExplorationConversations, excludeExplorationConversations } from '../src/exploration-conversations.js'
import { createWebsiteExplorationAdapterRouter } from '../src/website-exploration-adapters.js'

const renderer = fileURLToPath(new URL('../../renderer/', import.meta.url))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-exploration-e2e-'))
const file = path.join(root, 'ownership.json')
const deps = { file, create: (input, opts) => createDevelopmentChatHandoff(input, { ...opts, workspaceRoot: () => root }) }
works._initTestDb()
const main = works.createWork('普通主对话', null, root)
works.appendMessage(main.id, 'user', [{ type: 'text', text: '主对话历史占位' }])
const records = ['exp_old', 'exp_new'].map((id, i) => ({ exploration_id: id, title: i ? '示例网站二' : '示例网站一', start_url: 'https://example.com/', instruction: '读取页面标题', status: 'succeeded', last_run_id: 'run_' + id, created_at: i ? '2026-11-04 10:00' : '2026-11-03 10:00', created_at_timestamp: i + 1, timeline: [{ type: 'agent_step', step: 1, status: 'succeeded', thought: '已了解示例网站能力', code: 'read_title()' }] }))
const chats = []
const waiting = new Map()
let failPreparation = false
let runnerOffline = false
let failChat = false
const stopped = []
const app = express()
app.use(express.json())
app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*'); if (req.method === 'OPTIONS') return res.sendStatus(204); next() })
app.use((req, res, next) => {
 if (runnerOffline && req.path.startsWith('/api/website-exploration') && req.path !== '/api/website-exploration/development/chats') return res.status(503).json({ detail: '示例探索服务离线' })
 next()
})
app.use('/api/website-exploration', createWebsiteExplorationAdapterRouter({
 instanceId: 'fixture-instance',
 fetchAgent: async (url, options) => {
  if (String(url).endsWith('/api/health')) return Response.json({ ok: true, instance_id: 'fixture-instance' })
  assert.deepEqual(Object.keys(JSON.parse(options.body)).filter(k => !['instruction', 'target'].includes(k)), [], 'Python input schema rejects host-only fields')
  const record = records.find(r => String(url).includes('/' + r.exploration_id + '/'))
  return Response.json({ schema_version: 1, site: { start_url: record.start_url, allowed_domains: ['example.com'] }, source_exploration: { exploration_id: record.exploration_id, run_id: record.last_run_id } })
 },
 onListDevelopmentChats: () => listExplorationConversations({ file }),
 onDevelopmentHandoff: input => { if (failPreparation) { failPreparation = false; throw new Error('示例准备失败，请重试') } return prepareExplorationConversation(input, deps) },
}))
app.post('/api/website-exploration/explorations', (req, res) => {
 const record = { ...records[0], exploration_id: 'exp_created', title: '新建示例探索', start_url: req.body.start_url, instruction: req.body.instruction, last_run_id: 'run_created', created_at: '2026-11-04 11:00', timeline: [{ type: 'agent_step', step: 1, status: 'succeeded', thought: '新探索已完成' }] }
 records.push(record); res.json(record)
})
app.get('/api/website-exploration/explorations', (_, res) => res.json({ explorations: records }))
app.get('/api/website-exploration/explorations/:id', (req, res) => res.json(records.find(r => r.exploration_id === req.params.id)))
app.get('/api/website-exploration/explorations/:id/timeline', (req, res) => res.json({ items: records.find(r => r.exploration_id === req.params.id).timeline }))
app.post('/api/website-exploration/explorations/:id/messages', (req, res) => {
 const record = records.find(r => r.exploration_id === req.params.id)
 record.last_run_id += '_next'; record.timeline.push({ type: 'user', content: req.body.content }); res.json(record)
})
app.get('/api/website-exploration/health', (_, res) => res.json({ ok: true }))
app.get('/api/website-exploration/browser/status', (_, res) => res.json({ available: true }))
app.get('/api/website-exploration/activity', (_, res) => res.json({ running: false }))
app.post('/settings/exploration-model/check', (_, res) => res.json({ ok: true }))
app.get('/works', (_, res) => res.json(excludeExplorationConversations(works.listWorks(), file)))
app.get('/works/archived', (_, res) => res.json(excludeExplorationConversations(works.listWorks(), file)))
app.get('/works/:id', (req, res) => res.json(works.getWorkWithMessages(req.params.id)))
app.post('/works/:id/chat', (req, res) => {
 const id = req.params.id
 if (failChat) { failChat = false; return res.status(503).json({ detail: '示例发送失败' }) }
 chats.push({ id, ...req.body })
 res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
 const send = event => res.write('data: ' + JSON.stringify(event) + '\n\n')
 const user = works.appendMessage(id, 'user', [{ type: 'text', text: req.body.message }])
 send({ type: 'user_message_saved', message: user })
 const turn = chats.filter(c => c.id === id).length
 if (turn === 1) {
  send({ type: 'text_delta', content: '已读取探索结果，准备生成网站适配器。' })
  send({ type: 'user_choice', id: 'choice_example', question: '请选择实现方向', options: [{ label: '复用已有能力', description: '优先复用已有接口' }, { label: '新建能力' }] })
  waiting.set(id, { res, send, question: true })
 } else if (req.body.message === '测试停止') {
  send({ type: 'text_delta', content: '正在生成网站适配器' })
  waiting.set(id, { res, send, question: false })
 } else {
  const message = works.appendMessage(id, 'assistant', [{ type: 'text', text: '适配器回复：' + req.body.message }])
  send({ type: 'replace_assistant_content', content: message.content }); res.end()
 }
})
app.post('/works/:id/user-choice', (req, res) => {
 const pending = waiting.get(req.params.id)
 assert.ok(pending)
 const message = works.appendMessage(req.params.id, 'assistant', [{ type: 'text', text: '已选择：' + req.body.answer + '。网站适配器已生成。' }])
 pending.send({ type: 'replace_assistant_content', content: message.content }); pending.res.end(); waiting.delete(req.params.id); res.json({ ok: true })
})
app.post('/works/:id/chat/stop', (req, res) => { stopped.push(req.params.id); waiting.get(req.params.id)?.res.end(); waiting.delete(req.params.id); res.json({ ok: true }) })
app.use((req, res) => { if (req.path.endsWith('/events')) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': fixture\n\n'); return } res.json({}) })
const backend = await new Promise<any>(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)) })
const backendUrl = 'http://127.0.0.1:' + backend.address().port
const entry = path.join(root, 'entry.jsx')
fs.writeFileSync(entry, `
import React from 'react'
import { createRoot } from 'react-dom/client'
import WebsiteExplorationPage from '/src/components/website-exploration/WebsiteExplorationPage.jsx'
import ChatView from '/src/components/chat/ChatView.jsx'
import { useWebsiteExplorationStore as exploration } from '/src/store/website-exploration.js'
import { useWorksStore as works } from '/src/store/works.js'
import { useChatDraftStore as drafts } from '/src/store/chat-drafts.js'
import { useChatInputFillStore as fill } from '/src/store/chat-input-fill.js'
import '/src/index.css'
import '/src/workspace-refresh.css'
import '/src/workspace-theme.css'
window.testStores = { works, exploration, drafts, fill }
works.setState({ works: [${JSON.stringify(main)}], activeWorkId: '${main.id}', pendingMessage: '不得串入开发的待发消息' })
drafts.getState().setText('work:${main.id}', '主对话未发送草稿')
exploration.setState({ open: true })
function Harness() {
 const open = exploration(s => s.open)
 const [visit, setVisit] = React.useState(0)
 return <><nav style={{height:40}}><button onClick={() => exploration.setState({open:false})}>主对话</button><button onClick={() => exploration.setState({open:true})}>网站探索</button><button onClick={() => setVisit(v => v + 1)}>重新进入探索</button></nav><main style={{height:'calc(100vh - 40px)'}}>{open ? <WebsiteExplorationPage key={visit} /> : <ChatView workId="${main.id}" />}</main></>
}
createRoot(document.getElementById('root')).render(<React.StrictMode><Harness /></React.StrictMode>)
`)
const vite = await createVite({ root: renderer, resolve: { dedupe: ['react', 'react-dom'] }, configFile: path.join(renderer, 'vite.config.js'), server: { host: '127.0.0.1', port: 0, fs: { allow: [renderer, root] } }, plugins: [{ name: 'isolated-e2e-entry', configureServer(server) { server.middlewares.use('/__e2e', async (_, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/__e2e', '<html class="light"><body><div id="root"></div><script type="module" src="/@fs/' + entry.replaceAll('\\', '/') + '"></script></body></html>')) }) } }] })
let browser
try {
 await vite.listen()
 const executablePath = process.env.E2E_BROWSER || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p))
 browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
 const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
 const errors = []
 page.on('pageerror', error => errors.push(error.message))
 await page.addInitScript(({ backendUrl }) => {
  const original = window.fetch
  window.fetch = (url, options) => original(String(url).replace('http://127.0.0.1:8765', backendUrl), options)
  if (!localStorage.getItem('weworker.chat.permission-mode')) localStorage.setItem('weworker.chat.permission-mode', 'ask')
  window.electronAPI = {}
 }, { backendUrl })
 const url = 'http://127.0.0.1:' + (vite.httpServer.address() as any).port + '/__e2e'
 await page.goto(url)
 await page.getByRole('button', { name: /示例网站一/ }).click()
 failPreparation = true
 await page.getByText('探索任务已完成，本次探索结果可生成可复用的网站适配器，以便下次直接操作网站。是否分析探索结果并生成网站适配器？', { exact: true }).waitFor()
 await page.getByRole('button', { name: /否，还需要进一步探索/ }).waitFor()
 await page.getByRole('button', { name: /是，生成网站适配器/ }).click()
 await page.getByText('示例准备失败，请重试').waitFor()
 assert.equal(chats.length, 0)
 await page.getByRole('button', { name: /是，生成网站适配器/ }).click()
 await page.getByRole('button', { name: /复用已有能力/ }).waitFor()
 assert.equal(chats.length, 1, 'StrictMode and remounts send only once')
 const workId = chats[0].id
 assert.notEqual(workId, main.id)
 assert.equal(chats[0].permissionMode, 'full')
 assert.deepEqual(resolveDesktopChatPermission(chats[0].permissionMode), { channelPermissionMode: 'full', sdkPermissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true })
 await page.locator('[title="权限模式：完全权限"]').waitFor()
 assert.equal(await page.evaluate(() => localStorage.getItem('weworker.chat.permission-mode')), 'ask')
 assert.equal(await page.locator('textarea:visible').count(), 1)
 assert.equal(await page.locator('[data-chat-attachment-target]').getAttribute('data-chat-attachment-target'), 'work:' + workId)
 assert.equal(await page.locator('.wx-history .wx-record').first().textContent().then(t => t.includes('示例网站一')), true)
 assert.equal(await page.evaluate(() => window.testStores.works.getState().activeWorkId), main.id)
 assert.equal((await (await fetch(backendUrl + '/works')).json()).length, 1)
 assert.equal((await (await fetch(backendUrl + '/works/archived')).json()).length, 1)
 await page.screenshot({ path: path.join(root, '01-inline-development.png'), fullPage: true })
 await page.getByRole('button', { name: /示例网站二/ }).click()
 await page.getByRole('button', { name: /示例网站一/ }).click()
 await page.getByRole('button', { name: /复用已有能力/ }).click()
 await page.getByText('已选择：复用已有能力。网站适配器已生成。').waitFor()
 assert.equal(chats.length, 1)
 await page.locator('.chat-view textarea').fill('开发草稿占位')
 await page.evaluate(() => window.testStores.fill.getState().requestFill('不应填入探索开发'))
 assert.equal(await page.locator('.chat-view textarea').inputValue(), '开发草稿占位')
 await page.getByRole('button', { name: /示例网站二/ }).click()
 await page.getByRole('button', { name: /示例网站一/ }).click()
 assert.equal(await page.locator('.chat-view textarea').inputValue(), '开发草稿占位')
 await page.locator('.chat-view textarea').fill('测试停止')
 await page.getByRole('button', { name: '发送消息', exact: true }).click()
 await page.getByText('正在生成网站适配器').waitFor()
 const runningRecord = page.locator('.wx-history .wx-record').filter({ hasText: '示例网站一' })
 await page.locator('.wx-record.is-in-progress').filter({ hasText: '示例网站一' }).waitFor()
 await page.getByRole('button', { name: /示例网站二/ }).click()
 assert.equal(await runningRecord.getAttribute('aria-current'), null)
 assert.equal(await runningRecord.isEnabled(), true)
 assert.ok((await runningRecord.getAttribute('class')).includes('is-in-progress'))
 await runningRecord.getByText('进行中', { exact: true }).waitFor()
 assert.equal(await page.locator('.wx-record:not(.is-in-progress) .wx-status').count(), 0)
 for (const dark of [false, true]) {
  await page.evaluate(dark => { document.documentElement.classList.toggle('dark', dark); document.documentElement.classList.toggle('light', !dark) }, dark)
  await page.mouse.move(1000, 100)
  await page.waitForTimeout(200)
  assert.equal(await runningRecord.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)', 'unselected running row has no gray background')
  assert.equal(await runningRecord.locator('.wx-record-progress-gear').evaluate(el => getComputedStyle(el).animationName), 'wx-record-gear-turn')
  assert.equal(await runningRecord.locator('.wx-record-progress').evaluate(el => {
   const probe = document.createElement('span'); probe.style.color = 'var(--accent)'; el.append(probe)
   const expected = getComputedStyle(probe).color; probe.remove()
   return getComputedStyle(el).color === expected && getComputedStyle(el.querySelector('.wx-record-progress-gear')).color === expected
  }), true, 'running label and gear use theme blue in both themes')
  const selectedRecord = page.locator('.wx-record[aria-current="true"]')
  assert.equal(await selectedRecord.evaluate(el => {
   const probe = document.createElement('span'); probe.style.background = 'var(--bg-active)'; el.append(probe)
   const expected = getComputedStyle(probe).backgroundColor; probe.remove()
   return getComputedStyle(el).backgroundColor === expected
  }), true, 'only selected row uses main-chat gray background')
 }
 await page.emulateMedia({ reducedMotion: 'reduce' })
 assert.equal(await runningRecord.locator('.wx-record-progress-gear').evaluate(el => getComputedStyle(el).animationName), 'none')
 await page.emulateMedia({ reducedMotion: 'no-preference' })
 await page.evaluate(() => { document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light') })
 await page.waitForTimeout(250)
 await page.screenshot({ path: path.join(root, '03-running-record-indicator.png'), fullPage: true })
 // Re-entering defaults to the running conversation, not the last idle selection.
 await page.getByRole('button', { name: '重新进入探索', exact: true }).click()
 await page.locator('.wx-record.is-active.is-in-progress').filter({ hasText: '示例网站一' }).waitFor()
 await page.getByTitle('停止生成', { exact: true }).click()
 assert.deepEqual(stopped, [workId])
 assert.equal(chats.at(-1).permissionMode, 'full')
 await page.getByTitle('停止生成', { exact: true }).waitFor({ state: 'hidden' })
 await page.locator('.wx-record.is-in-progress').filter({ hasText: '示例网站一' }).waitFor({ state: 'hidden' })
 assert.equal(await runningRecord.getAttribute('aria-current'), 'true')
 assert.equal(await runningRecord.locator('.wx-status').count(), 0)
 failChat = true
 await page.locator('.chat-view textarea').fill('失败后重试')
 await page.getByRole('button', { name: '发送消息', exact: true }).click()
 await page.getByText(/示例发送失败/).first().waitFor()
 await page.getByRole('button', { name: /继续队列|继续发送/ }).click()
 await page.getByText('适配器回复：失败后重试').waitFor()
 assert.equal(chats.at(-1).permissionMode, 'full')
 await page.getByRole('button', { name: '权限模式', exact: true }).click()
 await page.getByRole('option', { name: '工作区内修改', exact: true }).click()
 await page.locator('.chat-view textarea').fill('手动降低权限')
 await page.getByRole('button', { name: '发送消息', exact: true }).click()
 await page.getByText('适配器回复：手动降低权限').waitFor()
 assert.equal(chats.at(-1).permissionMode, 'workspace')
 await page.getByRole('button', { name: /示例网站二/ }).click()
 await page.getByRole('button', { name: /否，还需要进一步探索/ }).click()
 await page.getByText('继续探索这个网站，进一步了解尚未覆盖的功能和操作流程。').waitFor()
 await page.getByRole('button', { name: /是，生成网站适配器/ }).click()
 await page.getByRole('button', { name: /复用已有能力/ }).waitFor()
 const secondId = chats.at(-1).id
 assert.notEqual(secondId, workId)
 assert.equal(chats.at(-1).permissionMode, 'full')
 await page.locator('[title="权限模式：完全权限"]').waitFor()
 assert.equal(await page.getByText('适配器回复：失败后重试').count(), 0)
 await page.getByRole('button', { name: /复用已有能力/ }).click()
 await page.getByText('已选择：复用已有能力。网站适配器已生成。').waitFor()
 assert.equal((await (await fetch(backendUrl + '/works')).json()).length, 1)
 await page.reload()
 await page.getByRole('button', { name: /示例网站一/ }).click()
 await page.getByText('适配器回复：失败后重试').waitFor()
 assert.equal(chats.filter(c => c.id === workId && c.message.includes('input.json')).length, 1)
 await page.evaluate(() => window.testStores.works.setState({ pendingMessage: null }))
 await page.getByRole('button', { name: '主对话', exact: true }).click()
 await page.getByText('主对话历史占位').waitFor()
 await page.locator('[title="权限模式：修改询问"]').waitFor()
 assert.equal(await page.getByText('适配器回复：失败后重试').count(), 0)
 assert.equal(await page.locator('.chat-view textarea').inputValue(), '主对话未发送草稿')
 await page.getByRole('button', { name: '网站探索', exact: true }).click()
 await page.getByRole('button', { name: /示例网站一/ }).click()
 await page.getByText('适配器回复：失败后重试').waitFor()
 await page.setViewportSize({ width: 850, height: 850 })
 await page.locator('.message-list-scroll').evaluate(el => { el.scrollTop = el.scrollHeight })
 await page.screenshot({ path: path.join(root, '02-restored-development-narrow.png'), fullPage: true })
 const lastReply = await page.getByText('适配器回复：失败后重试').boundingBox()
 const dock = await page.locator('[data-chat-bottom-dock]').boundingBox()
 assert.ok(lastReply.y + lastReply.height <= dock.y + 12, 'latest reply is not covered by the composer')
 assert.equal(await page.locator('textarea:visible').count(), 1)
 assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
 // New URL -> goal submission -> completion, then simulate a lost handoff response.
 await page.getByRole('button', { name: '新探索', exact: true }).click()
 await page.getByRole('textbox', { name: '起始网址', exact: true }).fill('https://example.org/')
 await page.getByRole('textbox', { name: '起始网址', exact: true }).press('Enter')
 await page.getByPlaceholder('告诉我你想在这个网站上干什么').fill('读取公开标题')
 await page.getByRole('button', { name: '发送消息', exact: true }).click()
 await page.getByRole('button', { name: /是，生成网站适配器/ }).waitFor()
 // Use the validated source URL for this fixture too.
 const savedTurns = chats.length
 const preparedInput = { schema_version: 1, site: { start_url: 'https://example.org/', allowed_domains: ['example.org'] }, source_exploration: { exploration_id: 'exp_created', run_id: 'run_created' } }
 prepareExplorationConversation(preparedInput, deps)
 await page.reload()
 await page.getByRole('button', { name: /新建示例探索/ }).click()
 await page.getByRole('button', { name: '继续生成网站适配器', exact: true }).waitFor()
 assert.equal(chats.length, savedTurns, 'opening unsent history must not silently run tools')
 await page.getByRole('button', { name: '继续生成网站适配器', exact: true }).click()
 await page.getByRole('button', { name: /复用已有能力/ }).click()
 await page.getByText('已选择：复用已有能力。网站适配器已生成。').waitFor()
 assert.equal(chats.length, savedTurns + 1)
 assert.equal(chats.at(-1).permissionMode, 'full')
 // Completed adapter chats must not become the landing page, even after repeated visits.
 for (let visit = 0; visit < 2; visit++) {
  await page.locator('.wx-record.is-in-progress').waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '重新进入探索', exact: true }).click()
  await page.getByRole('textbox', { name: '起始网址', exact: true }).waitFor()
  assert.equal(await page.locator('.wx-record.is-active').count(), 0)
  assert.equal(await page.locator('.chat-view').count(), 0)
  assert.equal(chats.length, savedTurns + 1, 'idle entry must not send another request')
  await page.getByRole('button', { name: /新建示例探索/ }).click()
  await page.getByText('已选择：复用已有能力。网站适配器已生成。').waitFor()
 }
 runnerOffline = true
 await page.reload()
 await page.getByRole('button', { name: /网站适配器 · example.org/ }).click()
 await page.getByText('探索记录暂不可用，仍可继续生成网站适配器。').waitFor()
 await page.locator('.chat-view textarea').fill('探索服务离线时继续开发')
 await page.getByRole('button', { name: '发送消息', exact: true }).click()
 await page.getByText('适配器回复：探索服务离线时继续开发').waitFor()
 assert.equal((await (await fetch(backendUrl + '/works')).json()).length, 1)
 assert.deepEqual(errors, [])
 console.log(JSON.stringify({ ok: true, turns: chats.length, artifacts: root, scenarios: ['in-place development', 'idempotent first send', 'main/archived isolation', 'inline question', 'active pinning', 'switch while streaming', 'draft isolation', 'global fill isolation', 'stop', 'failed send retry', 'reload recovery', 'main chat history unchanged', 'narrow layout', 'continue exploration', 'multiple isolated developments', 'new URL exploration', 'recover prepared unsent work', 'development while exploration offline', 'full permission UI matches first request and backend mapping', 'full followups and recovery', 'explicit scoped downgrade', 'main permission unchanged', 'idle visits always open new exploration', 'manual history remains available'] }, null, 2))
} catch (error) {
 if (browser) { const page = browser.contexts()[0]?.pages()[0]; if (page) { await page.screenshot({ path: path.join(root, 'failure.png'), fullPage: true }); fs.writeFileSync(path.join(root, 'failure.txt'), await page.locator('body').innerText()) } }
 console.error('E2E artifacts:', root)
 throw error
} finally {
 await browser?.close()
 await vite.close()
 backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve))
}
