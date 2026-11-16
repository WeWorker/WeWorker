import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

// Exercise the component's actual event handler with observable completion/send callbacks.
const source = fs.readFileSync(new URL('../components/chat/InputBar.jsx', import.meta.url), 'utf8')
const handler = source.slice(source.indexOf('  const handleKeyDown ='), source.indexOf('  const handleUpload ='))

function setup({ menu = true, kind = 'bang', items = [{ id: 'first' }, { id: 'selected' }], composing = false } = {}) {
  const calls = { sent: 0, completed: [], prevented: 0 }
  const context = {
    composingRef: { current: composing },
    slashMenuState: menu ? { kind, query: kind === 'bang' ? 'webcli ' : '' } : null,
    slashItems: items,
    slashActiveIndex: 1,
    buildBangSlashItems: () => items,
    skillSlashCommands: items,
    filterChatSlashCommands: () => items,
    applySlashItem: (item) => calls.completed.push(item.id),
    submit: () => { calls.sent++ },
  }
  const keydown = vm.runInNewContext(`${handler}\nhandleKeyDown`, context)
  return {
    calls,
    press: (key, extra = {}) => keydown({ key, preventDefault: () => { calls.prevented++ }, ...extra }),
  }
}

for (const key of ['Enter', 'Tab']) {
  test(`${key} inserts the selected completion without sending`, () => {
    const { press, calls } = setup()
    press(key)
    assert.deepEqual(calls, { sent: 0, completed: ['selected'], prevented: 1 })
  })
}

test('Shift+Enter leaves native newline behavior intact with suggestions visible', () => {
  const { press, calls } = setup()
  press('Enter', { shiftKey: true })
  assert.deepEqual(calls, { sent: 0, completed: [], prevented: 0 })
})

test('IME confirmation neither completes nor sends', () => {
  for (const [options, event] of [
    [{ composing: true }, {}],
    [{}, { nativeEvent: { isComposing: true } }],
    [{}, { keyCode: 229 }],
  ]) {
    const { press, calls } = setup(options)
    press('Enter', event)
    assert.deepEqual(calls, { sent: 0, completed: [], prevented: 0 })
  }
})

test('Enter sends normally when there is no completion to accept', () => {
  for (const options of [{ menu: false }, { items: [] }]) {
    const { press, calls } = setup(options)
    press('Enter')
    assert.deepEqual(calls, { sent: 1, completed: [], prevented: 1 })
  }
})

test('Tab with no matches does not submit or move focus', () => {
  const { press, calls } = setup({ items: [] })
  press('Tab')
  assert.deepEqual(calls, { sent: 0, completed: [], prevented: 1 })
})

test('editing shortcuts pass through with and without command suggestions', () => {
  for (const menu of [true, false]) {
    for (const modifier of ['ctrlKey', 'metaKey']) {
      for (const key of ['a', 'z', 'y', 'c', 'x', 'v']) {
        for (const shiftKey of [true, false]) {
          const { press, calls } = setup({ menu })
          press(key, { [modifier]: true, shiftKey })
          assert.deepEqual(calls, { sent: 0, completed: [], prevented: 0 })
        }
      }
    }
  }
})

test('Enter and Tab select a Skill without sending the message', () => {
  for (const key of ['Enter', 'Tab']) {
    const { press, calls } = setup({ kind: 'skill' })
    press(key)
    assert.deepEqual(calls, { sent: 0, completed: ['selected'], prevented: 1 })
  }
})

test('an empty or loading Skill menu does not accidentally send the slash query', () => {
  for (const key of ['Enter', 'Tab']) {
    const { press, calls } = setup({ kind: 'skill', items: [] })
    press(key)
    assert.deepEqual(calls, { sent: 0, completed: [], prevented: 1 })
  }
})
