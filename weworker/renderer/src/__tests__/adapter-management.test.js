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
    const parsed = new URL(url)
    const request = { path: parsed.pathname, params: parsed.searchParams, signal: options.signal, method: options.method || 'GET', body: options.body && JSON.parse(options.body) }
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
  const render = (next, nextProps) => act(async () => root.render(React.createElement(next, nextProps)))
  await render(component, props)
  return render
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
  assert.deepEqual(calls.map(({ path }) => path).slice(-1), ['/adapter-updates/check'])
  assert.equal(calls.at(-1).method, 'POST')
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

test('renders installed cards before slow auxiliary requests and remote update detection finish', async t => {
  let resolveSites, resolveTools, resolveAliases, resolveUpdates
  const calls = stubFetch(t, ({ path }) => {
    if (path === '/sites') return new Promise(resolve => { resolveSites = resolve })
    if (path === '/system-tools') return new Promise(resolve => { resolveTools = resolve })
    if (path === '/router/aliases') return new Promise(resolve => { resolveAliases = resolve })
    if (path === '/adapter-updates') return new Promise(resolve => { resolveUpdates = resolve })
    return Response.json([])
  })
  siteStore.setState({ sites: [], sitesStatus: 'idle' })
  let load
  await act(async () => { load = siteStore.getState().load() })
  workspace.useToolPackagePageStore.getState().openPage()
  await mount(t, ToolPackagePage)
  assert.equal(lastNotice()?.message, '正在扫描已安装的 Adapter…')
  assert.equal(lastNotice()?.type, 'loading')
  assert.doesNotMatch(document.querySelector('.adapter-management').textContent, /正在扫描|正在读取/)
  await act(async () => resolveSites(Response.json([site])))
  assert.equal(lastNotice(), undefined)
  assert.equal(document.querySelector('.tool-package-entry__title')?.textContent, site.name)
  assert.equal(document.querySelector('.adapter-management__versions span')?.textContent, '当前 1.0.0')
  await act(async () => {
    resolveTools(Response.json([]))
    resolveAliases(Response.json([]))
    resolveUpdates(Response.json({ status: 'idle', items: {} }))
    await load
  })
})

test('offers a retry when the local list fails, then shows the true empty state', async t => {
  let attempts = 0
  stubFetch(t, ({ path }) => {
    if (path === '/sites') return ++attempts === 1 ? new Response(null, { status: 503 }) : Response.json([])
    return Response.json({ status: 'checking', items: {} })
  })
  siteStore.setState({ sites: [], sitesStatus: 'idle' })
  await mount(t, AdapterManagement)
  await act(async () => siteStore.getState().loadSites())
  assert.match(document.querySelector('[role="status"]').textContent, /无法读取/)
  await act(async () => button('重试').click())
  assert.match(document.querySelector('[role="status"]').textContent, /暂无已安装/)
})

test('shows catalog loading in the notification and clears it when the request settles', async t => {
  let resolveCatalog
  stubFetch(t, () => new Promise(resolve => { resolveCatalog = resolve }))
  await mount(t, AdapterHub)
  assert.equal(lastNotice()?.message, '正在加载 AdapterHub…')
  assert.equal(lastNotice()?.type, 'loading')
  assert.doesNotMatch(document.querySelector('.adapter-hub').textContent, /正在加载/)
  await act(async () => resolveCatalog(Response.json({ page: 1, hasMore: false, items: [] })))
  assert.equal(lastNotice(), undefined)
})

test('loads one page at a time and retains cards while retrying the next page', async t => {
  let intersect, resolvePage, attempts = 0
  globalThis.IntersectionObserver = class {
    constructor(callback) { intersect = () => callback([{ isIntersecting: true }]) }
    observe() {}
    disconnect() {}
  }
  t.after(() => { delete globalThis.IntersectionObserver })
  const calls = stubFetch(t, ({ params }) => {
    if (params.get('page') === '1') return Response.json({ page: 1, hasMore: true, items: [{ name: 'example.first' }] })
    if (++attempts === 1) return new Promise(resolve => { resolvePage = resolve })
    return Response.json({ page: 2, hasMore: false, items: [{ name: 'example.next' }] })
  })
  await mount(t, AdapterHub)
  assert.equal(calls.length, 1)
  await act(async () => { intersect(); intersect() })
  assert.equal(calls.length, 2)
  assert.ok(document.querySelector('.adapter-hub__spinner'))
  await act(async () => resolvePage(new Response(null, { status: 503 })))
  assert.equal(document.querySelectorAll('.tool-package-entry--hub').length, 1)
  await act(async () => button('加载失败，重试').click())
  assert.deepEqual(calls.map(({ params }) => params.get('page')), ['1', '2', '2'])
  assert.equal(document.querySelectorAll('.tool-package-entry--hub').length, 2)
  assert.equal(document.querySelector('.adapter-hub__pagination'), null)
})

