import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldAutoResumeQueue } from '../utils/queue-auto-resume.js'

const pausedState = (overrides = {}) => ({
  items: [{ id: 'queued-1', text: 'hello' }],
  running: false,
  transitioning: false,
  pausedReason: '发送未完成，队列暂停',
  ...overrides,
})

test('resumes a paused queue once the conversation is idle', () => {
  assert.equal(shouldAutoResumeQueue(pausedState(), false), true)
})

test('keeps waiting while a turn is streaming', () => {
  assert.equal(shouldAutoResumeQueue(pausedState(), true), false)
})

test('keeps waiting while the queue itself is running or transitioning', () => {
  assert.equal(shouldAutoResumeQueue(pausedState({ running: true }), false), false)
  assert.equal(shouldAutoResumeQueue(pausedState({ transitioning: true }), false), false)
})

test('does nothing without queued items or a pause reason', () => {
  assert.equal(shouldAutoResumeQueue(pausedState({ items: [] }), false), false)
  assert.equal(shouldAutoResumeQueue(pausedState({ pausedReason: '' }), false), false)
  assert.equal(shouldAutoResumeQueue(undefined, false), false)
})

test('does not auto-resume after the user stopped the reply', () => {
  assert.equal(shouldAutoResumeQueue(pausedState({ pausedReason: '已停止，队列暂停' }), false), false)
})
