import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

it('backend listener and Host validation use the launch-selected port', async () => {
  vi.stubEnv('WEWORK_PORT', '48765')
  vi.resetModules()
  const security = await import('../http-security.js')
  expect(security.LOCAL_HTTP_PORT).toBe(48765)
  expect(security.isAllowedHost('127.0.0.1:48765')).toBe(true)
  expect(security.isAllowedHost('127.0.0.1:8765')).toBe(false)
  expect(security.isAllowedHost('example.com:48765')).toBe(false)
})

it.each(['0', '-1', '65536', 'invalid'])('rejects invalid backend port %s before binding', async port => {
  vi.stubEnv('WEWORK_PORT', port)
  vi.resetModules()
  await expect(import('../http-security.js')).rejects.toThrow('Invalid local backend port')
})
