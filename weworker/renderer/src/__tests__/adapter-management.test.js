import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'

const site = { id: 'example.com', name: 'Example', enabled: true, visible: true, icon: 'globe', version: '1.0.0', tools: [{ name: 'example.list' }], scenarios: [{ id: 'example-scenario', title: 'Example scenario' }] }
const item = { currentVersion: '1.0.0', latestVersion: '1.1.0', status: 'available' }
let dom, vite, createRoot, AdapterManagement, AdapterHub, SiteMenu, ToolPackagePage, siteStore, workspace, notifications

before(async () => {
  dom = new JSDOM('<div id="test"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.ShadowRoot = dom.window.ShadowRoot
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))
  vite = await createServer({
    configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom',
  })
  AdapterManagement = (await vite.ssrLoadModule('/src/components/welcome/AdapterManagement.jsx')).default
  AdapterHub = (await vite.ssrLoadModule('/src/components/welcome/AdapterHub.jsx')).default
  SiteMenu = (await vite.ssrLoadModule('/src/components/welcome/SiteSkillsScenariosAction.jsx')).default
  ToolPackagePage = (await vite.ssrLoadModule('/src/components/welcome/ToolPackagePage.jsx')).default
  siteStore = (await vite.ssrLoadModule('/src/store/sites.js')).useSitesStore
  notifications = (await vite.ssrLoadModule('/src/store/notifications.js')).useNotificationsStore
  workspace = await vite.ssrLoadModule('/src/store/tool-package-page.js')
})

after(async () => {
  await vite?.close()
  dom?.window.close()
  for (const name of ['window', 'document', 'ShadowRoot', 'IS_REACT_ACT_ENVIRONMENT']) delete globalThis[name]
})

function stubFetch(t, handler) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    const request = { path: new URL(url).pathname, method: options.method || 'GET', body: options.body && JSON.parse(options.body) }
    calls.push(request)
    return handler(request)
  }
  t.after(() => { globalThis.fetch = original })
  return calls
}

async function mount(t, component, props) {
  const root = createRoot(document.getElementById('test'))
  t.after(() => act(async () => root.unmount()))
  notifications.setState({ notices: [] })
  await act(async () => root.render(React.createElement(component, props)))
}

function lastNotice() {
  return notifications.getState().notices.at(-1)
}

function button(text) {
  return [...document.querySelectorAll('button')].find(button => button.textContent.trim() === text)
}

function snapshot(status, entry) {
  return Response.json({ status, items: entry ? { [site.id]: entry } : {} })
}

test('reads the backend startup check, polls while checking, applies the shown version and reloads sites', async t => {
  let reads = 0
  const calls = stubFetch(t, ({ path }) => {
    if (path === '/adapter-updates') return ++reads === 1 ? snapshot('checking') : snapshot('ready', item)
    if (path === `/adapter-updates/${site.id}/apply`) return snapshot('ready', { ...item, currentVersion: '1.1.0', status: 'current' })
    if (path === '/sites') return Response.json([{ ...site, version: '1.1.0' }])
    throw new Error(`Unexpected path ${path}`)
  })
  siteStore.setState({ sites: [site] })
  await mount(t, AdapterManagement)
  assert.deepEqual(calls.map(({ method }) => method), ['GET'])
  assert.equal(document.querySelector('.tool-package-card-action').textContent.trim(), '检测')
  assert.equal(document.querySelector('.tool-package-card-action').disabled, true)
  await act(() => delay(1300))
  assert.match(document.querySelector('.tool-package-entry--adapter').textContent, /1\.0\.0.*1\.1\.0.*有可用更新/)
  await act(async () => button('更新').click())
  assert.deepEqual(calls.slice(2).map(({ path, method, body }) => [path, method, body]), [
    [`/adapter-updates/${site.id}/apply`, 'POST', { version: '1.1.0' }],
    ['/sites', 'GET', undefined],
  ])
  assert.equal(siteStore.getState().sites[0].version, '1.1.0')
  assert.match(document.querySelector('.tool-package-entry--adapter').textContent, /1\.1\.0.*已是最新版本/)
  assert.equal(button('更新'), undefined)
  assert.equal(lastNotice().type, 'success')
  assert.equal(lastNotice().message, '已将 Example 更新至 1.1.0')
  await act(() => delay(1250))
  assert.equal(reads, 2)
})