test('searches AdapterHub entries and installs the selected version', async t => {
  const calls = stubFetch(t, ({ path, params }) => {
    if (path === '/adapter-hub/install-progress') return Response.json({ items: [] })
    if (path === '/adapter-hub') return Response.json({ page: Number(params.get('page')), hasMore: false, items: params.get('q') ? [
      { name: 'example.news', description: '示例资讯能力', version: '0.4.0', installedVersion: '0.4.0', action: null },
    ] : [
      { name: 'example.mail', description: '示例邮箱能力', version: '1.2.0', official: true },
      { name: 'example.news', description: '示例资讯能力', version: '0.4.0', installedVersion: '0.4.0', action: null },
      { name: 'example.local', version: '2.0.0', action: null, unavailableReason: 'Hub 尚未发布安装包' },
    ] })
    if (path === '/adapter-hub/example.mail/install') return Response.json({ name: 'example.mail', version: '1.2.0', site: { id: 'example.mail', name: 'example.mail', description: '示例邮箱能力', enabled: true, version: '1.2.0' } })
    if (path === '/sites') return Response.json([site])
    throw new Error(`Unexpected path ${path}`)
  })
  siteStore.setState({ sites: [site] })
  const render = await mount(t, AdapterHub)
  const rows = () => [...document.querySelectorAll('.tool-package-entry--hub')]
  assert.equal(rows().length, 3)
  assert.equal(rows()[2].querySelector('.tool-package-card-action').textContent.trim(), '不可安装')
  assert.match(rows()[2].textContent, /Hub 尚未发布安装包/)
  assert.equal(rows()[2].querySelector('.tool-package-card-action').disabled, true)
  assert.equal(rows()[1].querySelector('.tool-package-card-action').textContent.trim(), '已安装')
  assert.equal(rows()[1].querySelector('.tool-package-card-action').disabled, true)
  const search = document.querySelector('.adapter-hub__search')
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(search, '资讯')
    search.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await act(async () => delay(260))
  assert.ok(calls.some(({ params }) => params.get('q') === '资讯' && params.get('page') === '1'))
  assert.deepEqual(rows().map(row => row.querySelector('.tool-package-entry__title').textContent), ['example.news'])
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(search, '')
    search.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await act(async () => {
    rows()[0].querySelector('.tool-package-card-action').click()
    await delay(320)
  })
  assert.deepEqual(calls.filter(({ path }) => path.includes('/install') && path !== '/adapter-hub/install-progress').map(({ path, method, body }) => [path, method, body]), [
    ['/adapter-hub/example.mail/install', 'POST', { version: '1.2.0' }],
  ])
  assert.equal(lastNotice().type, 'success')
  assert.equal(lastNotice().message, '已安装 example.mail')
  assert.ok(siteStore.getState().sites.some(item => item.id === 'example.mail' && item.version === '1.2.0'))
  await render(AdapterManagement)
  assert.ok([...document.querySelectorAll('.tool-package-entry--adapter')].some(card => /example\.mail.*当前 1\.2\.0/.test(card.textContent)))
  assert.equal(calls.some(({ path }) => path === '/sites'), false)
})

test('fills the Hub update button while waiting and switches to measured progress', async t => {
  let finishInstall
  const installResponse = new Promise(resolve => { finishInstall = resolve })
  const totalBytes = 2 * 1024 * 1024
  let progress = []
  stubFetch(t, ({ path }) => {
    if (path === '/adapter-hub') return Response.json({ page: 1, hasMore: false, items: [
      { name: 'example.com', version: '1.2.0', installedVersion: '1.1.0', action: 'update', totalBytes },
    ] })
    if (path === '/adapter-hub/install-progress') return Response.json({ items: progress })
    if (path === '/adapter-hub/example.com/install') return installResponse
    throw new Error(`Unexpected path ${path}`)
  })
  await mount(t, AdapterHub)
  await act(async () => button('更新').click())
  const footer = document.querySelector('.tool-package-entry__footer')
  assert.match(footer.firstElementChild.textContent, /已安装 1\.1\.0/)
  assert.equal(footer.children.length, 1)
  const transfer = button('准备中…')
  const width = () => transfer.style.getPropertyValue('--transfer-progress')
  assert.equal(transfer.disabled, true)
  assert.equal(width(), '4%')
  await act(async () => delay(320))
  assert.ok(parseInt(width(), 10) > 4)
  progress = [{ name: 'example.com', status: 'downloading', receivedBytes: 966000, totalBytes, bytesPerSecond: 256 * 1024 }]
  await act(async () => delay(420))
  assert.equal(width(), '46%')
  assert.match(transfer.title, /46% \(943\.4KB\/2\.00MB\) · 256\.0KB\/s/)
  for (const [status, label] of [['verifying', '校验中…'], ['extracting', '解包中…'], ['writing', '写入中…']]) {
    progress = [{ name: 'example.com', status, receivedBytes: totalBytes, totalBytes }]
    await act(async () => delay(420))
    assert.equal(button(label).title, label)
    assert.equal(width(), '100%')
  }
  progress = []
  await act(async () => finishInstall(Response.json({ name: 'example.com', version: '1.2.0' })))
  assert.equal(width(), '100%')
  await act(async () => delay(320))
  assert.ok(button('已安装').disabled)
})

