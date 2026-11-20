import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'

test('channel saves show pending, success and failure in the global floating notice', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const replacements = {
    window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    ShadowRoot: dom.window.ShadowRoot, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: callback => setTimeout(callback, 0),
    cancelAnimationFrame: clearTimeout, ResizeObserver: class { observe() {} disconnect() {} },
  }
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })

  let server, root, finish, fail
  try {
    server = await createServer({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)), define: { __BUILD_DEPLOYMENT_CONFIG__: '{}' },
      server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' })
    const Component = (await server.ssrLoadModule('/src/components/settings/ChannelConfigurationEditor.jsx')).default
    const Host = (await server.ssrLoadModule('/src/components/NotificationHost.jsx')).default
    const { useSettingsStore } = await server.ssrLoadModule('/src/store/settings.js')
    useSettingsStore.setState({ channels: { configurations: { example: { id: 'example', type: 'wecom', name: 'Example bot', config: { enabled: false } } } },
      channelProfileAction: () => new Promise((resolve, reject) => { finish = resolve; fail = reject }) })
    const { createRoot } = await import('react-dom/client')
    root = createRoot(document.getElementById('root'))
    await act(async () => root.render(React.createElement(React.Fragment, null,
      React.createElement(Component, { type: 'wecom', profileId: 'example', onBusyChange: () => {} }), React.createElement(Host))))
    const saveButton = () => [...document.querySelectorAll('button')].find(button => /保存配置|已保存/.test(button.textContent))
    await act(async () => saveButton().click())
    assert.match(document.querySelector('.app-notice--loading').textContent, /正在保存通道配置/)
    await act(async () => finish())
    assert.match(document.querySelector('.app-notice--success').textContent, /已保存。请发送下方绑定指令/)
    assert.equal(document.querySelector('.channel-settings-feedback'), null)
    await act(async () => saveButton().click())
    await act(async () => fail(new Error('Fixture save failure')))
    assert.match(document.querySelector('.app-notice--error').textContent, /Fixture save failure/)
    assert.equal(document.querySelector('.app-notice--loading'), null)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 2100)) })
  } finally {
    await act(async () => root?.unmount())
    await server?.close()
    dom.window.close()
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
})
