import test, { after, afterEach, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

let server
let AppRail
let dom
let root
let listeners
const originalGlobals = new Map()
const initialUpdate = { status: 'idle', currentVersion: '1.0.0', latestVersion: '', progress: null }

before(async () => {
  dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' })
  for (const [name, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    localStorage: dom.window.localStorage, ShadowRoot: dom.window.ShadowRoot,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  server = await createServer({
    root: fileURLToPath(new URL('../../', import.meta.url)),
    configFile: false,
    plugins: [react()],
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: 'custom',
    logLevel: 'silent',
  })
  AppRail = (await server.ssrLoadModule('/src/components/layout/AppRail.jsx')).default
})

beforeEach(() => {
  listeners = new Set()
  window.electronAPI = {
    getStatus: async () => ({ bridge: 'running', python: 'running' }),
    getUpdateState: async () => ({ ...initialUpdate }),
    onUpdateState: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  root = createRoot(document.getElementById('root'))
})

afterEach(async () => {
  await act(async () => root.unmount())
})

after(async () => {
  await server?.close()
  dom?.window.close()
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
})

async function renderRail() {
  await act(async () => root.render(React.createElement(AppRail, { activeSection: 'conversation' })))
}

async function emitUpdate(next) {
  await act(async () => {
    for (const listener of listeners) listener(next)
  })
}

function updateButton() {
  return document.querySelector('nav[aria-label="工具"] .weworker-update-pill')
}

async function click(button) {
  assert.ok(button, 'expected an available action')
  await act(async () => button.click())
}

function buttonWithText(text) {
  return [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === text)
}

test('an already detected update appears above the bottom rail tools', async () => {
  window.electronAPI.getUpdateState = async () => ({ ...initialUpdate, status: 'available', latestVersion: '1.1.0' })
  await renderRail()
  assert.equal(updateButton()?.textContent, '更新')
  const settings = document.querySelector('button[aria-label="设置"]')
  assert.ok(updateButton().compareDocumentPosition(settings) & window.Node.DOCUMENT_POSITION_FOLLOWING)
})

test('the bottom update entry reacts to discovery, download progress and installation readiness', async () => {
  await renderRail()
  assert.equal(updateButton(), null)
  await emitUpdate({ status: 'available', latestVersion: '1.1.0' })
  assert.equal(updateButton()?.textContent, '更新')
  await emitUpdate({ status: 'downloading', progress: { percent: 47.4 } })
  assert.equal(updateButton()?.textContent, '47%')
  await emitUpdate({ status: 'downloaded', progress: { percent: 100 } })
  assert.equal(updateButton()?.textContent, '重启')
})

test('opening the rail prompt waits for explicit download and install actions', async () => {
  const actions = []
  window.electronAPI.downloadUpdate = async () => {
    actions.push('download')
    return { status: 'downloading', progress: { percent: 0 } }
  }
  window.electronAPI.installUpdate = async () => { actions.push('install') }
  await renderRail()
  await emitUpdate({ status: 'available', latestVersion: '1.1.0' })
  await click(updateButton())
  assert.ok(document.body.textContent.includes('发现新版本 v1.1.0'))
  assert.deepEqual(actions, [])
  await click(buttonWithText('下载更新'))
  assert.equal(updateButton()?.textContent, '0%')
  assert.deepEqual(actions, ['download'])
  await emitUpdate({ status: 'downloaded' })
  assert.ok(document.body.textContent.includes('更新包已准备好'))
  assert.deepEqual(actions, ['download'])
  await click(buttonWithText('重启安装'))
  assert.deepEqual(actions, ['download', 'install'])
})

test('dismissing update details keeps the available update reachable from the rail', async () => {
  await renderRail()
  await emitUpdate({ status: 'available' })
  await click(updateButton())
  await click(buttonWithText('稍后'))
  assert.equal(buttonWithText('下载更新'), undefined)
  assert.equal(updateButton()?.textContent, '更新')
  await click(updateButton())
  assert.ok(buttonWithText('下载更新'))
})

test('no update entry is displayed without a detected update or an Electron bridge', async () => {
  await renderRail()
  for (const status of ['checking', 'not-available', 'error', 'unsupported']) {
    await emitUpdate({ status })
    assert.equal(updateButton(), null)
  }
  await act(async () => root.unmount())
  delete window.electronAPI
  root = createRoot(document.getElementById('root'))
  await renderRail()
  assert.equal(updateButton(), null)
})