test('pauses installed Adapter update progress at halfway and advances with measured bytes', async t => {
  let finishUpdate
  let transfer = null
  const response = new Promise(resolve => { finishUpdate = resolve })
  stubFetch(t, ({ path }) => {
    if (path === '/adapter-updates') return snapshot('ready', item)
    if (path === '/adapter-updates/progress') return Response.json({ transfer })
    if (path === `/adapter-updates/${site.id}/apply`) return response
    if (path === '/sites') return Response.json([{ ...site, version: '1.1.0' }])
    throw new Error(`Unexpected path ${path}`)
  })
  siteStore.setState({ sites: [site] })
  await mount(t, AdapterManagement)
  await act(async () => button('更新').click())
  const progress = button('更新中…')
  const width = () => progress.style.getPropertyValue('--transfer-progress')
  assert.equal(progress.disabled, true)
  assert.equal(width(), '4%')
  transfer = { name: site.id, status: 'downloading', receivedBytes: 200, totalBytes: 1000 }
  await act(() => delay(430))
  assert.match(progress.title, /20%/)
  await act(() => delay(6000))
  assert.equal(width(), '50%')
  transfer = { ...transfer, receivedBytes: 760 }
  await act(() => delay(430))
  assert.equal(width(), '76%')
  assert.match(progress.title, /76%/)
  transfer = { ...transfer, status: 'writing', receivedBytes: 1000 }
  await act(() => delay(430))
  assert.equal(width(), '100%')
  assert.equal(button('写入中…'), progress)
  await act(async () => finishUpdate(snapshot('ready', { ...item, currentVersion: '1.1.0', status: 'current' })))
  assert.equal(document.querySelector('.adapter-hub__transfer'), null)
  assert.equal(lastNotice().type, 'success')
})

test('filters installed Adapters locally and restores the list when cleared', async t => {
  const calls = stubFetch(t, () => snapshot('ready'))
  siteStore.setState({ sites: [site, { ...site, id: 'mail.example.org', name: 'Mail', description: '收发邮件' }] })
  await mount(t, AdapterManagement)
  const search = document.querySelector('[aria-label="搜索已安装的 Adapter"]')
  const titles = () => [...document.querySelectorAll('.tool-package-entry__title')].map(node => node.textContent)
  const enter = value => act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(search, value)
    search.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await enter(' MAIL.EXAMPLE ')
  assert.deepEqual(titles(), ['Mail'])
  await enter('邮件')
  assert.deepEqual(titles(), ['Mail'])
  await enter('没有对应结果')
  assert.match(document.querySelector('[role="status"]').textContent, /没有匹配/)
  await enter('')
  assert.deepEqual(titles(), ['Example', 'Mail'])
  assert.deepEqual(calls.map(call => call.path), ['/adapter-updates'])
})

test('opens local Adapter details from the installed inventory without a Hub request', async t => {
  const calls = stubFetch(t, ({ path }) => {
    if (path === '/adapter-updates') return snapshot('ready')
    throw new Error(`Unexpected path ${path}`)
  })
  siteStore.setState({ sites: [{ ...site, uploader: '官方', domains: ['example.org'], scenarios: [{ title: 'Local scenario', prompts: [{ text: 'Local prompt' }] }] }] })
  await mount(t, AdapterManagement)
  await act(async () => document.querySelector('.tool-package-entry--adapter').click())
  assert.match(document.querySelector('.adapter-detail').textContent, /Example.*1\.0\.0.*Local scenario.*Local prompt.*包含命令.*list/)
  assert.equal(document.querySelector('.adapter-detail__metadata').textContent, '上传用户：官方域名：example.org')
  assert.deepEqual(calls.map(call => call.path), ['/adapter-updates'])
  await act(async () => button('返回列表').click())
  assert.ok(document.querySelector('.tool-package-entry--adapter'))
})

