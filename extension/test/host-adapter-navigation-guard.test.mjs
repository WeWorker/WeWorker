import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

import {
  NAVIGATION_TARGET_SETTLE_MS,
    adapterPageStartUrl,
  assertAdapterNavigationUrl,
  classifyNavigationTarget,
  createNavigationGuard,
  navigateAdapterTab,
  tabMatchesPageStart,
} from '../background/host-adapter-runtime.js'

const MANIFEST = {
  name: 'example',
  match: ['example.com', '*.example.org'],
  runtime_allowed_hosts: ['helper.example.net'],
}

// ─── classifyNavigationTarget: 判定口径 ───────────────────────────────────────

test('classifyNavigationTarget treats declared hosts as allowed', () => {
  assert.equal(classifyNavigationTarget(MANIFEST, 'https://example.com/orders'), 'allowed')
  assert.equal(classifyNavigationTarget(MANIFEST, 'http://example.com/orders?page=2'), 'allowed')
  assert.equal(classifyNavigationTarget(MANIFEST, 'https://www.example.org/inbox'), 'allowed')
  assert.equal(classifyNavigationTarget(MANIFEST, 'https://a.b.example.org/x'), 'allowed')
})

test('classifyNavigationTarget keeps the existing manifest.match semantics', () => {
  // 精确条目不隐含子域（与 assertAdapterNavigationUrl 原语义一致）。
  assert.equal(classifyNavigationTarget(MANIFEST, 'https://www.example.com/x'), 'forbidden')
  // 本项目统一约定 `*.example.org` 同时覆盖裸域及其全部子域。
  assert.equal(classifyNavigationTarget(MANIFEST, 'https://example.org/x'), 'allowed')
  // runtime_allowed_hosts 仅用于终止性导航（resume === false）。
  assert.equal(classifyNavigationTarget(MANIFEST, 'https://helper.example.net/api'), 'forbidden')
  assert.equal(classifyNavigationTarget(MANIFEST, 'https://helper.example.net/api', false), 'allowed')
  // 带凭据的 URL 一律拒绝。
  assert.equal(classifyNavigationTarget(MANIFEST, 'https://user:pw@example.com/'), 'forbidden')
})

test('classifyNavigationTarget cannot judge non-page targets yet', () => {
  assert.equal(classifyNavigationTarget(MANIFEST, 'about:blank'), 'unknown')
  assert.equal(classifyNavigationTarget(MANIFEST, 'chrome-error://chromewebdata/'), 'unknown')
  assert.equal(classifyNavigationTarget(MANIFEST, 'data:text/html,<p>x</p>'), 'unknown')
  assert.equal(classifyNavigationTarget(MANIFEST, ''), 'unknown')
  assert.equal(classifyNavigationTarget(MANIFEST, 'not a url'), 'unknown')
  assert.equal(classifyNavigationTarget(MANIFEST, undefined), 'unknown')
})
test('adapterPageStartUrl prefers a same-host homepage with a special port and path', () => {
  const manifest = {
    name: 'weoa.webank.com',
    match: ['weoa.webank.com'],
    homepage_url: 'https://weoa.webank.com:8443/s_iv/#/',
  }
  assert.equal(adapterPageStartUrl(manifest, 'weoa.webank.com'), 'https://weoa.webank.com:8443/s_iv/#/')
  assert.equal(adapterPageStartUrl({ match: ['example.com'] }, 'example.com'), 'http://example.com/')
  assert.equal(
    adapterPageStartUrl({ match: ['mail.example.com'], homepage_url: 'https://github.com/WeWorker/WeWorker' }, 'mail.example.com'),
    'http://mail.example.com/',
  )
  assert.equal(
    adapterPageStartUrl({ match: ['order.example.com'], homepage_url: 'https://www.example.com/' }, 'order.example.com'),
    'http://order.example.com/',
  )
})

test('tabMatchesPageStart rejects a same-host tab on a different origin', () => {
  const start = 'https://weoa.webank.com:8443/s_iv/#/'
  assert.equal(tabMatchesPageStart({ url: 'https://weoa.webank.com/#/submit?source=kaobao' }, start, 'weoa.webank.com'), false)
  assert.equal(tabMatchesPageStart({ url: 'https://weoa.webank.com:8443/s_iv/#/' }, start, 'weoa.webank.com'), true)
  assert.equal(tabMatchesPageStart({ url: 'https://example.com/other' }, 'http://example.com/', 'example.com'), true)
})

test('assertAdapterNavigationUrl keeps its error messages and behaviour', () => {
  assert.equal(assertAdapterNavigationUrl(MANIFEST, 'https://example.com/a'), 'https://example.com/a')
  assert.equal(assertAdapterNavigationUrl(MANIFEST, 'https://www.example.org/b'), 'https://www.example.org/b')
  assert.throws(
    () => assertAdapterNavigationUrl(MANIFEST, 'https://www.example.com/a'),
    /Adapter navigation host is not allowed\./,
  )
  assert.throws(
    () => assertAdapterNavigationUrl(MANIFEST, 'about:blank'),
    /Adapter navigation host is not allowed\./,
  )
  assert.throws(
    () => assertAdapterNavigationUrl(MANIFEST, 'https://user:pw@example.com/'),
    /Adapter navigation host is not allowed\./,
  )
  assert.throws(
    () => assertAdapterNavigationUrl(MANIFEST, '::::'),
    /Invalid Adapter navigation URL\./,
  )
})