test('reports check failures through a toast and toggles Adapter state', async t => {
  let enabled = true
  const calls = stubFetch(t, ({ path }) => {
    if (path === '/adapter-updates') return Response.json({ status: 'error', items: {}, error: '更新目录暂不可用' })
    if (path === '/adapter-updates/check') return Response.json({ status: 'error', items: {}, error: '更新目录暂不可用' })
    if (path === `/sites/${site.id}/toggle`) {
      enabled = false
      return Response.json({ enabled })
    }
    if (path === '/sites') return Response.json([{ ...site, enabled }])
    throw new Error(`Unexpected path ${path}`)
  })
  siteStore.setState({ sites: [site] })
  await mount(t, AdapterManagement)
  const card = document.querySelector('.tool-package-entry--adapter')
  assert.equal(button('检查最新版本'), undefined)
  assert.deepEqual(notifications.getState().notices, [])
  assert.equal(card.querySelector('.tool-package-card-action').textContent.trim(), '检测')
  assert.equal(card.querySelector('.tool-package-card-action').disabled, false)
  await act(async () => card.querySelector('.tool-package-card-action').click())
  assert.deepEqual(calls.at(-1), { path: '/adapter-updates/check', method: 'POST', body: undefined })
  assert.doesNotMatch(card.textContent, /检测失败/)
  assert.equal(card.querySelector('[role="alert"]'), null)
  assert.equal(lastNotice().type, 'error')
  assert.equal(lastNotice().message, '检测失败，请稍后重试。')
  assert.equal(button('更新'), undefined)
  assert.equal(card.querySelector('.tool-package-card-action').textContent.trim(), '检测')
  const enableSwitch = card.querySelector('.tool-package-entry__footer [role="switch"]')
  assert.equal(enableSwitch.checked, true)
  await act(async () => enableSwitch.click())
  assert.equal(enableSwitch.checked, false)
  assert.match(card.textContent, /已停用/)
  assert.deepEqual(calls.slice(-2).map(({ path, method }) => [path, method]), [
    [`/sites/${site.id}/toggle`, 'POST'],
    ['/sites', 'GET'],
  ])
})

test('searches AdapterHub entries and installs the selected version', async t => {
  const calls = stubFetch(t, ({ path }) => {
    if (path === '/adapter-hub') return Response.json({ items: [
      { name: 'example.mail', description: '示例邮箱能力', version: '1.2.0', official: true },
      { name: 'example.news', description: '示例资讯能力', version: '0.4.0', installedVersion: '0.4.0' },
    ] })
    if (path === '/adapter-hub/example.mail/install') return Response.json({ name: 'example.mail', version: '1.2.0' })
    if (path === '/sites') return Response.json([site])
    throw new Error(`Unexpected path ${path}`)
  })
  siteStore.setState({ sites: [site] })
  await mount(t, AdapterHub)
  const rows = () => [...document.querySelectorAll('.tool-package-entry--hub')]
  assert.equal(rows().length, 2)
  assert.equal(rows()[1].querySelector('.tool-package-card-action').textContent.trim(), '已安装')
  assert.equal(rows()[1].querySelector('.tool-package-card-action').disabled, true)
  const search = document.querySelector('.adapter-hub__search')
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(search, '资讯')
    search.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  assert.deepEqual(rows().map(row => row.querySelector('.tool-package-entry__title').textContent), ['example.news'])
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(search, '')
    search.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await act(async () => rows()[0].querySelector('.tool-package-card-action').click())
  assert.deepEqual(calls.filter(({ path }) => path.includes('install')).map(({ path, method, body }) => [path, method, body]), [
    ['/adapter-hub/example.mail/install', 'POST', { version: '1.2.0' }],
  ])
  assert.equal(lastNotice().type, 'success')
  assert.equal(lastNotice().message, '已安装 example.mail')
})

