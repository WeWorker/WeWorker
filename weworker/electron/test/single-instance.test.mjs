import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { acquireDesktopInstance } from '../single-instance.js'

class App extends EventEmitter {
  constructor(root, profile, shared) {
    super()
    this.paths = { appData: root, userData: path.join(root, profile) }
    this.shared = shared
  }
  getPath(key) { return this.paths[key] }
  setPath(key, value) { this.paths[key] = value }
  requestSingleInstanceLock(launch) {
    if (this.shared.owner) {
      assert.equal(this.shared.lockPath, this.paths.userData)
      this.shared.owner.emit('second-instance', {}, [], '', launch)
      return false
    }
    this.shared.owner = this
    this.shared.lockPath = this.paths.userData
    return true
  }
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-single-instance-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const shared = {}
  return { root, shared, older: new App(root, 'first', shared), newer: new App(root, 'second', shared) }
}

const launch = (pid) => ({ pid, launchedAt: pid })

test('newer launch waits for the old one to release the lock across profiles', async t => {
  const { root, shared, older, newer } = fixture(t)
  let requested = false
  assert.equal(await acquireDesktopInstance(older, () => { requested = true }, { appData: older.getPath('appData'), launch: launch(1) }), true)
  const takeover = acquireDesktopInstance(newer, assert.fail, { appData: older.getPath('appData'), launch: launch(2), retryMs: 5, timeoutMs: 1000 })
  assert.equal(requested, true)
  assert.equal(shared.owner, older)
  assert.equal(older.getPath('userData'), path.join(root, 'first'))
  assert.equal(newer.getPath('userData'), path.join(root, 'second'))
  shared.owner = null
  assert.equal(await takeover, true)
  assert.equal(shared.owner, newer)
  assert.equal(newer.getPath('userData'), path.join(root, 'second'))
})

test('older retry and invalid messages cannot displace the newest owner', async t => {
  const { shared, older, newer } = fixture(t)
  assert.equal(await acquireDesktopInstance(newer, assert.fail, { appData: older.getPath('appData'), launch: launch(2) }), true)
  newer.emit('second-instance', {}, [], '', {})
  assert.equal(await acquireDesktopInstance(older, assert.fail, { appData: older.getPath('appData'), launch: launch(1), retryMs: 5, timeoutMs: 10 }), false)
  assert.equal(shared.owner, newer)
  assert.equal(older.listenerCount('second-instance'), 0)
})