// ─── createNavigationGuard: 稳定窗口判定 ─────────────────────────────────────

test('settle window is long enough for a redirect chain and bounded for a dead end', () => {
  assert.ok(NAVIGATION_TARGET_SETTLE_MS >= 1000, '需要给重定向留出窗口')
  assert.ok(NAVIGATION_TARGET_SETTLE_MS <= 3000, '否则 fail-fast 收益被吃掉')
})

test('① a URL that stays on an undeclared host is rejected once it settles', () => {
  const guard = createNavigationGuard(MANIFEST, true, { settleMs: 300 })
  assert.equal(guard.observe('https://www.example.com/very-slow-page', 0), 'wait')
  assert.equal(guard.observe('https://www.example.com/very-slow-page', 150), 'wait')
  assert.equal(guard.observe('https://www.example.com/very-slow-page', 299), 'wait')
  assert.equal(guard.observe('https://www.example.com/very-slow-page', 300), 'reject')
})

test('② a declared host is never rejected, however slow the page is', () => {
  const guard = createNavigationGuard(MANIFEST, true, { settleMs: 300 })
  assert.equal(guard.observe('https://example.com/slow', 0), 'wait')
  assert.equal(guard.observe('https://example.com/slow', 60_000), 'wait')
  assert.equal(guard.observe('https://www.example.org/slow', 120_000), 'wait')
})

test('③ hop to an undeclared host that redirects to a declared host is not rejected', () => {
  const guard = createNavigationGuard(MANIFEST, true, { settleMs: 300 })
  assert.equal(guard.observe('https://www.example.com/landing', 0), 'wait')
  assert.equal(guard.observe('https://www.example.com/landing', 250), 'wait')
  assert.equal(guard.observe('https://example.com/real', 400), 'wait')
  // 回到非白名单 host 时计时重新开始，不继承上一次的停留时间。
  assert.equal(guard.observe('https://www.example.com/landing', 500), 'wait')
  assert.equal(guard.observe('https://www.example.com/landing', 700), 'wait')
  assert.equal(guard.observe('https://www.example.com/landing', 800), 'reject')
})

test('④ a URL that is still changing between undeclared hosts is not rejected', () => {
  const guard = createNavigationGuard(MANIFEST, true, { settleMs: 300 })
  const chain = [
    'https://a.example.com/1',
    'https://b.example.com/2',
    'https://c.example.com/3',
    'https://d.example.com/4',
  ]
  for (const [index, url] of chain.entries()) {
    assert.equal(guard.observe(url, index * 400), 'wait')
  }
})

test('⑤ the guard follows manifest.match wildcards and runtime_allowed_hosts', () => {
  const resumeGuard = createNavigationGuard(MANIFEST, true, { settleMs: 100 })
  assert.equal(resumeGuard.observe('https://www.example.org/x', 0), 'wait')
  assert.equal(resumeGuard.observe('https://www.example.org/x', 5000), 'wait')
  // 终止性导航允许的 helper host，在需要继续执行的 resume 语义下仍视为不允许。
  assert.equal(resumeGuard.observe('https://helper.example.net/x', 0), 'wait')
  assert.equal(resumeGuard.observe('https://helper.example.net/x', 100), 'reject')

  const terminalGuard = createNavigationGuard(MANIFEST, false, { settleMs: 100 })
  assert.equal(terminalGuard.observe('https://helper.example.net/x', 0), 'wait')
  assert.equal(terminalGuard.observe('https://helper.example.net/x', 100), 'wait')
})

test('targets that cannot be judged yet reset the window', () => {
  const guard = createNavigationGuard(MANIFEST, true, { settleMs: 300 })
  guard.observe('https://www.example.com/a', 0)
  assert.equal(guard.observe('about:blank', 250), 'wait')
  assert.equal(guard.observe('https://www.example.com/a', 400), 'wait')
  assert.equal(guard.observe('https://www.example.com/a', 700), 'reject')
})

// ─── navigateAdapterTab: 真实等待循环里的 fail-fast ──────────────────────────

function fakeTabsApi(samples, { stepMs = 500, advance = () => {} } = {}) {
  let index = 0
  return {
    api: {
      tabs: {
        onUpdated: { addListener() {}, removeListener() {} },
        async get() {
          advance(stepMs)
          const sample = samples[Math.min(index, samples.length - 1)]
          index += 1
          return typeof sample === 'string' ? { url: sample, status: 'loading' } : sample
        },
        async reload() {},
        async update() {},
      },
    },
  }
}

async function withFakeClock(run) {
  const realNow = Date.now
  let now = 0
  Date.now = () => now
  const clock = { advance: (ms) => { now += ms }, read: () => now }
  try {
    return await run(clock)
  } finally {
    Date.now = realNow
  }
}

