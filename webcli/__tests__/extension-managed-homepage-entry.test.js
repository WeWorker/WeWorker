import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const EXTENSION_DIR = resolve(process.cwd(), '../extension')

/**
 * ★ Managed page-command auto-open must prefer the author-declared
 * `manifest.homepage_url` — the only manifest field that can carry a port or
 * path (match/domains are host-only, e.g. https://host:8443/app/ cannot be
 * expressed there) — over the neutral `http://<primary-host>/` entry, matching
 * the legacy routing path (getHomepageUrlForDomain). The declared entry is used
 * only while it stays inside the Adapter's declared page scope.
 */
describe('extension managed auto-open homepage preference', () => {
  it('opens manifest.homepage_url first, scope-guarded, with the http host entry as fallback', () => {
    const source = readFileSync(resolve(EXTENSION_DIR, 'background', 'service-worker.js'), 'utf8')

    const entry = source.match(/const declaredHome = typeof selected\.manifest\.homepage_url[\s\S]{0,500}?createBrowserTab\(\{ url: startUrl/)
    expect(entry).toBeTruthy()
    expect(entry[0]).toContain("typeof selected.manifest.homepage_url === 'string'")
    expect(entry[0]).toContain('selected.manifest.homepage_url.trim()')
    // Only inside the declared page scope; otherwise keep the neutral entry.
    expect(entry[0]).toContain("classifyNavigationTarget(selected.manifest, declaredHome) === 'allowed'")
    expect(entry[0]).toContain("'http://' + route + '/'")
    // The opened URL still passes the hard host assertion before any tab opens.
    expect(entry[0]).toContain('assertAdapterNavigationUrl(selected.manifest')
  })

  it('keeps the legacy homepage lookup as the parity reference', () => {
    const source = readFileSync(resolve(EXTENSION_DIR, 'background', 'service-worker.js'), 'utf8')
    const legacy = source.match(/async function getHomepageUrlForDomain[\s\S]{0,700}?return null/)
    expect(legacy).toBeTruthy()
    expect(legacy[0]).toContain('manifest.homepage_url')
    expect(legacy[0]).toContain('manifest.homepage_url.trim()')
  })
})
