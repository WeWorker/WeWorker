import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

test('open-external IPC waits for the system browser and propagates launch failures', async () => {
  const source = fs.readFileSync(new URL('../ipc-handlers.js', import.meta.url), 'utf8')
  const registration = source.match(/ipcMain\.handle\('open-external',[\s\S]*?\n  \}\)/)?.[0]
  assert.ok(registration)
  let handler
  let finish
  const launch = new Promise(resolve => { finish = resolve })
  const shell = { openExternal: url => {
    assert.equal(url, 'https://example.com/')
    return launch
  } }
  vm.runInNewContext(registration, { shell, ipcMain: { handle: (_channel, callback) => { handler = callback } } })
  assert.equal(handler({}, 'https://example.com/'), launch)
  finish()
  await launch

  shell.openExternal = async () => { throw new Error('Example browser launch failure') }
  await assert.rejects(handler({}, 'https://example.com/'), /Example browser launch failure/)
})
