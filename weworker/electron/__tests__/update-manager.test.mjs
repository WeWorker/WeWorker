import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { normalizeUpdateSettings } from '../update-settings.js'

const source = fs.readFileSync(new URL('../update-manager.js', import.meta.url), 'utf8')
  .replace(/^import .*\r?\n/gm, '')
  .replace('export class UpdateManager', 'class UpdateManager')

function setup({ check, download } = {}) {
  const calls = { checks: [], downloads: [] }
  const autoUpdater = new EventEmitter()
  let activeSource
  autoUpdater.setFeedURL = ({ url }) => { activeSource = url.includes('github.com') ? 'github' : 'mirror' }
  autoUpdater.checkForUpdates = async () => {
    calls.checks.push(activeSource)
    try {
      const version = await check?.(activeSource) || '1.0.1'
      autoUpdater.emit('update-available', { version })
      return { updateInfo: { version } }
    } catch (error) {
      autoUpdater.emit('error', error)
      throw error
    }
  }
  autoUpdater.downloadUpdate = async () => {
    calls.downloads.push(activeSource)
    try {
      await download?.(activeSource)
      autoUpdater.emit('update-downloaded', { version: '1.0.1' })
    } catch (error) {
      autoUpdater.emit('error', error)
      throw error
    }
  }
  const UpdateManager = vm.runInNewContext(`${source}\nUpdateManager`, {
    app: { isPackaged: true, getPath: () => '.', getVersion: () => '1.0.0' },
    fs: { existsSync: () => false },
    path,
    process: { platform: 'win32', arch: 'x64' },
    updater: { autoUpdater },
    normalizeUpdateSettings,
    deploymentRaw: {
      officialUrl: 'https://example.com',
      downloadUrl: 'https://example.com/downloads/',
      updateSources: [
        { id: 'mirror', label: '镜像源', url: 'https://example.com/updates/' },
        { id: 'github', label: 'GitHub latest', url: 'https://github.com/example/example/releases/latest/download/' },
      ],
    },
    deploymentConfigModule: { normalizeDeploymentConfig: value => value },
  })
  const manager = new UpdateManager()
  manager.settings.autoCheckEnabled = false
  manager.start()
  return { manager, calls }
}

test('uses the first configured source when its update check succeeds', async () => {
  const { manager, calls } = setup()
  const state = await manager.checkForUpdates()
  assert.equal(state.status, 'available')
  assert.equal(state.activeUpdateSource.id, 'mirror')
  assert.deepEqual(calls.checks, ['mirror'])
  assert.equal(state.sourceErrors.length, 0)
})

test('unavailable source falls back to the next configured source and downloads from it', async () => {
  const { manager, calls } = setup({
    check: async source => {
      if (source === 'mirror') throw Object.assign(new Error('Invalid update metadata'), { code: 'ERR_UPDATER_INVALID_VERSION' })
    },
  })
  const state = await manager.checkForUpdates()
  assert.equal(state.status, 'available')
  assert.equal(state.activeUpdateSource.id, 'github')
  assert.match(state.activeUpdateSource.metadataUrl, /\/releases\/latest\/download\/latest.yml$/)
  assert.match(state.sourceErrors[0], /ERR_UPDATER_INVALID_VERSION/)
  assert.equal((await manager.downloadUpdate()).status, 'downloaded')
  assert.deepEqual(calls.checks, ['mirror', 'github'])
  assert.deepEqual(calls.downloads, ['github'])
})

test('reports both source failures when neither update check succeeds', async () => {
  const { manager } = setup({ check: async () => { throw Object.assign(new Error('Unavailable'), { statusCode: 503 }) } })
  const state = await manager.checkForUpdates()
  assert.equal(state.status, 'error')
  assert.equal(state.sourceErrors.length, 2)
  assert.match(state.error, /镜像源 不可用（503）/)
  assert.match(state.error, /GitHub latest 不可用（503）/)
})

test('retries download from the next source when the active source installer fails', async () => {
  const { manager, calls } = setup({
    download: async source => {
      if (source === 'mirror') throw Object.assign(new Error('Installer missing'), { statusCode: 404 })
    },
  })
  await manager.checkForUpdates()
  const state = await manager.downloadUpdate()
  assert.equal(state.status, 'downloaded')
  assert.equal(state.activeUpdateSource.id, 'github')
  assert.deepEqual(calls.checks, ['mirror', 'github'])
  assert.deepEqual(calls.downloads, ['mirror', 'github'])
  assert.match(state.sourceErrors[0], /404/)
})

test('reports failure when installers from both sources cannot be downloaded', async () => {
  const { manager, calls } = setup({ download: async () => { throw new Error('Download unavailable') } })
  await manager.checkForUpdates()
  const state = await manager.downloadUpdate()
  assert.equal(state.status, 'error')
  assert.equal(state.sourceErrors.length, 2)
  assert.match(state.error, /所有更新源下载失败/)
  assert.deepEqual(calls.downloads, ['mirror', 'github'])
})
