import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import defaultSites from '../../../default-site.json' with { type: 'json' }
import defaultWelcomePrompts from '../../../welcome-prompts.json' with { type: 'json' }
import buildProfile from '../../../build-profile.json' with { type: 'json' }
import { getFixedWelcomePrompts } from '../utils/default-sites.js'

test('fixed prompts retain file order independently of favorites and random placeholders', () => {
  const config = [
    { id: 'mail.example.com', random_prompt_enabled: false },
    { id: 'travel.example.com' },
  ]
  const prompts = [
    { id: 'travel', siteId: 'travel.example.com', text: '查询明天的车票' },
    { id: 'unread', siteId: 'mail.example.com', text: '查询未读邮件' },
    { id: 'invoices', siteId: 'mail.example.com', text: '搜索发票邮件' },
  ]
  const original = structuredClone(prompts)
  const sites = [{ id: 'mail.example.com', visible: false }, { id: 'travel.example.com' }]
  const result = getFixedWelcomePrompts(sites, prompts, config)
  assert.deepEqual(result.map(item => item.text), ['查询明天的车票', '查询未读邮件', '搜索发票邮件'])
  assert.deepEqual(result.map(item => item.siteId), ['travel.example.com', 'mail.example.com', 'mail.example.com'])
  assert.equal(new Set(result.map(item => item.id)).size, 3)
  assert.deepEqual(getFixedWelcomePrompts([...sites].reverse(), prompts, config), result)
  assert.deepEqual(prompts, original)
})

test('missing, release-disabled, manifest-disabled and user-disabled sites have no shortcuts', () => {
  const ids = ['missing', 'release-disabled', 'manifest-disabled', 'user-disabled', 'available']
  const config = ids.map(id => ({
    id: `${id}.example.com`, enabled: id !== 'release-disabled',
  }))
  const prompts = config.map(site => ({ siteId: site.id, text: `查看 ${site.id}` }))
  const sites = config.slice(1).map(entry => ({
    id: entry.id,
    clientEnabled: entry.id !== 'manifest-disabled.example.com',
    enabled: entry.id !== 'user-disabled.example.com',
  }))
  assert.deepEqual(getFixedWelcomePrompts(sites, prompts, config).map(item => item.siteId), ['available.example.com'])
  assert.deepEqual(getFixedWelcomePrompts([], prompts, config), [])
})

test('malformed entries are ignored, with a stable maximum of five shortcuts', () => {
  const site = { id: 'mail.example.com' }
  const config = [null, 'legacy.example.com', { id: site.id }]
  const prompts = [null, { siteId: site.id, text: ' ' }, { siteId: site.id, text: 123 }, { text: '缺少站点' },
    ...Array.from({ length: 7 }, (_, index) => ({ siteId: site.id, text: `提示 ${index}` }))]
  assert.deepEqual(getFixedWelcomePrompts([site], prompts, config).map(item => item.text), ['提示 0', '提示 1', '提示 2', '提示 3', '提示 4'])
  assert.deepEqual(getFixedWelcomePrompts([site], null), [])
  assert.deepEqual(getFixedWelcomePrompts(null, prompts), [])
  assert.deepEqual(getFixedWelcomePrompts([site], prompts, null), [])
})

test('all five release shortcuts belong to enabled bundled adapters', () => {
  assert.equal(defaultWelcomePrompts.length, 5)
  assert.equal(new Set(defaultWelcomePrompts.map(prompt => prompt.id)).size, 5)
  const configuredSites = defaultWelcomePrompts.map(prompt => defaultSites.find(site => site.id === prompt.siteId))
  for (const site of configuredSites) {
    assert.ok(site, 'every prompt must reference a release-configured site')
    assert.ok(buildProfile.adapters.includes(site.id), `${site.id} must be bundled`)
    assert.notEqual(site.enabled, false)
    const manifest = JSON.parse(readFileSync(new URL(`../../../../adapters/${site.id}/manifest.json`, import.meta.url), 'utf8'))
    assert.notEqual(manifest.enabled, false)
    assert.ok(manifest.commands?.length > 0)
  }
  for (const prompt of defaultWelcomePrompts) {
    assert.equal(typeof prompt.id, 'string')
    assert.ok(prompt.id.trim())
    assert.equal(typeof prompt.text, 'string')
    assert.ok(prompt.text.trim())
  }
  assert.equal(getFixedWelcomePrompts(configuredSites).length, 5)
})