test('shows Hub detail loading in a notification and dismisses it on return', async t => {
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  const calls = stubFetch(t, ({ path }) => {
    if (path === '/adapter-hub') return Response.json({ page: 1, hasMore: false, items: [{ name: site.id, version: '2.0.0' }] })
    if (path === '/adapter-hub/install-progress') return Response.json({ items: [] })
    if (path === `/adapter-hub/${site.id}/detail`) return pending
    throw new Error(`Unexpected path ${path}`)
  })
  await mount(t, AdapterHub)
  await act(async () => document.querySelector('.tool-package-entry--hub').click())
  assert.equal(lastNotice().type, 'loading')
  assert.equal(lastNotice().message, '正在加载详情…')
  assert.equal(document.querySelector('.adapter-detail').textContent, '返回列表')
  await act(async () => button('返回列表').click())
  assert.equal(lastNotice(), undefined)
  assert.equal(calls.at(-1).signal.aborted, true)
  await act(async () => finish(Response.json({ name: site.id })))
  assert.ok(document.querySelector('.tool-package-entry--hub'))
})

test('opens Hub details from the remote endpoint and installs from the detail view', async t => {
  const id = 'example.com'
  const calls = stubFetch(t, ({ path }) => {
    if (path === '/adapter-hub') return Response.json({ page: 1, hasMore: false, items: [{ name: id, version: '2.0.0', action: 'install' }] })
    if (path === '/adapter-hub/install-progress') return Response.json({ items: [] })
    if (path === `/adapter-hub/${id}/detail`) return Response.json({ name: id, display: 'Remote Adapter', uploader: 'example-user', domains: ['api.example.org'], version: '2.0.0', downloads: 3, favoriteCount: 2, scenarios: [{ title: 'Remote scenario', prompts: [{ text: 'Remote prompt' }] }], commands: [{ commandName: 'list-items', parametersSchema: { properties: { query: { type: 'string', description: 'Search text' } }, required: ['query'] } }] })
    if (path === `/adapter-hub/${id}/install`) return Response.json({ site: { ...site, version: '2.0.0' } })
    throw new Error(`Unexpected path ${path}`)
  })
  await mount(t, AdapterHub)
  await act(async () => document.querySelector('.tool-package-entry--hub').click())
  assert.match(document.querySelector('.adapter-detail').textContent, /Remote Adapter.*Remote scenario.*Remote prompt/)
  assert.equal(document.querySelector('.adapter-detail__metadata').textContent, '上传用户：example-user域名：api.example.org')
  const command = document.querySelector('.adapter-detail details')
  assert.match(command.textContent, /list-items.*query.*必填.*Search text/s)
  await act(async () => {
    button('安装').click()
    await delay(320)
  })
  assert.ok(button('已安装').disabled)
  assert.ok(calls.some(call => call.path === `/adapter-hub/${id}/install` && call.body.version === '2.0.0'))
  assert.equal(calls.some(call => call.path === '/sites'), false)
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

test('renders the complete workspace and refreshes Adapter Skills only on the Skills tab', async t => {
  const calls = stubFetch(t, ({ path, params }) => {
    if (path === '/adapter-updates') return snapshot('idle')
    if (path === '/sites') return Response.json([site])
    if (path === '/skills') return Response.json([{ name: 'example-public-skill', enabled: true }])
    if (path === '/adapter-hub') return Response.json({ page: Number(params.get('page')), hasMore: false, items: [{ name: 'example-hub-adapter', description: '示例远端 Adapter', version: '2.0.0', official: true }] })
    return Response.json([])
  })
  siteStore.setState({ sites: [site] })
  workspace.useToolPackagePageStore.getState().openPage()
  await mount(t, ToolPackagePage)
  assert.equal(document.querySelector('h1'), null)
  const topTabs = () => [...document.querySelectorAll('.header-tab-row [role="tab"]')]
  const viewTabs = () => [...document.querySelectorAll('.adapter-view-tabs [role="tab"]')]
  assert.deepEqual(topTabs().map(tab => tab.textContent.trim()), ['Adapter', 'Skills', '场景'])
  assert.deepEqual(viewTabs().map(tab => tab.textContent.trim()), ['已安装 Adapter', 'AdapterHub'])
  assert.equal(viewTabs()[0].getAttribute('aria-selected'), 'true')
  await act(async () => viewTabs()[1].click())
  assert.equal(document.querySelector('.adapter-hub__search').getAttribute('placeholder'), '搜索 Adapter')
  assert.match(document.querySelector('.tool-package-entry--hub').textContent, /example-hub-adapter.*2\.0\.0.*官方/)
  await act(async () => viewTabs()[0].click())
  assert.match(document.querySelector('.tool-package-entry--adapter').textContent, /1\.0\.0/)
  const refreshCalls = () => calls.filter(({ path, params }) => path === '/skills' && params.get('refreshAdapters') === '1')
  assert.equal(refreshCalls().length, 0)
  await act(async () => topTabs()[1].click())
  assert.equal(refreshCalls().length, 1)
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
