// Real Electron + React input; isolated profile, no backend or system clipboard writes.
// Run: node weworker/renderer/src/__tests__/chat-edit-shortcuts.electron.mjs
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const require = createRequire(import.meta.url)
const { _electron: electron } = require('playwright-core')
const rendererRoot = fileURLToPath(new URL('../..', import.meta.url))
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-edit-shortcuts-'))
const entry = path.join(directory, 'main.cjs')
fs.writeFileSync(entry, `
  const { app, BrowserWindow, Menu } = require('electron')
  const fs = require('fs')
  const path = require('path')
  const vm = require('vm')
  app.setPath('userData', process.env.EDIT_TEST_PROFILE)
  app.whenReady().then(async () => {
    const source = fs.readFileSync(process.env.EDIT_TEST_MAIN, 'utf8')
    const createWindow = source.slice(source.indexOf('async function createWindow('), source.indexOf('\\nif (hasSingleInstanceLock) app.whenReady()'))
    const context = {
      process: { platform: process.platform, env: { WEWORKER_E2E: '1' } },
      Menu: {
        setApplicationMenu: menu => Menu.setApplicationMenu(menu),
        buildFromTemplate: template => {
          const menu = Menu.buildFromTemplate(template)
          // Keep real menu items/actions, intercept only the OS popup so this
          // fixture never takes the user's desktop focus.
          menu.popup = options => {
            global.fixtureMenu = menu
            global.fixturePopup = { windowId: options.window.id, hasFrame: !!options.frame }
          }
          return menu
        },
      },
      BrowserWindow: class extends BrowserWindow {
        constructor(options) {
          super({ ...options, show: false,
            webPreferences: { contextIsolation: true, nodeIntegration: false } })
        }
      },
      mainWindow: null, isDev: true, devRendererUrl: process.env.EDIT_TEST_URL,
      __dirname: path.dirname(process.env.EDIT_TEST_MAIN), appIconPath: '',
      path, fs, isInstallingUpdate: false, background: { handleWindowClose() {} },
    }
    await vm.runInNewContext(createWindow + '\\ncreateWindow({ show: false })', context)
  })
  app.on('window-all-closed', () => app.quit())
`)
const server = await createServer({ root: rendererRoot, cacheDir: path.join(directory, 'vite-cache'), server: { host: '127.0.0.1', port: 5187, strictPort: false, hmr: false } })
let app
try {
  await server.listen()
  const env = { ...process.env, EDIT_TEST_MAIN: path.join(rendererRoot, '../electron/main.js'), EDIT_TEST_PROFILE: path.join(directory, 'profile'), EDIT_TEST_URL: `http://127.0.0.1:${server.httpServer.address().port}/src/__tests__/fixtures/formatted-composer.html` }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ executablePath: require('electron'), args: [entry], env })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('http://127.0.0.1:8765/**', route => route.fulfill({ status: 200, body: '{}', contentType: 'application/json' }))
  await page.reload()
  const input = page.locator('[data-weworker-chat-input]')
  await input.waitFor()
  await page.waitForFunction(() => window.fixtureState?.target === 'a')
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  const redo = process.platform === 'win32' ? 'Control+y' : `${modifier}+Shift+z`
  await input.focus()
  await input.pressSequentially('alpha', { delay: 30 })
  assert.equal(await input.evaluate(el => el.value), 'alpha')

  await input.click({ button: 'right' })
  const contextMenu = await app.evaluate(({ BrowserWindow }) => ({
    items: global.fixtureMenu?.items.filter(item => item.type !== 'separator').map(item => ({ role: item.role, label: item.label, enabled: item.enabled, accelerator: item.accelerator })),
    windowMatches: global.fixturePopup?.windowId === BrowserWindow.getAllWindows()[0].id,
    hasFrame: global.fixturePopup?.hasFrame,
  }))
  assert.deepEqual(contextMenu.items?.map(item => item.label), ['撤销', '重做', '剪切', '复制', '粘贴', '删除', '全选'])
  assert.equal(contextMenu.items.find(item => item.role === 'copy').accelerator, 'CmdOrCtrl+C')
  assert.equal(contextMenu.items.find(item => item.role === 'paste').accelerator, 'CmdOrCtrl+V')
  assert.equal(contextMenu.items.find(item => item.role === 'copy').enabled, false)
  assert.equal(contextMenu.items.find(item => item.role === 'cut').enabled, false)
  assert.equal(contextMenu.windowMatches, true)
  assert.equal(contextMenu.hasFrame, true)
  const chooseMenuItem = role => app.evaluate(({ BrowserWindow }, role) => {
    const window = BrowserWindow.getAllWindows()[0]
    global.fixtureMenu.items.find(item => item.role === role.toLowerCase()).click({}, window, window.webContents)
  }, role)
  await chooseMenuItem('selectAll')
  assert.deepEqual(await input.evaluate(el => [el.selectionStart, el.selectionEnd]), [0, 5])
  await input.evaluate(el => el.setSelectionRange(5, 5))
  await input.press(`${modifier}+a`)
  assert.deepEqual(await input.evaluate(el => [el.selectionStart, el.selectionEnd]), [0, 5])
  await input.click({ button: 'right', position: { x: 24, y: 24 } })
  assert.equal(await app.evaluate(() => global.fixtureMenu.items.find(item => item.role === 'copy').enabled), true)
  assert.equal(await app.evaluate(() => global.fixtureMenu.items.find(item => item.role === 'cut').enabled), true)
  await input.pressSequentially('b')
  assert.equal(await input.evaluate(el => el.value), 'b')
  await input.press(`${modifier}+z`)
  assert.equal(await input.evaluate(el => el.value), 'alpha')
  await input.press(redo)
  assert.equal(await input.evaluate(el => el.value), 'b')
  await input.press(`${modifier}+z`)
  await input.press(`${modifier}+Shift+z`)
  assert.equal(await input.evaluate(el => el.value), 'b', 'Ctrl/Cmd+Shift+Z also redoes the edit')

  const paste = async (plain, html = '') => input.evaluate((el, { plain, html }) => {
    const data = new DataTransfer()
    data.setData('text/plain', plain)
    if (html) data.setData('text/html', html)
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, { plain, html })
  for (const [plain, html, expected] of [
    [' pasted\nsecond line', '', 'b pasted\nsecond line'],
    ['bold', '<strong>bold</strong>', 'b**bold**'],
  ]) {
    await input.evaluate(el => el.setSelectionRange(el.value.length, el.value.length))
    await paste(plain, html)
    assert.equal(await input.evaluate(el => el.value), expected)
    await input.click({ button: 'right' })
    await chooseMenuItem('undo')
    assert.equal(await input.evaluate(el => el.value), 'b', 'pasted text must be one undoable edit')
    assert.equal(await page.evaluate(() => window.fixtureState.text), 'b')
    await input.press(redo)
    assert.equal(await input.evaluate(el => el.value), expected)
    await input.press(`${modifier}+z`)
  }
  await input.press(`${modifier}+a`)
  await paste('replacement')
  assert.equal(await input.evaluate(el => el.value), 'replacement')
  await input.press(`${modifier}+z`)
  assert.equal(await input.evaluate(el => el.value), 'b', 'undo restores text replaced by paste')

  // Observe copy/cut shortcuts without reading or overwriting the user's clipboard.
  await input.press(`${modifier}+a`)
  await page.evaluate(() => {
    window.editEvents = []
    for (const type of ['copy', 'cut']) document.addEventListener(type, event => {
      window.editEvents.push(type)
      event.preventDefault()
    })
  })
  await input.press(`${modifier}+c`)
  await input.press(`${modifier}+x`)
  assert.deepEqual(await page.evaluate(() => window.editEvents), ['copy', 'cut'])
  await input.evaluate(el => el.setSelectionRange(el.value.length, el.value.length))
  await input.press('Shift+Enter')
  await input.pressSequentially('second')
  assert.equal(await input.evaluate(el => el.value), 'b\nsecond')
  await input.press('Enter')
  assert.equal(await page.evaluate(() => window.lastSent.text), 'b\nsecond')
  // The same native context menu must work on a non-editable Skill atom.
  await input.evaluate(el => el.insertSkill({ command: '/example ', title: 'example' }, 0, 0, '/example '))
  await app.evaluate(() => { global.fixtureMenu = null })
  await input.evaluate(el => el.setSelectionRange(0, 8))
  const tokenBox = await input.locator('[data-skill-command]').boundingBox()
  const inputBox = await input.boundingBox()
  await input.click({ button: 'right', position: { x: tokenBox.x - inputBox.x + tokenBox.width / 2, y: tokenBox.y - inputBox.y + tokenBox.height / 2 } })
  assert.equal(await app.evaluate(() => !!global.fixtureMenu), true, 'right-clicking a Skill still opens the editing menu')
  await input.evaluate(el => el.setSelectionRange(0, 8))
  await chooseMenuItem('delete')
  assert.equal(await input.locator('[data-skill-command]').count(), 0)
  await chooseMenuItem('undo')
  assert.equal(await input.locator('[data-skill-command]').count(), 1)
  assert.deepEqual(errors, [])
  console.log('PASS: native context menu and selection states, select-all, undo/redo, plain/rich paste, selection replacement, copy/cut, Shift+Enter and send')
} finally {
  await app?.close()
  await server.close()
}