test('preserves site menu actions and shows the installed Adapter version', async t => {
  const selected = []
  await mount(t, SiteMenu, { site, menuOpen: true, onSelect: (...args) => selected.push(args) })
  assert.match(document.querySelector('[role="menu"]').textContent, /Adapter 版本 1\.0\.0/)
  await act(async () => {
    button('站点 Skills').click()
    button('站点场景').click()
  })
  assert.deepEqual(selected, [[site.id, workspace.WORKSPACE_TAB_SKILLS], [site.id, workspace.WORKSPACE_TAB_SCENARIOS]])
})

test('renders the complete workspace and shows the selected site version in both site views', async t => {
  stubFetch(t, ({ path }) => {
    if (path === '/adapter-updates') return snapshot('idle')
    if (path === '/sites') return Response.json([site])
    if (path === '/skills') return Response.json([{ name: 'example-public-skill', enabled: true }])
    if (path === '/adapter-hub') return Response.json({ items: [{ name: 'example-hub-adapter', description: '示例远端 Adapter', version: '2.0.0', official: true }] })
    return Response.json([])
  })
  siteStore.setState({ sites: [site] })
  workspace.useToolPackagePageStore.getState().openPage()
  await mount(t, ToolPackagePage)
  assert.equal(document.querySelector('h1'), null)
  const topTabs = () => [...document.querySelectorAll('.header-tab-row [role="tab"]')]
  const viewTabs = () => [...document.querySelectorAll('.adapter-view-tabs [role="tab"]')]
  assert.deepEqual(topTabs().map(tab => tab.textContent.trim()), ['Adapter', 'Skills', '场景'])
  assert.deepEqual(viewTabs().map(tab => tab.textContent.trim()), ['Adapter 管理', 'AdapterHub'])
  assert.equal(viewTabs()[0].getAttribute('aria-selected'), 'true')
  await act(async () => viewTabs()[1].click())
  assert.equal(document.querySelector('.adapter-hub__search').getAttribute('placeholder'), '搜索 Adapter')
  assert.match(document.querySelector('.tool-package-entry--hub').textContent, /example-hub-adapter.*2\.0\.0.*官方/)
  await act(async () => viewTabs()[0].click())
  assert.match(document.querySelector('.tool-package-entry--adapter').textContent, /1\.0\.0/)
  await act(async () => topTabs()[1].click())
  assert.equal(document.querySelector('h1').textContent, 'Skills')
  const skillRows = [...document.querySelectorAll('.tool-package-entry--skill')]
  const siteSkill = skillRows.find(row => row.textContent.includes(`webcli-${site.id}`))
  const publicSkill = skillRows.find(row => row.textContent.includes('example-public-skill'))
  assert.match(siteSkill.textContent, /Adapter 版本 1\.0\.0/)
  assert.doesNotMatch(publicSkill.textContent, /Adapter 版本/)
  await act(async () => topTabs()[2].click())
  assert.equal(document.querySelector('h1').textContent, '场景')
  assert.match(document.body.textContent, /Adapter 版本 1\.0\.0/)
})

test('opens management by default and keeps AdapterHub inside the Adapter tab', async () => {
  const { openPage } = workspace.useToolPackagePageStore.getState()
  const state = workspace.useToolPackagePageStore.getState
  openPage()
  assert.equal(state().workspaceTab, workspace.WORKSPACE_TAB_ADAPTERS)
  assert.deepEqual(workspace.WORKSPACE_TABS.map(tab => tab.label), ['Adapter', 'Skills', '场景'])
  openPage(site.id, { workspaceTab: workspace.WORKSPACE_TAB_SCENARIOS })
  assert.equal(state().workspaceTab, workspace.WORKSPACE_TAB_SCENARIOS)
  assert.deepEqual(state().scenarioSiteIds, [site.id])
  openPage(site.id)
  assert.equal(state().workspaceTab, workspace.WORKSPACE_TAB_SKILLS)
  assert.deepEqual(state().selectedSiteIds, [site.id])
  openPage(undefined, { publicSkillName: 'example-skill' })
  assert.equal(state().workspaceTab, workspace.WORKSPACE_TAB_SKILLS)
  assert.equal(state().selectedPublicSkillName, 'example-skill')
})
