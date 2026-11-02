import assert from 'node:assert/strict'
import test from 'node:test'
import { createDefaultProjectFolder, getProjectsDirectoryPath } from '../utils/project-folder.js'

test('default project folder uses a generated workspace path under the projects directory', () => {
  assert.equal(getProjectsDirectoryPath('C:\\Users\\example\\.weworker\\user-files'), 'C:\\Users\\example\\.weworker\\user-files\\projects')
  assert.equal(createDefaultProjectFolder('C:\\Users\\example\\.weworker\\user-files', 'fixture-id'), 'C:\\Users\\example\\.weworker\\user-files\\projects\\workspace-fixture-id')
})

test('default project folder supports POSIX paths and missing user directory', () => {
  assert.equal(createDefaultProjectFolder('/home/example/.weworker/user-files', 'fixture-id'), '/home/example/.weworker/user-files/projects/workspace-fixture-id')
  assert.equal(createDefaultProjectFolder('', 'fixture-id'), '')
})
