import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { normalizeLockfileRegistry } from '../normalize-lockfile-registry.mjs'

const INTRANET_FFLATE = {
  lockfileVersion: 3,
  packages: {
    'node_modules/fflate': {
      version: '0.8.3',
      resolved: 'http://wnpm.weoa.com:8001/fflate/-/fflate-0.8.3.tgz',
      integrity: 'sha512-tbZNuJrLwGUp3zshBtdy4W+ORxZuIh8a5ilyIEQDC5rY1f3U20JMry0Ll3WBzU58EZKsEuJFXhb5gwv8CsPvgA==',
    },
  },
}

function fixtureLockfile(content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-lockfile-registry-'))
  const file = path.join(root, 'package-lock.json')
  fs.writeFileSync(file, content)
  return file
}

test('rewrites intranet wnpm resolved URLs to the public mirror', () => {
  const file = fixtureLockfile(`${JSON.stringify(INTRANET_FFLATE, null, 2)}\n`)

  assert.deepEqual(normalizeLockfileRegistry([file]), [file])

  const updated = fs.readFileSync(file, 'utf8')
  assert.match(updated, /registry\.npmmirror\.com\/fflate\/-\/fflate-0\.8\.3\.tgz/)
  assert.ok(!updated.includes('wnpm.weoa.com'))
  assert.ok(updated.includes('sha512-tbZNuJrLwGUp3zsh'))
})

test('leaves lockfiles without intranet URLs untouched and is idempotent', () => {
  const publicLockfile = {
    lockfileVersion: 3,
    packages: {
      'node_modules/fflate': {
        version: '0.8.3',
        resolved: 'https://registry.npmmirror.com/fflate/-/fflate-0.8.3.tgz',
      },
    },
  }
  const file = fixtureLockfile(`${JSON.stringify(publicLockfile, null, 2)}\n`)

  assert.deepEqual(normalizeLockfileRegistry([file]), [])
  assert.equal(fs.readFileSync(file, 'utf8'), `${JSON.stringify(publicLockfile, null, 2)}\n`)
  assert.deepEqual(normalizeLockfileRegistry([file]), [])
})
