import assert from 'node:assert/strict'
import { test } from 'node:test'
import { filterCapabilitySites } from '../utils/site-scenarios.js'

test('capability search tolerates missing, null and non-string display fields', () => {
  const sites = [
    { name: 'Example', scenarios: [{ title: '查询' }] },
    { scenarios: [{ summary: '报告' }] },
    { name: null, description: 42, scenarios: [{ title: null, summary: 12 }] },
    { name: 'Empty' },
  ]
  assert.deepEqual(filterCapabilitySites(sites, 'no-match'), [])
  assert.deepEqual(filterCapabilitySites(sites, '查询'), [sites[0]])
  assert.deepEqual(filterCapabilitySites(sites, '报告'), [sites[1]])
  assert.deepEqual(filterCapabilitySites(sites, ' EXAMPLE '), [sites[0]])
  assert.equal(filterCapabilitySites(sites, '  '), sites)
})

test('capability search preserves order and matches descriptions without mutating sites', () => {
  const sites = [
    { name: 'First', description: 'Search documents' },
    { name: 'Second', scenarios: [{ title: 'Search mail', summary: 'Messages' }] },
  ]
  const before = structuredClone(sites)
  assert.deepEqual(filterCapabilitySites(sites, 'search'), sites)
  assert.deepEqual(filterCapabilitySites(sites, 'messages'), [sites[1]])
  assert.deepEqual(sites, before)
})
