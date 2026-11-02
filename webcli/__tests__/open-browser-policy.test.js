import { describe, expect, it } from 'vitest'
import {
  assertAllowedOpenBrowserUrl,
  buildAllowedOpenBrowserOrigins,
} from '../open-browser-policy.js'

describe('open_browser allowlist', () => {
  const manifests = [
    {
      id: 'expense.example.com',
      match: ['expense.example.com'],
      homepage_url: 'https://expense.example.com/spa/workflow/static4form/index.html#/main/workflow/req',
    },
    {
      id: 'ssh.bdp.example.com',
      match: ['uat.ssh.bdp.example.com'],
    },
  ]

  it('allows adapter homepage and same-origin URLs', () => {
    const allowed = buildAllowedOpenBrowserOrigins(manifests, '')

    expect(assertAllowedOpenBrowserUrl('https://expense.example.com/spa/workflow/static4form/index.html#/main/workflow/req', allowed)).toBe('https://expense.example.com/spa/workflow/static4form/index.html#/main/workflow/req')
    expect(assertAllowedOpenBrowserUrl('https://expense.example.com/another/path', allowed)).toBe('https://expense.example.com/another/path')
  })

  it('allows http and https origins for manifest match hosts without homepage_url', () => {
    const allowed = buildAllowedOpenBrowserOrigins(manifests, '')

    expect(assertAllowedOpenBrowserUrl('http://uat.ssh.bdp.example.com/', allowed)).toBe('http://uat.ssh.bdp.example.com/')
    expect(assertAllowedOpenBrowserUrl('https://uat.ssh.bdp.example.com/terminal', allowed)).toBe('https://uat.ssh.bdp.example.com/terminal')
  })

  it('rejects unlisted public and local URLs', () => {
    const allowed = buildAllowedOpenBrowserOrigins(manifests, '')

    expect(() => assertAllowedOpenBrowserUrl('https://attacker.example/phish', allowed)).toThrow(/not allowed/i)
    expect(() => assertAllowedOpenBrowserUrl('http://127.0.0.1:8765/logs', allowed)).toThrow(/not allowed/i)
  })

  it('allows explicit enterprise overrides from environment style CSV', () => {
    const allowed = buildAllowedOpenBrowserOrigins([], 'https://internal.example.com, http://dev.local:3000')

    expect(assertAllowedOpenBrowserUrl('https://internal.example.com/home', allowed)).toBe('https://internal.example.com/home')
    expect(assertAllowedOpenBrowserUrl('http://dev.local:3000/test', allowed)).toBe('http://dev.local:3000/test')
  })

  it('allows explicitly configured localhost origins without allowing other localhost ports', () => {
    const allowed = buildAllowedOpenBrowserOrigins([], 'http://127.0.0.1:8765')

    expect(assertAllowedOpenBrowserUrl('http://127.0.0.1:8765/logs', allowed)).toBe('http://127.0.0.1:8765/logs')
    expect(() => assertAllowedOpenBrowserUrl('http://127.0.0.1:9999/logs', allowed)).toThrow(/not allowed/i)
  })

  it.each(['ask', 'full'])('%s mode bypasses the configured site whitelist after its mode gate', mode => {
    const previous = process.env.WEWORKER_CHAT_PERMISSION_MODE
    process.env.WEWORKER_CHAT_PERMISSION_MODE = mode
    try {
      const allowed = buildAllowedOpenBrowserOrigins([], 'https://example.com')
      expect(assertAllowedOpenBrowserUrl('https://unlisted.example.org/path', allowed)).toBe('https://unlisted.example.org/path')
    } finally {
      if (previous === undefined) delete process.env.WEWORKER_CHAT_PERMISSION_MODE
      else process.env.WEWORKER_CHAT_PERMISSION_MODE = previous
    }
  })
})
