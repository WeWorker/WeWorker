import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  getFeaturedSiteAvailability,
  getHiddenFeaturedSites,
} from '../components/welcome/welcome-utils.js'

describe('welcome featured site availability', () => {
  it('allows adding an enabled site when every welcome site is hidden', () => {
    assert.deepEqual(getFeaturedSiteAvailability({ siteLimit: 50, visibleCount: 0, availableCount: 33 }), {
      limitReached: false,
      canAdd: true,
      nextVisibleCount: 1,
    })
  })

  it('offers hidden enabled sites in the add picker', () => {
    const hidden = { site: { id: 'fixture-hidden', visible: false } }
    const visibleOverflow = { site: { id: 'fixture-overflow', visible: true } }
    const featured = { site: { id: 'fixture-featured', visible: true } }
    assert.deepEqual(getHiddenFeaturedSites({
      visibleSites: [featured, visibleOverflow],
      enabledSites: [featured, visibleOverflow, hidden],
      visibleCount: 1,
    }), [visibleOverflow, hidden])
    assert.deepEqual(getHiddenFeaturedSites({
      visibleSites: [],
      enabledSites: [hidden],
      visibleCount: 0,
    }), [hidden])
  })

  it('disables adding when the configured limit is reached', () => {
    assert.deepEqual(getFeaturedSiteAvailability({ siteLimit: 2, visibleCount: 2, availableCount: 3 }), {
      limitReached: true,
      canAdd: false,
      nextVisibleCount: 2,
    })
  })

  it('does not report a limit when there are no additional enabled sites', () => {
    assert.deepEqual(getFeaturedSiteAvailability({ siteLimit: 50, visibleCount: 4, availableCount: 0 }), {
      limitReached: false,
      canAdd: false,
      nextVisibleCount: 5,
    })
  })
})
