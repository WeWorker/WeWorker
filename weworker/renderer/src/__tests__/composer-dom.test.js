import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { readComposer, setComposerSelection, getComposerSelection, renderComposer, createSkillToken } from '../utils/composer-dom.js'

function editor(html = '') {
  const document = new JSDOM('<div contenteditable="true"></div>').window.document
  const root = document.querySelector('div')
  root.innerHTML = html
  return root
}

test('reads native editable lines without phantom trailing placeholder newlines', () => {
  for (const [html, text] of [
    ['first<div>second</div><div><br></div>', 'first\nsecond\n'],
    ['first<div>second</div><div>\nnext</div>', 'first\nsecond\n\nnext'],
    ['a<br><br>', 'a\n'], ['<br>', ''], ['<div><br></div><div><br></div>', '\n'],
    ['<div>a</div><div>b</div>', 'a\nb'], ['a<div>b</div>c', 'a\nb\nc'],
  ]) assert.equal(readComposer(editor(html)).text, text, html)
})

test('Skill tokens serialize their full command and preserve surrounding text', () => {
  const root = editor('before ')
  root.append(createSkillToken(root.ownerDocument, { name: 'example', iconUrl: undefined }), ' after')
  assert.equal(root.querySelector('[data-skill-command]').getAttribute('contenteditable'), 'false')
  const model = readComposer(root)
  assert.equal(model.text, 'before /example after')
  assert.deepEqual(model.skills.map(({ start, end, name }) => ({ start, end, name })), [{ start: 7, end: 15, name: 'example' }])
  setComposerSelection(root, 8, 10)
  assert.deepEqual(getComposerSelection(root), { start: 7, end: 15 })
  setComposerSelection(root, 16, 21)
  assert.deepEqual(getComposerSelection(root), { start: 16, end: 21 })
})

test('ignores the empty text nodes Chromium leaves around the final placeholder BR', () => {
  const root = editor('<br>')
  root.prepend(root.ownerDocument.createTextNode(''))
  root.append(root.ownerDocument.createTextNode(''))
  assert.equal(readComposer(root).text, '')
})

test('restores selections at native BR boundaries and across consecutive line breaks', () => {
  for (const html of ['a<br>b', 'a<br><br>b', '<br>b', 'a<br><br>']) {
    const root = editor(html)
    const { text } = readComposer(root)
    for (let start = 0; start <= text.length; start += 1) {
      for (let end = start; end <= text.length; end += 1) {
        setComposerSelection(root, start, end)
        assert.deepEqual(getComposerSelection(root), { start, end }, `${html}: ${start}-${end}`)
      }
    }
  }
})

test('round-trips draft tokens and literal symbols without turning user text into HTML', () => {
  const root = editor()
  const text = '*text*\n/example <b>literal</b>\n'
  renderComposer(root, text, [{ start: 7, end: 15, name: 'example' }])
  assert.equal(readComposer(root).text, text)
  assert.equal(root.querySelectorAll('[data-skill-command]').length, 1)
  assert.equal(root.querySelector('b'), null)
  setComposerSelection(root, text.length, text.length)
  assert.deepEqual(getComposerSelection(root), { start: text.length, end: text.length })
})
