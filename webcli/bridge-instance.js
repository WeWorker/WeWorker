import { homedir } from 'node:os'
import { join } from 'node:path'

export const DESKTOP_BRIDGE_PORT = 3711
export const NPM_BRIDGE_PORT = 3712

function parsePort(value, fallback) {
  if (value === undefined || value === '') return fallback
  if (!/^\d+$/.test(String(value))) throw new Error('WEBCLI_BRIDGE_PORT must be an integer')
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('WEBCLI_BRIDGE_PORT must be between 1024 and 65535')
  return port
}

/**
 * The shared core and the desktop bundle keep using 3711. The npm executable sets
 * WEWORKER_WEBCLI_DISTRIBUTION=npm before loading the core and is pinned to 3712.
 */
export function resolveBridgeInstance({ env = process.env, home = homedir() } = {}) {
  const npm = env.WEWORKER_WEBCLI_DISTRIBUTION === 'npm'
  const port = parsePort(env.WEBCLI_BRIDGE_PORT, npm ? NPM_BRIDGE_PORT : DESKTOP_BRIDGE_PORT)
  if (npm && port !== NPM_BRIDGE_PORT) {
    throw new Error(`npm WebCLI uses its packaged Bridge port ${NPM_BRIDGE_PORT}`)
  }
  return Object.freeze({
    kind: npm ? 'npm' : 'desktop',
    port,
    connectHost: npm ? '127.0.0.1' : 'localhost',
    bindHost: npm ? '127.0.0.1' : undefined,
    stateDir: npm ? join(home, '.webcli', `npm-${port}`) : undefined,
  })
}

export function bridgeUrl(instance) {
  return `ws://${instance.connectHost}:${instance.port}`
}
