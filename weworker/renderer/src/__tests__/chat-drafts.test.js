import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { EMPTY_CHAT_DRAFT, useChatDraftStore } from '../store/chat-drafts.js'

afterEach(() => useChatDraftStore.setState({ drafts: {} }))

test('conversation and welcome drafts retain independent text and attachments', () => {
  const store = useChatDraftStore.getState()
  store.setText('work:a', '2222\n未发送')
  store.setAttachments('work:a', [{ path: 'C:/weworker-fixtures/note.txt', name: 'note.txt' }])
  store.setText('work:b', '另一份草稿')
  store.setText('welcome', '欢迎页草稿')
  const drafts = useChatDraftStore.getState().drafts
  assert.equal(drafts['work:a'].text, '2222\n未发送')
  assert.equal(drafts['work:a'].attachments[0].name, 'note.txt')
  assert.equal(drafts['work:b'].text, '另一份草稿')
  assert.equal(drafts.welcome.text, '欢迎页草稿')
})

test('clearing a sent draft preserves other conversations and removes empty entries', () => {
  const store = useChatDraftStore.getState()
  store.setText('work:a', 'send')
  store.setAttachments('work:a', [{ name: 'note.txt', path: '/fixtures/note.txt' }])
  store.setText('work:b', 'keep')
  store.setText('work:a', '')
  assert.equal(useChatDraftStore.getState().drafts['work:a'].attachments.length, 1)
  store.setAttachments('work:a', [])
  assert.equal(useChatDraftStore.getState().drafts['work:a'], undefined)
  assert.equal(useChatDraftStore.getState().drafts['work:b'].text, 'keep')
  assert.deepEqual(EMPTY_CHAT_DRAFT, { text: '', attachments: [] })
})

test('discarding a deleted conversation does not affect other drafts', () => {
  const store = useChatDraftStore.getState()
  store.setText('work:a', 'remove')
  store.setText('welcome', 'keep')
  store.discard('work:a')
  assert.equal(useChatDraftStore.getState().drafts['work:a'], undefined)
  assert.equal(useChatDraftStore.getState().drafts.welcome.text, 'keep')
})

test('project drafts remain isolated and sending one preserves the other projects', () => {
  const store = useChatDraftStore.getState()
  store.setText('project-draft:example-a', 'Project A request')
  store.setAttachments('project-draft:example-a', [{ name: 'note.txt', path: '/fixtures/note.txt' }])
  store.setText('project-draft:example-b', 'Project B request')
  store.setText('welcome', 'Default workspace request')
  store.discard('project-draft:example-a')
  assert.equal(useChatDraftStore.getState().drafts['project-draft:example-a'], undefined)
  assert.equal(useChatDraftStore.getState().drafts['project-draft:example-b'].text, 'Project B request')
  assert.equal(useChatDraftStore.getState().drafts.welcome.text, 'Default workspace request')
})
