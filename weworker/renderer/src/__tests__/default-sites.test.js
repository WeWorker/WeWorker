import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterAvailableSites } from '../utils/default-sites.js'
import { fetchSites } from '../api/sites-api.js'
import defaultSites from '../../../default-site.json' with { type: 'json' }

test('all release defaults are enabled', () => {
  assert.ok(defaultSites.every((entry) => typeof entry === 'string' || entry.enabled !== false))
})

test('all open-source sites opt into welcome prompt rotation', () => {
  assert.ok(defaultSites.every((entry) => typeof entry === 'string' || entry.random_prompt_enabled === true))
})

test('the bundled defaults keep enabled QQ Mail discoverable through the shared site API', async () => {
  const previousFetch = globalThis.fetch
  const previousWindow = globalThis.window
  const qqMail = { id: 'mail.qq.com', name: 'QQ邮箱', enabled: true, visible: false, icon: 'mail' }
  try {
    globalThis.window = {}
    globalThis.fetch = async (url) => {
      assert.equal(url, 'http://127.0.0.1:8765/sites')
      return Response.json([qqMail])
    }
    assert.deepEqual(await fetchSites(), [qqMail])
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

test('explicitly disabled sites are hidden while omitted flags default to enabled', () => {
  const sites = [
    { id: 'disabled.example.com', enabled: true, visible: true },
    { id: 'active.example.com', enabled: true, visible: true },
    { id: 'extra.example.com', enabled: true, visible: true },
  ]
  const config = [
    { id: 'disabled.example.com', enabled: false },
    { id: 'active.example.com', enabled: true },
  ]
  assert.deepEqual(filterAvailableSites(sites, config), sites.slice(1))
  assert.equal(sites.length, 3)
  assert.deepEqual(filterAvailableSites(sites, config.map((entry) => ({ ...entry, enabled: true }))), sites)
})

test('either manifest or release defaults can disable a site', () => {
  const sites = [
    { id: 'disabled-by-adapter.example.com', clientEnabled: false },
    { id: 'disabled-by-release.example.com', clientEnabled: true },
    { id: 'enabled-by-default.example.com' },
  ]
  const config = [
    { id: 'disabled-by-adapter.example.com', enabled: true },
    { id: 'disabled-by-release.example.com', enabled: false },
  ]
  assert.deepEqual(filterAvailableSites(sites, config), [sites[2]])
})

test('legacy strings, omitted enabled flags and extra installed sites retain backend order', () => {
  const sites = ['extra.example.com', 'legacy.example.com', 'default.example.com']
    .map((id) => ({ id }))
  assert.deepEqual(filterAvailableSites(sites, [
    'legacy.example.com', { id: 'default.example.com' },
    { id: 'absent.example.com', enabled: false },
  ]), sites)
  assert.deepEqual(filterAvailableSites([], []), [])
})

test('the shared site API filters release-disabled sites before returning data to the UI', async () => {
  const previousFetch = globalThis.fetch
  const previousWindow = globalThis.window
  const previousConfig = [...defaultSites]
  try {
    defaultSites.splice(0, defaultSites.length,
      { id: 'disabled.example.com', enabled: true },
      { id: 'active.example.com', enabled: true })
    globalThis.window = {}
    globalThis.fetch = async (url) => {
      assert.equal(url, 'http://127.0.0.1:8765/sites')
      return Response.json([
        { id: 'disabled.example.com', enabled: true, clientEnabled: false, visible: true, icon: 'globe' },
        { id: 'active.example.com', enabled: true, clientEnabled: true, visible: true, icon: 'globe' },
      ])
    }
    assert.deepEqual((await fetchSites()).map((site) => site.id), ['active.example.com'])
  } finally {
    defaultSites.splice(0, defaultSites.length, ...previousConfig)
    globalThis.fetch = previousFetch
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})
