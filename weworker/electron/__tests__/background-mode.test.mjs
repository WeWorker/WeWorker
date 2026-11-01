import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  HIDDEN_LAUNCH_ARG,
  buildLoginItemSettings,
  buildQuitDialog,
  createBackgroundController,
  createPreferenceStore,
  fetchAgentSummary,
  isHiddenLaunch,
  isLaunchAtLoginSupported,
  normalizePreferences,
  summarizeAgents,
  syncLaunchAtLogin,
  trayTooltip,
} from '../background-mode.js'
import { buildTrayMenuTemplate } from '../tray-manager.js'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-background-'))
}

function memoryPreferences(initial = {}) {
  let current = normalizePreferences(initial)
  return {
    get: () => ({ ...current }),
    update(patch) {
      current = normalizePreferences({ ...current, ...patch })
      return { ...current }
    },
  }
}

function fakeWindow() {
  const calls = []
  return {
    calls,
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: () => calls.push('restore'),
    hide: () => calls.push('hide'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
  }
}

function controller({ platform = 'win32', preferences = memoryPreferences(), summary = { total: 0, online: 0, names: [] }, choice = 1 } = {}) {
  const win = fakeWindow()
  const events = { quit: 0, dialogs: [], hidden: 0 }
  const background = createBackgroundController({
    platform,
    preferences,
    getWindow: () => win,
    getAgentSummary: async () => summary,
    showQuitDialog: async (options) => { events.dialogs.push(options); return choice },
    quitApp: () => { events.quit += 1 },
    onHidden: () => { events.hidden += 1 },
  })
  return { background, win, events }
}

const preventable = () => {
  const event = { prevented: false, preventDefault() { this.prevented = true } }
  return event
}

test('preferences default to close-to-tray and undecided launch at login, and persist', () => {
  assert.deepEqual(normalizePreferences(null), { closeToTray: true, launchAtLogin: null, backgroundHintShown: false })
  assert.deepEqual(normalizePreferences({ closeToTray: false, launchAtLogin: 'yes' }), { closeToTray: false, launchAtLogin: null, backgroundHintShown: false })

  const dir = tempDir()
  try {
    const file = path.join(dir, 'app-settings.json')
    const store = createPreferenceStore(file)
    assert.equal(store.get().closeToTray, true)
    store.update({ closeToTray: false, launchAtLogin: true })
    assert.deepEqual(createPreferenceStore(file).get(), { closeToTray: false, launchAtLogin: true, backgroundHintShown: false })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('launch at login is only registered by packaged Windows/macOS builds and defaults on', () => {
  assert.equal(isLaunchAtLoginSupported({ isPackaged: false, platform: 'win32' }), false)
  assert.equal(isLaunchAtLoginSupported({ isPackaged: true, platform: 'linux' }), false)
  assert.equal(isLaunchAtLoginSupported({ isPackaged: true, platform: 'darwin' }), true)
  assert.deepEqual(
    buildLoginItemSettings({ enabled: true, platform: 'win32', execPath: 'C:/weworker-fixtures/WeWorker.exe' }),
    { openAtLogin: true, path: 'C:/weworker-fixtures/WeWorker.exe', args: [HIDDEN_LAUNCH_ARG], name: 'WeWorker' },
  )
  assert.deepEqual(buildLoginItemSettings({ enabled: false, platform: 'darwin' }), { openAtLogin: false })

  const applied = []
  const app = { setLoginItemSettings: (settings) => applied.push(settings) }
  const preferences = memoryPreferences()
  assert.deepEqual(syncLaunchAtLogin({ app, preferences, isPackaged: true, platform: 'win32', execPath: 'C:/weworker-fixtures/WeWorker.exe' }), { supported: true, enabled: true })
  assert.equal(preferences.get().launchAtLogin, true)
  assert.equal(applied[0].openAtLogin, true)

  preferences.update({ launchAtLogin: false })
  assert.deepEqual(syncLaunchAtLogin({ app, preferences, isPackaged: true, platform: 'win32', execPath: 'C:/weworker-fixtures/WeWorker.exe' }), { supported: true, enabled: false })
  assert.equal(applied[1].openAtLogin, false)

  const devApp = { setLoginItemSettings: () => { throw new Error('must not register a dev build') } }
  assert.deepEqual(syncLaunchAtLogin({ app: devApp, preferences: memoryPreferences(), isPackaged: false, platform: 'win32' }), { supported: false, enabled: false })
})

test('hidden launch is detected from the login argument or macOS login item', () => {
  assert.equal(isHiddenLaunch({ argv: ['WeWorker.exe', HIDDEN_LAUNCH_ARG], platform: 'win32' }), true)
  assert.equal(isHiddenLaunch({ argv: ['WeWorker.exe'], platform: 'win32' }), false)
  assert.equal(isHiddenLaunch({ argv: [], platform: 'darwin', loginItemSettings: { wasOpenedAtLogin: true } }), true)
  assert.equal(isHiddenLaunch({ argv: [], platform: 'darwin', loginItemSettings: { wasOpenedAtLogin: false } }), false)
})

test('disabled login integration neither touches the OS nor persists a preference', () => {
  for (const platform of ['win32', 'darwin']) {
    for (const value of [null, true, false]) {
      const preferences = memoryPreferences({ launchAtLogin: value })
      const app = { setLoginItemSettings: () => { throw new Error('must not touch OS settings') } }
      assert.deepEqual(syncLaunchAtLogin({ app, preferences, isPackaged: true, platform, disabled: true }), { supported: false, enabled: false })
      assert.equal(preferences.get().launchAtLogin, value)
    }
  }
})

test('agent summary counts enabled agents and falls back to the records file', async () => {
  assert.deepEqual(summarizeAgents([
    { name: 'Example Operations Assistant', enabled: true, connection: { status: 'connected' } },
    { name: 'inventory-helper', enabled: true, connection: { status: 'error' } },
    { name: 'disabled', enabled: false },
  ]), { total: 2, online: 1, names: ['Example Operations Assistant', 'inventory-helper'] })

  const calls = []
  const fromBackend = await fetchAgentSummary({
    token: 'placeholder-token',
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return { ok: true, json: async () => ({ agents: [{ name: 'A', enabled: true, connection: { status: 'connected' } }] }) }
    },
  })
  assert.deepEqual(fromBackend, { total: 1, online: 1, names: ['A'], source: 'backend' })
  assert.equal(calls[0].url, 'http://127.0.0.1:8765/dedicated-agents')
  assert.equal(calls[0].init.headers['X-WeWorker-Auth'], 'placeholder-token')
  assert.equal(calls[0].init.redirect, 'error')

  const dir = tempDir()
  try {
    const agentsFile = path.join(dir, 'dedicated-agents.json')
    fs.writeFileSync(agentsFile, JSON.stringify({ agents: [{ name: 'Offline', enabled: true, wecom: { secret_enc: 'placeholder' } }] }))
    const fromFile = await fetchAgentSummary({ fetchImpl: async () => { throw new Error('offline') }, agentsFile })
    assert.deepEqual(fromFile, { total: 1, online: 0, names: ['Offline'], source: 'file' })
    const empty = await fetchAgentSummary({ fetchImpl: async () => ({ ok: false }), agentsFile: path.join(dir, 'missing.json') })
    assert.equal(empty.total, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('quit dialog and tray text describe bound agents', () => {
  const dialog = buildQuitDialog({ total: 7, names: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })
  assert.match(dialog.message, /7 个专属 Agent/)
  assert.match(dialog.detail, /等 7 个/)
  assert.deepEqual(dialog.buttons, ['留在后台运行', '仍然退出', '取消'])
  assert.equal(trayTooltip(null), 'WeWorker')
  assert.equal(trayTooltip({ total: 2, online: 1, source: 'backend' }), 'WeWorker · 专属 Agent 1/2 在线')
  assert.equal(trayTooltip({ total: 2, online: 0, source: 'file' }), 'WeWorker · 2 个专属 Agent')
})

test('closing the window hides it on Windows by default and on macOS always', () => {
  for (const platform of ['win32', 'darwin']) {
    const { background, win, events } = controller({ platform })
    const event = preventable()
    assert.equal(background.handleWindowClose(event), 'hidden')
    assert.equal(event.prevented, true)
    assert.deepEqual(win.calls, ['hide'])
    assert.equal(events.hidden, 1)
    assert.equal(events.quit, 0)
  }
})

test('with close-to-tray off on Windows, closing the window requests a quit', async () => {
  const { background, events } = controller({ preferences: memoryPreferences({ closeToTray: false }) })
  assert.equal(background.handleWindowClose(preventable()), 'quit-requested')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(events.quit, 1)
  assert.equal(background.handleWindowClose(preventable()), 'close')
})

test('a real quit asks first when agents are bound', async () => {
  const summary = { total: 1, online: 1, names: ['Example Operations Assistant'] }

  const stay = controller({ summary, choice: 0 })
  assert.equal(stay.background.handleBeforeQuit(preventable()), 'intercepted')
  assert.equal(await stay.background.requestQuit(), false)
  assert.equal(stay.events.quit, 0)
  assert.ok(stay.win.calls.includes('hide'))

  const cancel = controller({ summary, choice: 2 })
  assert.equal(await cancel.background.requestQuit(), false)
  assert.equal(cancel.events.quit, 0)

  const quit = controller({ summary, choice: 1 })
  assert.equal(await quit.background.requestQuit(), true)
  assert.equal(quit.events.quit, 1)
  assert.equal(quit.background.handleBeforeQuit(preventable()), 'proceed')
  assert.equal(quit.background.isQuitting(), true)

  const none = controller()
  assert.equal(await none.background.requestQuit(), true)
  assert.equal(none.events.dialogs.length, 0)
})

test('concurrent quit requests share one dialog', async () => {
  const { background, events } = controller({ summary: { total: 1, online: 0, names: ['A'] }, choice: 1 })
  const [first, second] = await Promise.all([background.requestQuit(), background.requestQuit()])
  assert.equal(first, true)
  assert.equal(second, true)
  assert.equal(events.dialogs.length, 1)
})

test('system shutdown and update install bypass the quit prompt', () => {
  const { background, events } = controller({ summary: { total: 3, online: 3, names: ['A', 'B', 'C'] } })
  background.allowQuitWithoutPrompt('session end')
  assert.equal(background.handleBeforeQuit(preventable()), 'proceed')
  assert.equal(background.handleWindowClose(preventable()), 'close')
  assert.equal(events.dialogs.length, 0)
})

test('showWindow restores the hidden window', () => {
  const { background, win } = controller()
  assert.equal(background.showWindow(), true)
  assert.deepEqual(win.calls, ['show', 'focus'])
  const gone = createBackgroundController({ platform: 'win32', preferences: memoryPreferences(), getWindow: () => null, getAgentSummary: async () => ({ total: 0 }), showQuitDialog: async () => 1, quitApp: () => {} })
  assert.equal(gone.showWindow(), false)
})

test('tray menu offers WeWorker browser only while it is running', () => {
  const base = { summary: null, launchAtLogin: { supported: false, enabled: false }, onOpen() {}, onOpenAgents() {}, onToggleLaunchAtLogin() {}, onQuit() {} }
  let shown = 0
  const running = buildTrayMenuTemplate({ ...base, browser: { available: true, onShow: () => { shown += 1 } } })
  const item = running.find((entry) => entry.label === '显示 WeWorker 浏览器')
  assert.ok(item)
  item.click()
  assert.equal(shown, 1)
  const has = (template) => template.some((entry) => entry.label === '显示 WeWorker 浏览器')
  assert.equal(has(buildTrayMenuTemplate({ ...base, browser: { available: false, onShow() {} } })), false)
  assert.equal(has(buildTrayMenuTemplate(base)), false)
})

test('tray menu lists agents, launch-at-login toggle and quit', () => {
  const handlers = { onOpen() {}, onOpenAgents() {}, onToggleLaunchAtLogin() {}, onQuit() {} }
  const template = buildTrayMenuTemplate({ summary: { total: 2, online: 1, source: 'backend' }, launchAtLogin: { supported: true, enabled: true }, ...handlers })
  const labels = template.filter((item) => item.label).map((item) => item.label)
  assert.deepEqual(labels, ['打开 WeWorker', '专属 Agent：1/2 在线', '开机自动启动', '退出 WeWorker'])
  assert.equal(template.find((item) => item.label === '开机自动启动').checked, true)

  const dev = buildTrayMenuTemplate({ summary: null, launchAtLogin: { supported: false, enabled: false }, ...handlers })
  assert.deepEqual(dev.filter((item) => item.label).map((item) => item.label), ['打开 WeWorker', '暂无专属 Agent', '退出 WeWorker'])
})
