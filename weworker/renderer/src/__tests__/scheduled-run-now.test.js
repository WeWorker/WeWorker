import test, { before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

let server, dom, root, createRoot, View, store, dialogs, calls, task, runResponse, running
const globals = new Map()
before(async () => {
  dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' })
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, localStorage: dom.window.localStorage,
    ShadowRoot: dom.window.ShadowRoot, IS_REACT_ACT_ENVIRONMENT: true })) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  globals.set('fetch', Object.getOwnPropertyDescriptor(globalThis, 'fetch'))
  ;({ createRoot } = await import('react-dom/client'))
  server = await createServer({ root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false,
    plugins: [react()], server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom', logLevel: 'silent' })
  View = (await server.ssrLoadModule('/src/components/scheduled/TaskConfigView.jsx')).default
  store = (await server.ssrLoadModule('/src/store/scheduled-tasks.js')).useScheduledTasksStore
  dialogs = (await server.ssrLoadModule('/src/store/dialog.js')).useDialogStore
})
beforeEach(() => {
  calls = []; running = false
  task = { id: 'fixture-task', title: 'Example task', cron_expression: '0 9 * * 1,2',
    prompt_template: 'Summarize example data', notify_channels: [], enabled: false }
  store.setState({ tasks: [task], executions: { [task.id]: [] }, startingTasks: {}, runningTasks: {} })
  dialogs.setState({ queue: [] })
  runResponse = async () => { running = true; return Response.json({ status: 'started' }, { status: 202 }) }
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ path: new URL(url).pathname, method: options.method || 'GET' })
    if (options.method === 'POST') return runResponse()
    return Response.json({ task, running, executions: running ? [{ id: 'fixture-run', status: 'running' }] : [] })
  }
  root = createRoot(document.getElementById('root'))
})
afterEach(async () => { await act(async () => root.unmount()) })
after(async () => {
  await server?.close(); dom?.window.close()
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
})
const button = text => [...document.querySelectorAll('button')].find(el => el.textContent.trim() === text)
async function render() { await act(async () => root.render(React.createElement(View, { taskId: task.id }))) }

test('disabled task can run immediately, refresh history, and display running state without PATCHing schedule', async () => {
  await render()
  assert.ok(button('立即执行'))
  await act(async () => button('立即执行').click())
  assert.equal(button('执行中…').disabled, true)
  assert.equal(calls.filter(call => call.method === 'POST').length, 1)
  assert.equal(calls.some(call => call.method === 'PATCH'), false)
  assert.equal(store.getState().tasks[0].enabled, false)
  assert.equal(store.getState().executions[task.id][0].id, 'fixture-run')
  await act(async () => { running = false; await store.getState().loadExecutions(task.id) })
  assert.equal(button('立即执行').disabled, false)
})

test('unsaved configuration prompts to save and never starts the old configuration', async () => {
  await render()
  await act(async () => button('每小时').click())
  await act(async () => button('立即执行').click())
  assert.equal(calls.some(call => call.method === 'POST'), false)
  assert.match(dialogs.getState().queue[0].message, /请先保存修改/)
})

test('failed start reports an error and permits retry', async () => {
  runResponse = async () => Response.json({ error: 'Fixture rejection' }, { status: 409 })
  await render()
  await act(async () => button('立即执行').click())
  assert.equal(button('立即执行').disabled, false)
  assert.equal(dialogs.getState().queue[0].message, 'Fixture rejection')
})

test('rapid repeated starts send only one request', async () => {
  let finish
  runResponse = () => new Promise(resolve => { finish = () => { running = true; resolve(Response.json({ status: 'started' }, { status: 202 })) } })
  const first = store.getState().runTask(task.id)
  await new Promise(resolve => setImmediate(resolve))
  await store.getState().runTask(task.id)
  assert.equal(calls.filter(call => call.method === 'POST').length, 1)
  finish(); await first
})
