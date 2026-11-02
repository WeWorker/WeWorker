import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'
import { clipboardMarkdown, createFormattedBody } from '../utils/formatted-body.js'
import { finishBodySave, isFormattedBody } from '../utils/formatted-body-draft.js'
const source = fs.readFileSync(new URL('../components/chat/InputBar.jsx', import.meta.url), 'utf8')
const parser = new JSDOM('').window.DOMParser
function fixture(overrides = {}) {
  const result = { text: 'prefix: ', attached: [], notice: '', saved: null, images: 0, sent: 0 }
  const context = {
    text: result.text, attachments: [], attachmentsRef: { current: [] }, attachmentLimit: 10, textAttachmentThreshold: 20000,
    inputDisabled: false, isCommandMode: false, savingBody: false, attachmentTarget: 'a', bodyOperation: { current: 0 }, bodySavePending: { current: false }, formatMenuRef: { current: null }, finishBodySave, isFormattedBody, basename: s => s, getPathsFromPasteEvent: () => [],
    setAttachmentNotice: s => { result.notice = s }, setBodyNotice: s => { result.notice = s },
    setSavingBody: () => {}, setBodyPreview: () => {},
    onTextChange: text => { result.text = text }, onAttachmentsChange: files => { result.attached = files },
    requestAnimationFrame: fn => fn(), textareaRef: { current: { selectionStart: 8, selectionEnd: 8 } },
    clipboardMarkdown: value => clipboardMarkdown(value, parser), createFormattedBody,
    window: { electronAPI: { saveClipboardImage: async () => { result.images++; return { path: 'image.png' } }, saveFormattedBody: async body => { result.saved = body; return { path: 'body-args-fixture.json', name: 'body-args-fixture.json' } } } },
    ...overrides,
  }
  context.draftRef = { current: { target: 'a', text: context.text, attachments: context.attachmentsRef.current, onTextChange: context.onTextChange, onAttachmentsChange: context.onAttachmentsChange } }
  const pasteCode = source.slice(source.indexOf('  const handlePaste ='), source.indexOf('  const handleKeyDown ='))
  const saveCode = source.slice(source.indexOf('  const attachFormattedBody ='), source.indexOf('  const focusTextarea ='))
  const handlers = vm.runInNewContext(`${pasteCode}\n${saveCode}\n({paste:handlePaste,save:attachFormattedBody})`, context)
  return { result, ...handlers }
}
const event = (text, html = '', items = []) => ({ preventDefault() {}, clipboardData: { items, getData: key => key === 'text/html' ? html : text } })

test('input inserts rich paste at selection while preserving lists; mixed text/image copy keeps text', async () => {
  const f = fixture()
  await f.paste(event('First\nSecond', '<ul><li>First</li><li>Second</li></ul>', [{ type: 'image/png' }]))
  assert.match(f.result.text, /^prefix: -\s+First/)
  assert.match(f.result.text, /-\s+Second/)
  assert.equal(f.result.images, 0)
})

test('input keeps plain Markdown spacing and command-mode paste unchanged', async () => {
  for (const isCommandMode of [true, false]) {
    const f = fixture({ isCommandMode })
    const text = '\n\n\n    code\n'
    await f.paste(event(text))
    assert.equal(f.result.text, 'prefix: ' + text)
  }
})

test('body save captures edited content and clears draft only after success', async () => {
  const f = fixture({ text: '- Edited\n- **Bold**' })
  await f.save()
  assert.match(f.result.saved.content, /<li>Edited<\/li>/)
  assert.match(f.result.saved.content, /<strong>Bold<\/strong>/)
  assert.equal(f.result.saved['markdown-content'], '- Edited\n- **Bold**')
  assert.equal(f.result.text, '')
  assert.equal(f.result.attached.length, 1)
  const failed = fixture({ window: { electronAPI: { saveFormattedBody: async () => { throw new Error('disk failure') } } } })
  await failed.save()
  assert.equal(failed.result.text, 'prefix: ')
  assert.equal(failed.result.attached.length, 0)
  assert.match(failed.result.notice, /disk failure/)
})

test('body save obeys attachment limits and input disabled state', async () => {
  for (const overrides of [{ inputDisabled: true }, { attachmentLimit: 1, attachmentsRef: { current: [{}] } }]) {
    const f = fixture(overrides)
    await f.save()
    assert.equal(f.result.saved, null)
    assert.equal(f.result.text, 'prefix: ')
  }
})
