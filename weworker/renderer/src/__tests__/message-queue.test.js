import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createMessageQueue } from '../utils/message-queue.js'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function fixture() {
  const calls = []
  const turns = []
  const queue = createMessageQueue({
    send: payload => { calls.push(payload); const turn = deferred(); turns.push(turn); return turn.promise },
    stop: async () => { turns.at(-1)?.resolve({ status: 'stopped', accepted: true }) },
  })
  return { queue, calls, turns }
}

describe('conversation message queue', () => {
  it('keeps followups queued during an external run and stops it before resuming', async () => {
    const { queue, calls, turns } = fixture()
    let external = true
    let stopped = false
    const cleanup = deferred()
    queue.setHandlers({
      isBlocked: () => external,
      isExternalRunning: () => external,
      steer: async () => { throw new Error('补充消息已保留在队列中') },
      stop: async () => { stopped = true; await cleanup.promise; external = false },
    })
    const id = queue.enqueue({ text: 'Followup' }); await tick()
    assert.equal(calls.length, 0)
    await assert.rejects(queue.sendNow(id), /保留在队列/)
    assert.equal(queue.snapshot().items[0].id, id)
    const stopping = queue.stop(); await tick()
    assert.equal(stopped, true)
    assert.equal(calls.length, 0)
    cleanup.resolve(); await stopping
    assert.equal(calls.length, 0)
    queue.resume(); await tick()
    assert.equal(calls.length, 1)
    turns[0].resolve({ status: 'completed' })
  })

  it('automatically wakes queued followups when an external run completes', async () => {
    const { queue, calls, turns } = fixture()
    let external = true
    queue.setHandlers({ isBlocked: () => external, isExternalRunning: () => external })
    queue.enqueue({ text: 'Followup' }); await tick()
    assert.equal(calls.length, 0)
    external = false; queue.wake(); await tick()
    assert.equal(calls.length, 1)
    turns[0].resolve({ status: 'completed' })
  })
  it('does not retry steering acknowledged on the stream when its HTTP reply is lost', async () => {
    const { queue, calls, turns } = fixture()
    queue.setHandlers({ steer: async item => { queue.acknowledgeSteering(item.id); throw new Error('response lost') } })
    queue.enqueue({ text: 'active' })
    const id = queue.enqueue({ text: 'urgent' })
    queue.enqueue({ text: 'later' }); await tick()
    await queue.sendNow(id)
    assert.deepEqual(queue.snapshot().items.map(item => item.text), ['later'])
    assert.equal(queue.snapshot().pausedReason, null)
    turns[0].resolve({ status: 'completed' }); await tick()
    assert.deepEqual(calls.map(item => item.text), ['active', 'later'])
    turns[1].resolve({ status: 'completed' })
  })

  it('does not resume remaining messages when the active turn fails during steering', async () => {
    const { queue, calls, turns } = fixture()
    const delivery = deferred()
    queue.setHandlers({ steer: () => delivery.promise })
    queue.enqueue({ text: 'active' }); queue.enqueue({ text: 'later' })
    const id = queue.enqueue({ text: 'urgent' }); await tick()
    const sending = queue.sendNow(id)
    turns[0].resolve({ status: 'failed', accepted: true }); await tick()
    delivery.resolve(); await sending; await tick()
    assert.equal(calls.length, 1)
    assert.ok(queue.snapshot().pausedReason)
  })

  it('updates the command when editing a queued shell request', async () => {
    const { queue, calls, turns } = fixture()
    queue.enqueue({ text: 'active' })
    const id = queue.enqueue({ text: '!echo first', command: 'echo first' })
    queue.beginEdit(id); queue.saveEdit(id, '!echo second')
    await tick(); turns[0].resolve({ status: 'completed' }); await tick()
    assert.equal(calls[1].command, 'echo second')
    turns[1].resolve({ status: 'completed' })
  })
  it('sends FIFO once, preserving attachments and thinking effort', async () => {
    const { queue, calls, turns } = fixture()
    queue.enqueue({ text: 'first' })
    const files = [{ name: 'sample.txt', path: 'C:/weworker-fixtures/sample.txt' }]
    queue.enqueue({ text: 'second', files, thinkingEffort: 'high' })
    files[0].name = 'changed.txt'
    await tick()
    assert.deepEqual(calls.map(x => x.text), ['first'])
    turns[0].resolve({ status: 'completed', accepted: true })
    await tick()
    assert.equal(calls[1].files[0].name, 'sample.txt')
    assert.equal(calls[1].thinkingEffort, 'high')
    turns[1].resolve({ status: 'completed', accepted: true })
    await tick()
    assert.equal(queue.snapshot().items.length, 0)
    assert.equal(queue.snapshot().running, false)
  })

  it('holds an edited head until save and preserves its queue position', async () => {
    const { queue, calls, turns } = fixture()
    queue.enqueue({ text: 'active' })
    const id = queue.enqueue({ text: 'edit me', files: [{ name: 'sample.txt', path: '/fixtures/sample.txt' }] })
    const deleted = queue.enqueue({ text: 'delete me' })
    queue.beginEdit(id)
    queue.remove(deleted)
    await tick()
    turns[0].resolve({ status: 'completed' })
    await tick()
    assert.equal(calls.length, 1)
    queue.saveEdit(id, 'edited')
    await tick()
    assert.equal(calls[1].text, 'edited')
    assert.equal(calls[1].files.length, 1)
    turns[1].resolve({ status: 'completed' })
  })

  it('steers once without interrupting the current turn or draining other messages', async () => {
    const { queue, calls, turns } = fixture()
    const delivered = deferred()
    const steered = []
    queue.setHandlers({ steer: item => { steered.push(item); return delivered.promise }, stop: () => { assert.fail('steering must not stop the turn') } })
    queue.enqueue({ text: 'active' })
    queue.enqueue({ text: 'later' })
    const id = queue.enqueue({ text: 'urgent' })
    await tick()
    const sending = queue.sendNow(id)
    const duplicate = queue.sendNow(id)
    await tick()
    assert.equal(calls.length, 1)
    assert.deepEqual(steered.map(item => item.text), ['urgent'])
    delivered.resolve()
    await Promise.all([sending, duplicate])
    await tick()
    assert.equal(calls.length, 1)
    assert.deepEqual(queue.snapshot().items.map(item => item.text), ['later'])
    turns[0].resolve({ status: 'completed', accepted: true })
    await tick()
    assert.deepEqual(calls.map(x => x.text), ['active', 'later'])
    turns[1].resolve({ status: 'completed' })
  })

  it('manual stop pauses remaining items until explicit resume', async () => {
    const { queue, calls, turns } = fixture()
    queue.enqueue({ text: 'active' })
    queue.enqueue({ text: 'pending' })
    await tick()
    await queue.stop()
    await tick()
    assert.equal(calls.length, 1)
    assert.ok(queue.snapshot().pausedReason)
    queue.resume()
    await tick()
    assert.equal(calls[1].text, 'pending')
    turns[1].resolve({ status: 'completed' })
  })

  it('retains an unaccepted failure and does not retry an accepted failure', async () => {
    const { queue, calls, turns } = fixture()
    queue.enqueue({ text: 'offline' })
    queue.enqueue({ text: 'pending' })
    await tick()
    turns[0].resolve({ status: 'failed', accepted: false })
    await tick()
    assert.deepEqual(queue.snapshot().items.map(x => x.text), ['offline', 'pending'])
    queue.resume()
    await tick()
    assert.equal(calls[1].text, 'offline')
    turns[1].resolve({ status: 'failed', accepted: true })
    await tick()
    assert.deepEqual(queue.snapshot().items.map(x => x.text), ['pending'])
    assert.ok(queue.snapshot().pausedReason)
  })

  it('keeps the message queued if steering fails', async () => {
    const { queue, calls, turns } = fixture()
    queue.setHandlers({ steer: async () => { throw new Error('steering unavailable') } })
    queue.enqueue({ text: 'active' })
    const id = queue.enqueue({ text: 'urgent' })
    await tick()
    await assert.rejects(queue.sendNow(id), /steering unavailable/)
    turns[0].resolve({ status: 'completed' })
    await tick()
    assert.equal(calls.length, 1)
    assert.equal(queue.snapshot().items[0].id, id)
    assert.ok(queue.snapshot().pausedReason)
  })

  it('isolates conversations and does not drain after disposal', async () => {
    const a = fixture(); const b = fixture()
    a.queue.enqueue({ text: 'a' }); a.queue.enqueue({ text: 'discarded' })
    b.queue.enqueue({ text: 'b' })
    await tick()
    a.queue.dispose()
    a.turns[0].resolve({ status: 'completed' })
    b.turns[0].resolve({ status: 'completed' })
    await tick()
    assert.deepEqual(a.calls.map(x => x.text), ['a'])
    assert.deepEqual(b.calls.map(x => x.text), ['b'])
  })

  it('keeps unsaved edits when the view rebinds the same queue', async () => {
    const { queue, turns, calls } = fixture()
    queue.enqueue({ text: 'active' })
    const id = queue.enqueue({ text: 'original' })
    queue.beginEdit(id); queue.updateEdit('unsaved draft')
    queue.setHandlers({ onChange() {} })
    assert.equal(queue.snapshot().editingText, 'unsaved draft')
    await tick(); turns[0].resolve({ status: 'completed' }); await tick()
    assert.equal(calls.length, 1)
    queue.saveEdit(id, queue.snapshot().editingText); await tick()
    assert.equal(calls[1].text, 'unsaved draft')
    turns[1].resolve({ status: 'completed' })
  })

  it('permits a new explicit message after stopping an empty queue', async () => {
    const { queue, turns, calls } = fixture()
    queue.enqueue({ text: 'active' }); await tick(); await queue.stop()
    queue.enqueue({ text: 'new request' }); await tick()
    assert.equal(calls[1].text, 'new request')
    turns[1].resolve({ status: 'completed' })
  })

  it('blocks draining during compaction until woken', async () => {
    const { queue, turns, calls } = fixture()
    let blocked = true
    queue.setHandlers({ isBlocked: () => blocked })
    queue.enqueue({ text: 'after compaction' }); await tick()
    assert.equal(calls.length, 0)
    blocked = false; queue.wake(); queue.wake(); await tick()
    assert.equal(calls.length, 1)
    turns[0].resolve({ status: 'completed' })
  })
})