test('navigateAdapterTab fails fast when a redirect settles on an undeclared host', async () => {
  await withFakeClock(async (clock) => {
    const { api } = fakeTabsApi([
      'https://example.com/',
      'https://www.example.com/very-slow-page',
    ], { stepMs: 500, advance: clock.advance })
    await assert.rejects(
      navigateAdapterTab(api, 7, 'https://example.com/', MANIFEST, true, 60_000),
      /Adapter navigation host is not allowed\./,
    )
    assert.ok(clock.read() <= 4000, `应在稳定窗口后立即失败，实际等待 ${clock.read()}ms`)
  })
})

test('navigateAdapterTab still waits for a redirect that lands on a declared host', async () => {
  await withFakeClock(async (clock) => {
    const { api } = fakeTabsApi([
      'https://www.example.com/hop',
      'https://www.example.com/hop',
      { url: 'https://example.com/landed', status: 'complete' },
    ], { stepMs: 400, advance: clock.advance })
    // onUpdated 在真实扩展里负责 complete 事件；这里让 API 直接补发一次。
    api.tabs.onUpdated.addListener = (listener) => {
      setTimeout(() => listener(7, { status: 'complete' }), 0)
    }
    const result = await navigateAdapterTab(api, 7, 'https://example.com/', MANIFEST, true, 60_000)
    assert.equal(result, 'https://example.com/landed')
  })
})

// ─── waitForManagedPageReady: 真正的 service worker 循环 ─────────────────────

const serviceWorkerSource = fs.readFileSync(new URL('../background/service-worker.js', import.meta.url), 'utf8')

function loadWaitForManagedPageReady(samples) {
  const start = serviceWorkerSource.indexOf('async function waitForManagedPageReady')
  assert.ok(start >= 0, 'missing waitForManagedPageReady')
  const end = serviceWorkerSource.indexOf('\n}\n', start)
  assert.ok(end > start, 'missing end of waitForManagedPageReady')
  const source = serviceWorkerSource.slice(start, end + 2)

  let index = 0
  let now = 0
  const traces = []
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length > 0 ? args : [now])) }
    static now() { return now }
  }
  const context = vm.createContext({
    assertNotOnLoginPage: () => {},
    assertAdapterNavigationUrl,
    createNavigationGuard,
    console: { log() {}, warn() {}, error() {} },
    traceLog: (traceID, message) => traces.push([traceID, message]),
    setTimeout: (fn, ms) => { now += Number(ms) || 0; fn(); return 0 },
    clearTimeout() {},
    Date: FakeDate,
    URL,
    Error,
    Promise,
    chrome: {
      tabs: {
        async get() {
          const sample = samples[Math.min(index, samples.length - 1)]
          index += 1
          return typeof sample === 'string' ? { url: sample, status: 'loading' } : sample
        },
      },
    },
  })
  vm.runInContext(`${source}\nthis.waitForManagedPageReady = waitForManagedPageReady;`, context)
  return {
    wait: (manifest, resume, timeoutMs) => context.waitForManagedPageReady(9, manifest, resume, timeoutMs, 'trace-1'),
    polls: () => index,
    traces,
  }
}

test('waitForManagedPageReady rejects the jd.com-style redirect without waiting for complete', async () => {
  const harness = loadWaitForManagedPageReady([
    { url: 'https://example.com/', status: 'loading' },
    'https://www.example.com/',
  ])
  await assert.rejects(
    harness.wait(MANIFEST, true, 20_000),
    /Adapter navigation host is not allowed\./,
  )
  // 稳定窗口（1500ms）按 150ms 轮询：约 11 次即可判定，不再等 7s 级的页面加载完成。
  assert.ok(harness.polls() <= 13, `判定前轮询 ${harness.polls()} 次`)
  assert.equal(harness.traces.length, 1)
  assert.match(harness.traces[0][0], /^trace-1$/)
  assert.match(harness.traces[0][1], /提前结束等待/)
})

test('waitForManagedPageReady keeps waiting when the redirect lands on a declared host', async () => {
  const harness = loadWaitForManagedPageReady([
    'https://www.example.com/hop',
    'https://www.example.com/hop',
    'https://example.com/landed',
    { url: 'https://example.com/landed', status: 'complete' },
  ])
  assert.equal(await harness.wait(MANIFEST, true, 20_000), 'https://example.com/landed')
  assert.equal(harness.traces.length, 0)
})

test('waitForManagedPageReady never fails a declared host that simply loads slowly', async () => {
  const samples = []
  for (let i = 0; i < 60; i += 1) samples.push('https://example.com/slow-page')
  samples.push({ url: 'https://example.com/slow-page', status: 'complete' })
  const harness = loadWaitForManagedPageReady(samples)
  assert.equal(await harness.wait(MANIFEST, true, 60_000), 'https://example.com/slow-page')
  assert.equal(harness.traces.length, 0)
})

test('waitForManagedPageReady still reports an undeclared host when the page finishes loading', async () => {
  const harness = loadWaitForManagedPageReady([
    { url: 'https://www.example.com/instant', status: 'complete' },
  ])
  await assert.rejects(
    harness.wait(MANIFEST, true, 20_000),
    /Adapter navigation host is not allowed\./,
  )
})
