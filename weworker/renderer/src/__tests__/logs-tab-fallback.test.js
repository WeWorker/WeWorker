import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'

let dom, server, LogsTab, createRoot

before(async () => {
  dom = new JSDOM('<div id="test"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  for (const name of ['window', 'document']) globalThis[name] = name === 'window' ? dom.window : dom.window[name]
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window)
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window)
  ;({ createRoot } = await import('react-dom/client'))
  server = await createServer({
    configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom',
  })
  LogsTab = (await server.ssrLoadModule('/src/components/settings/LogsTab.jsx')).default
})

after(async () => {
  await server?.close()
  dom?.window.close()
  for (const name of ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT', 'requestAnimationFrame', 'cancelAnimationFrame']) delete globalThis[name]
})

async function mount() {
  const root = createRoot(document.getElementById('test'))
  await act(async () => root.render(React.createElement(LogsTab)))
  return root
}

test('falls back to the main-process log file when the backend is unreachable', async t => {
  const fallbackLines = [
    '2026-11-21 09:00:00.123 [renderer] [renderer] 后端连接失败 net-error POST /dedicated-agents/skills -> http://127.0.0.1:8765：连接未建立（后端未启动/正在重启/被拦截）',
    '2026-11-21 09:00:01.456 [main] 端口监听失败 port-bind-failed：127.0.0.1:8765 无法监听（listen EADDRINUSE）。',
  ]
  // 后端不可用：fetch 直接网络层失败；electronAPI.readMainLog 提供主进程日志兜底。
  dom.window.electronAPI = { readMainLog: async (lines) => ({ lines: fallbackLines.slice(0, Math.min(lines, fallbackLines.length)), path: 'C:\\fixture\\main.log', total: fallbackLines.length }) }
  const fetchOriginal = globalThis.fetch
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch') }
  t.after(async () => {
    globalThis.fetch = fetchOriginal
    delete dom.window.electronAPI
  })
  const root = await mount()
  t.after(async () => act(async () => root.unmount()))

  const text = document.body.textContent
  assert.match(text, /后端服务不可用，正在显示主进程日志文件/, '兜底提示可见')
  assert.match(text, /端口监听失败 port-bind-failed/, '主进程日志行已展示')
  assert.match(text, /后端连接失败 net-error/, 'renderer 网络错误日志已展示')
})

test('shows the plain load error when no fallback is available (old preload)', async t => {
  delete dom.window.electronAPI
  const fetchOriginal = globalThis.fetch
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch') }
  t.after(() => { globalThis.fetch = fetchOriginal })
  const root = await mount()
  t.after(async () => act(async () => root.unmount()))
  assert.match(document.body.textContent, /Failed to load logs/, '无兜底能力时保持原行为')
})

test('renders backend log lines normally when the backend is reachable', async t => {
  const payload = { lines: ['2026-11-21 09:00:00.123 [chat] [info] hello'], path: '/fixture/main.log', total: 1 }
  const fetchOriginal = globalThis.fetch
  globalThis.fetch = async () => Response.json(payload)
  t.after(() => { globalThis.fetch = fetchOriginal })
  const root = await mount()
  t.after(async () => act(async () => root.unmount()))
  assert.ok(!document.body.textContent.includes('后端服务不可用'), '正常路径不出现兜底提示')
  assert.match(document.body.textContent, /hello/)
})
