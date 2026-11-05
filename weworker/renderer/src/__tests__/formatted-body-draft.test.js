import test from 'node:test'
import assert from 'node:assert/strict'
import { finishBodySave, restoreBodyToInput, isFormattedBody } from '../utils/formatted-body-draft.js'
import { useChatDraftStore } from '../store/chat-drafts.js'
const saved = { path: '/fixtures/body-new.json', name: 'body-new.json' }
const file = { path: '/fixtures/body-old.json', name: 'body-old.json', formattedBody: { markdown: '- Original' } }
const start = { target: 'a', path: null, markdown: '- Original' }
const current = { target: 'a', text: '- Original', attachments: [] }

test('creating a body keeps its editable source in the draft attachment', () => {
  const next = finishBodySave(start, current, saved, 10)
  assert.equal(next.text, '')
  assert.equal(next.attachments[0].formattedBody.markdown, '- Original')
  assert(isFormattedBody(next.attachments[0]))
})

test('restoring body preserves both current instructions and unsaved body edits', () => {
  assert.equal(restoreBodyToInput('', file), '- Original')
  assert.equal(restoreBodyToInput('Publish to target', file), 'Publish to target\n\n- Original')
  assert.equal(restoreBodyToInput('Keep', { ...file, formattedBody: { ...file.formattedBody, draft: '- Edited' } }), 'Keep\n\n- Edited')
})

test('late saves reject changed source, switched conversation, removed body and capacity changes', () => {
  for (const state of [{ ...current, target: 'b' }, { ...current, text: 'new request' }, { ...current, attachments: [file] }, { ...current, attachments: Array(10).fill({ path: 'other' }) }]) {
    assert.equal(finishBodySave(start, state, saved, 10), null)
  }
  const editing = { ...file, formattedBody: { markdown: '- Original', draft: '- Edited' } }
  const editStart = { target: 'a', path: file.path, markdown: '- Edited' }
  assert.equal(finishBodySave(editStart, current, saved, 10), null)
  assert.equal(finishBodySave(editStart, { ...current, attachments: [file] }, saved, 10), null)
  const next = finishBodySave(editStart, { ...current, text: 'Publish here', attachments: [editing, { path: 'other' }] }, saved, 10)
  assert.equal(next.text, 'Publish here')
  assert.equal(next.attachments[1].path, 'other')
  assert.deepEqual(next.attachments[0].formattedBody, { markdown: '- Edited' })
})

test('body drafts and unfinished edits survive conversation switching independently', () => {
  const store = useChatDraftStore.getState()
  store.setAttachments('body-test:a', [{ ...file, formattedBody: { markdown: 'original', draft: 'edited' } }])
  store.setText('body-test:a', 'instructions')
  store.setText('body-test:b', 'unrelated')
  assert.equal(useChatDraftStore.getState().drafts['body-test:a'].attachments[0].formattedBody.draft, 'edited')
  store.discard('body-test:a')
  assert.equal(useChatDraftStore.getState().drafts['body-test:b'].text, 'unrelated')
  store.discard('body-test:b')
})

test('format menu follows semantic Markdown rather than paste history or ordinary text', async () => {
  const { hasBodyFormatting } = await import('../utils/formatted-body-draft.js')
  for (const text of ['', '你好', '帮我查询任务', '普通消息\n第二行', 'a * b = c', 'example_name_value', '\\- literal', '\\*literal\\*']) {
    assert.equal(hasBodyFormatting(text), false, text)
  }
  for (const text of ['- item', '1. item', '# Heading', '**bold**', '*italic*', '~~removed~~', '`code`', '> quote', '[link](https://example.com)', '| A | B |\n| --- | --- |', 'first  \nsecond', 'Heading\n===', '```js\ncode\n```']) {
    assert.equal(hasBodyFormatting(text), true, text)
  }
})
