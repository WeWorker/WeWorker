import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { filterFeaturedSites } from '../components/welcome/welcome-utils.js'

const rows = [
  { site: { id: 'mail.example.com', name: '示例邮箱' }, scenarios: [] },
  { site: { id: 'travel.example.com', name: 'Example Travel' }, scenarios: [] },
  { site: { id: 'docs.example.org', name: '示例文档' }, scenarios: [] },
]

describe('welcome featured site search', () => {
  it('returns all added sites in their original order for an empty query', () => {
    assert.equal(filterFeaturedSites(rows, ''), rows)
    assert.equal(filterFeaturedSites(rows, '   '), rows)
  })

  it('matches names and domains, ignoring case and surrounding whitespace', () => {
    assert.deepEqual(filterFeaturedSites(rows, '邮箱'), [rows[0]])
    assert.deepEqual(filterFeaturedSites(rows, '  EXAMPLE TRAVEL  '), [rows[1]])
    assert.deepEqual(filterFeaturedSites(rows, ' DOCS.EXAMPLE.ORG '), [rows[2]])
  })

  it('also matches the name displayed on the site card', () => {
    const displayName = (site) => site.id === 'travel.example.com' ? '示例旅行' : site.name
    assert.deepEqual(filterFeaturedSites(rows, '旅行', displayName), [rows[1]])
    assert.deepEqual(filterFeaturedSites(rows, 'Example Travel', displayName), [rows[1]])
  })

  it('searches only the added rows without changing their order or contents', () => {
    const addedRows = rows.slice(0, 2)
    const before = structuredClone(addedRows)
    assert.deepEqual(filterFeaturedSites(addedRows, 'example.com'), addedRows)
    assert.deepEqual(filterFeaturedSites(addedRows, 'docs'), [])
    assert.deepEqual(addedRows, before)
  })

  it('handles no matches, empty lists, and sites without a display name', () => {
    assert.deepEqual(filterFeaturedSites(rows, 'missing.example.com'), [])
    assert.deepEqual(filterFeaturedSites([], 'example'), [])
    const unnamed = [{ site: { id: 'unnamed.example.com' }, scenarios: [] }]
    assert.deepEqual(filterFeaturedSites(unnamed, 'unnamed'), unnamed)
  })
})
