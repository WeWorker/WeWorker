// Real composer interactions with an isolated Skill catalog; no model calls or user data writes.
// Run: node weworker/renderer/src/__tests__/chat-skill-completion.browser.mjs
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright-core')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-skill-completion-'))
const server = await createServer({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  cacheDir: path.join(directory, 'vite-cache'),
  server: { host: '127.0.0.1', port: 5188, strictPort: false, hmr: false, ws: false, watch: null },
})
const exampleIcon = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#2563eb"/><path d="M9 8h14v16H9z" fill="white"/></svg>').toString('base64')}`
const skills = [
  { name: 'report-folder', enabled: true, iconUrl: exampleIcon, content: '---\nname: webcli-report\ndescription: Summarize a chosen period\n---\nInstructions' },
  { name: 'notes', enabled: true, content: '---\nname: notes\ndescription: Organize notes\n---\nInstructions' },
  { name: 'disabled', enabled: false, content: '# Disabled skill' },
  { name: 'hidden', enabled: true, content: '---\nname: hidden\nuser-invocable: false\n---\nInstructions' },
  { name: 'manual', enabled: true, iconUrl: 'data:image/png;base64,broken', content: '---\nname: manual\ndisable-model-invocation: true\n---\nInstructions' },
  { name: 'an-example-skill-with-a-deliberately-long-name-for-layout-checks', enabled: true, content: '---\ndescription: A longer example description to verify that the full Skill name remains readable when space is limited\n---\nInstructions' },
]
let browser
try {
  await server.listen()
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  let skillRequests = 0
  let mode = 'ready'
  let releaseRequest
  await page.route('http://127.0.0.1:8765/**', async route => {
    if (new URL(route.request().url()).pathname !== '/skills') {
      return route.fulfill({ status: 200, body: '{}', contentType: 'application/json' })
    }
    skillRequests++
    const requestMode = mode
    if (requestMode === 'loading') await new Promise(resolve => { releaseRequest = resolve })
    await route.fulfill({
      status: requestMode === 'error' ? 503 : 200,
      contentType: 'application/json',
      body: JSON.stringify(requestMode === 'empty' ? [] : skills),
    }).catch(() => {}) // Closing the menu intentionally aborts its request.
  })
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/src/__tests__/fixtures/formatted-composer.html`)
  const input = page.locator('[data-weworker-chat-input]')
  const menu = page.getByRole('listbox', { name: 'Skill 选择', exact: true })
  const expectValue = async value => {
    await page.waitForFunction(value => document.querySelector('[data-weworker-chat-input]')?.value === value, value)
  }
  await input.waitFor()
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const checkEmptyCaret = async () => {
    await input.focus()
    const measurements = await input.evaluate(el => {
      const placeholder = el.getAttribute('data-placeholder')
      const results = []
      for (const hint of ['输入消息...', '输入一句话即可开始查询、浏览网页或下载附件，请在这里填写你的需求。'.repeat(4)]) {
        el.setAttribute('data-placeholder', hint)
        // A zero-width probe makes Chromium expose the empty caret's geometry;
        // no input event fires and neither the draft nor undo history is changed.
        const probe = el.ownerDocument.createTextNode('\u200b')
        el.append(probe)
        const range = el.ownerDocument.createRange()
        range.setStart(probe, 0)
        range.collapse(true)
        const style = getComputedStyle(el)
        results.push({ caretX: range.getBoundingClientRect().left, expectedX: el.getBoundingClientRect().left + parseFloat(style.paddingLeft), height: el.clientHeight, scrollHeight: el.scrollHeight })
        probe.remove()
      }
      el.setAttribute('data-placeholder', placeholder)
      el.setSelectionRange(0, 0)
      return results
    })
    for (const measurement of measurements) assert.ok(Math.abs(measurement.caretX - measurement.expectedX) < 1, `placeholder must not move the caret: ${JSON.stringify(measurement)}`)
    assert.equal(measurements[0].height, measurements[1].height, 'changing placeholder length must not resize the editor')
    assert.equal(await input.evaluate(el => el.value), '')
  }
  await checkEmptyCaret()
  await input.fill('/')
  await menu.waitFor()
  assert.equal(await menu.getByRole('option').count(), 4)
  assert.equal(skillRequests, 1)
  const reportIcon = menu.getByRole('option').first().locator('img')
  await reportIcon.waitFor()
  await page.waitForFunction(() => document.querySelector('[aria-label="Skill 选择"] img')?.naturalWidth > 0)
  assert.equal(await reportIcon.getAttribute('src'), exampleIcon)
  const manual = menu.getByRole('option').filter({ has: page.locator('.chat-slash-menu-item__title', { hasText: /^manual$/ }) })
  await manual.locator('.chat-slash-menu-item__icon svg').waitFor()
  assert.equal(await manual.locator('img').count(), 0, 'an invalid icon falls back without a broken image')
  assert.equal(await menu.getByRole('option').nth(1).locator('.chat-slash-menu-item__icon svg').count(), 1, 'Skills without an icon retain the default')
  const checkSkillNameLayout = async () => {
    const layout = await menu.evaluate(el => ({
      duplicateLabels: el.querySelectorAll('.chat-slash-menu-item__command').length,
      names: [...el.querySelectorAll('.chat-slash-menu-item__title')].map(title => {
        const range = document.createRange()
        range.selectNodeContents(title)
        const bounds = title.getBoundingClientRect()
        return { text: title.textContent, truncated: getComputedStyle(title).textOverflow === 'ellipsis',
          contained: [...range.getClientRects()].every(rect => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1) }
      }),
    }))
    assert.equal(layout.duplicateLabels, 0, 'Skill names should appear only once per row')
    assert.equal(layout.names.length, 4)
    for (const name of layout.names) {
      assert.equal(name.truncated, false, name.text)
      assert.equal(name.contained, true, name.text)
    }
  }
  await checkSkillNameLayout()
  await page.setViewportSize({ width: 420, height: 850 })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
  await checkSkillNameLayout()
  await page.screenshot({ path: path.join(directory, 'skill-menu-narrow.png') })
  await page.setViewportSize({ width: 1100, height: 850 })
  await input.fill('/chosen')
  assert.equal(await menu.getByRole('option').count(), 1)
  assert.equal(skillRequests, 1, 'typing filters locally without refetching')
  await input.press('Tab')
  await expectValue('/webcli-report ')
  assert.equal(await menu.count(), 0)
  assert.equal(await page.evaluate(() => window.lastSent), undefined)
  await input.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expectValue('/chosen')
  await input.press('Escape')

  await input.fill('/')
  await menu.waitFor()
  await input.press('ArrowDown')
  await input.press('Enter')
  await expectValue('/notes ')
  await input.pressSequentially('organize this')
  await input.press('Enter')
  assert.equal(await page.evaluate(() => window.lastSent.text), '/notes organize this')
  await page.evaluate(() => { delete window.lastSent })

  await input.fill('/report-folder')
  await menu.waitFor()
  await menu.getByRole('option').first().click()
  await expectValue('/webcli-report ')
  const chip = input.locator('[data-skill-command]')
  assert.equal(await chip.count(), 1)
  assert.equal(await chip.getAttribute('contenteditable'), 'false')
  assert.equal(await chip.locator('.chat-skill-token__label').textContent(), 'webcli-report')
  assert.equal(await chip.evaluate(el => getComputedStyle(el).color), 'rgb(37, 99, 235)')
  await page.screenshot({ path: path.join(directory, 'selected-skill.png') })
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  await input.press('Backspace')
  assert.equal(await input.evaluate(el => el.value), '', JSON.stringify(await input.evaluate(el => ({ html: el.innerHTML, selection: [el.selectionStart, el.selectionEnd] }))))
  assert.equal(await chip.count(), 0, 'Backspace removes the complete Skill and its inserted separator')
  await checkEmptyCaret()
  await input.press(`${modifier}+z`)
  await expectValue('/webcli-report ')
  assert.equal(await chip.count(), 1, 'native undo restores the token, not only its text')
  await input.press(process.platform === 'win32' ? 'Control+y' : `${modifier}+Shift+z`)
  await expectValue('')
  await input.press(`${modifier}+z`)
  await expectValue('/webcli-report ')

  await input.press(`${modifier}+a`)
  const copied = await input.evaluate(el => {
    const data = new DataTransfer()
    el.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }))
    window.skillClipboard = data
    return data.getData('text/plain')
  })
  assert.equal(copied, '/webcli-report ')
  await page.evaluate(() => window.switchDraft('b'))
  await page.waitForFunction(() => window.fixtureState.target === 'b')
  await input.focus()
  await input.evaluate(el => el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: window.skillClipboard, bubbles: true, cancelable: true })))
  await expectValue('/webcli-report ')
  assert.equal(await chip.count(), 1, 'copy/paste keeps the Skill atomic')
  await page.evaluate(() => window.switchDraft('a'))
  await page.waitForFunction(() => window.fixtureState.target === 'a')
  await expectValue('/webcli-report ')
  assert.equal(await chip.count(), 1, 'switching conversations preserves selected Skills')
  await input.focus()
  await input.evaluate(el => el.setSelectionRange(0, '/webcli-report'.length))
  await input.evaluate(el => el.dispatchEvent(new ClipboardEvent('cut', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true })))
  assert.equal(await chip.count(), 0, 'cut removes the whole selected token')
  await input.press(`${modifier}+z`)
  await expectValue('/webcli-report ')
  assert.equal(await chip.count(), 1)
  await input.evaluate(el => el.setSelectionRange(el.value.length, el.value.length))
  await input.pressSequentially('summarize')
  await input.press('Enter')
  assert.equal(await page.evaluate(() => window.lastSent.text), '/webcli-report summarize')
  await page.evaluate(() => { delete window.lastSent })

  // Multiple selected Skills retain their order and each deletes as one element.
  await input.fill('/report')
  await menu.waitFor()
  await input.press('Enter')
  // Completion restores the caret on the next frame before more text is typed.
  await page.evaluate(() => new Promise(requestAnimationFrame))
  await input.pressSequentially('/notes')
  await menu.waitFor()
  await input.press('Enter')
  await expectValue('/webcli-report /notes ')
  assert.equal(await chip.count(), 2)
  await input.evaluate(el => el.setSelectionRange(0, 0))
  await input.press('Delete')
  await expectValue(' /notes ')
  assert.equal(await chip.count(), 1)
  await input.press(`${modifier}+z`)
  await expectValue('/webcli-report /notes ')
  assert.equal(await chip.count(), 2)
  await input.evaluate(el => el.setSelectionRange(el.value.length, el.value.length))
  await input.press('Shift+Enter')
  await input.pressSequentially('任务')
  await input.press('Enter')
  assert.equal(await page.evaluate(() => window.lastSent.text), '/webcli-report /notes \n任务')
  await page.evaluate(() => { delete window.lastSent })

  // A cursor in the middle of a token replaces that token, not the following instructions.
  await input.fill('use /report next')
  await input.evaluate(el => { el.setSelectionRange(8, 8); el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await menu.waitFor()
  await input.press('Tab')
  await expectValue('use /webcli-report next')

  await input.fill('/no-such-skill')
  await page.getByRole('status').getByText('没有匹配的 Skill', { exact: true }).waitFor()
  await input.press('Enter')
  assert.equal(await page.evaluate(() => window.lastSent), undefined)
  await input.press('Escape')
  assert.equal(await page.locator('.chat-slash-menu').count(), 0)

  for (const value of ['https://example.com/', '/tmp/file', 'C:/files/', '1 / 2']) {
    await input.fill(value)
    assert.equal(await menu.count(), 0, value)
  }
  await input.fill('!')
  await page.getByRole('listbox', { name: 'Shell 命令提示' }).waitFor()
  await input.press('Escape')

  mode = 'loading'
  await input.fill('/')
  await page.getByRole('status').getByText('正在加载 Skill…', { exact: true }).waitFor()
  await input.press('Enter')
  assert.equal(await page.evaluate(() => window.lastSent), undefined)
  await input.press('Escape')
  await input.fill('new draft')
  releaseRequest()
  await expectValue('new draft')
  assert.equal(await menu.count(), 0, 'a stale response must not reopen the menu')

  mode = 'error'
  await input.fill('/')
  await page.getByRole('status').getByText('Skill 加载失败，', { exact: false }).waitFor()
  mode = 'ready'
  await page.getByRole('button', { name: '重新加载', exact: true }).click()
  await menu.waitFor()
  await page.screenshot({ path: path.join(directory, 'skill-menu.png') })
  await input.press('Escape')

  mode = 'empty'
  await input.fill('/')
  await page.getByRole('status').getByText('暂无可用 Skill，请先在技能管理中启用', { exact: true }).waitFor()
  await input.press('Enter')
  assert.equal(await page.evaluate(() => window.lastSent), undefined)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ passed: true, skillRequests, screenshot: path.join(directory, 'skill-menu.png') }))
} finally {
  await browser?.close()
  await server.close()
}
