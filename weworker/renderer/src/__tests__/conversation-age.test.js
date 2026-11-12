import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'

let dom, server, WorksList, worksStore, tasksStore, createRoot
const now = Date.parse('2026-11-09T04:00:00.000Z')
const timestamp = age => new Date(now - age).toISOString()

before(async () => {
  dom = new JSDOM('<div id="test"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.ShadowRoot = dom.window.ShadowRoot
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  // JSDOM has no layout observer; no title overflow is simulated here.
  globalThis.ResizeObserver = class { observe() {} disconnect() {} }
  // Initialize React DOM after the browser globals so it uses native input events.
  ;({ createRoot } = await import('react-dom/client'))
  server = await createServer({
    configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)),
    server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom',
  })
  WorksList = (await server.ssrLoadModule('/src/components/sidebar/WorksList.jsx')).default
  worksStore = (await server.ssrLoadModule('/src/store/works.js')).useWorksStore
  tasksStore = (await server.ssrLoadModule('/src/store/scheduled-tasks.js')).useScheduledTasksStore
})

after(async () => {
  await server?.close()
  dom?.window.close()
  for (const name of ['window', 'document', 'ShadowRoot', 'ResizeObserver', 'IS_REACT_ACT_ENVIRONMENT']) delete globalThis[name]
})

function work(id, age) {
  return { id, title: `Example conversation ${id}`, project_id: null, label: null, archived: false, created_at: timestamp(90 * 86400000), updated_at: timestamp(age) }
}

async function mount(t, works, messages = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now })
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected backend request') })
  worksStore.setState({ works, projects: [], messages, activeWorkId: null, labelFilter: null, streamingWorkIds: new Set() })
  tasksStore.setState({ tasks: [], tasksStatus: 'ready' })
  const host = document.getElementById('test')
  const root = createRoot(host)
  t.after(async () => { await act(async () => root.unmount()) })
  await act(async () => root.render(React.createElement(WorksList)))
  return host
}

test('every conversation shows a compact elapsed time with its exact update timestamp', async t => {
  const host = await mount(t, [work('new', 0), work('minutes', 5 * 60000), work('hours', 2 * 3600000), work('days', 23 * 86400000)])
  const times = [...host.querySelectorAll('.work-list-item time')]
  assert.deepEqual(times.map(el => el.textContent), ['刚刚', '5 分钟', '2 小时', '23 天'])
  assert.equal(times[1].dateTime, '2026-11-09T03:55:00.000Z')
  assert.ok(times.every(el => el.title && el.getAttribute('aria-label')))
})

test('relative ages advance without fetching or reloading the conversation list', async t => {
  const host = await mount(t, [work('boundary', 59 * 60000)])
  assert.equal(host.querySelector('time')?.textContent, '59 分钟')
  await act(async () => t.mock.timers.tick(60000))
  assert.equal(host.querySelector('time')?.textContent, '1 小时')
})

test('an appended local message immediately refreshes the elapsed time before list polling', async t => {
  const host = await mount(t, [work('recent', 2 * 86400000)])
  assert.equal(host.querySelector('time')?.textContent, '2 天')
  await act(async () => worksStore.getState().appendMessage('recent', {
    id: 'fixture-message', role: 'user', content: [{ type: 'text', text: 'Example message' }], created_at: timestamp(0),
  }))
  assert.equal(host.querySelector('time')?.textContent, '刚刚')
})

test('old cached messages do not replace a newer saved conversation timestamp', async t => {
  const host = await mount(t, [work('newer', 5 * 60000)], {
    newer: [{ id: 'fixture-old', role: 'assistant', content: [], created_at: timestamp(86400000) }],
  })
  assert.equal(host.querySelector('time')?.textContent, '5 分钟')
})

test('missing and invalid timestamps fall back safely without displaying NaN or negative ages', async t => {
  const host = await mount(t, [
    { ...work('fallback', 0), updated_at: 'invalid', created_at: timestamp(86400000) },
    { ...work('unknown', 0), updated_at: null, created_at: null },
    work('future', -60000),
  ])
  const rows = [...host.querySelectorAll('.work-list-item')]
  assert.equal(rows[0].querySelector('time')?.textContent, '1 天')
  assert.equal(rows[1].querySelector('time'), null)
  assert.equal(rows[2].querySelector('time')?.textContent, '刚刚')
  assert.doesNotMatch(host.textContent, /NaN|Invalid Date|-1 分钟/)
})

test('keyboard activation of a row action does not also select the conversation', async t => {
  const host = await mount(t, [work('actions', 60000)])
  const originalSelect = worksStore.getState().selectWork
  let selections = 0
  await act(async () => worksStore.setState({ selectWork: () => { selections++ } }))
  t.after(() => worksStore.setState({ selectWork: originalSelect }))
  const rename = host.querySelector('.work-list-item button[title="重命名"]')
  await act(async () => {
    rename.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    rename.click()
  })
  assert.equal(selections, 0)
  assert.equal(host.querySelector('.work-list-item input')?.value, 'Example conversation actions')
})
