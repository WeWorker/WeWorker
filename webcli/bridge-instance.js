import { homedir } from 'node:os'
import { join } from 'node:path'

export const DESKTOP_BRIDGE_PORT = 3711
export const NPM_BRIDGE_PORT = 3712
export const WEBGO_BRIDGE_PORT = 3713

function parsePort(value, fallback) {
  if (value === undefined || value === '') return fallback
  if (!/^\d+$/.test(String(value))) throw new Error('WEBCLI_BRIDGE_PORT must be an integer')
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('WEBCLI_BRIDGE_PORT must be between 1024 and 65535')
  return port
}

/**
 * The desktop host supplies its selected port, defaulting to 3711. The npm executable sets
 * WEWORKER_WEBCLI_DISTRIBUTION=npm before loading the core and is pinned to 3712.
 * The internal webgo distribution (npm-packaged, separate from webcli) is pinned
 * to 3713 so webgo and webcli can run side by side without Bridge port conflicts.
 */
export function resolveBridgeInstance({ env = process.env, home = homedir() } = {}) {
  const dist = env.WEWORKER_WEBCLI_DISTRIBUTION
  const webgo = dist === 'webgo'
  const isolated = dist === 'npm' || webgo
  const fallback = webgo ? WEBGO_BRIDGE_PORT : isolated ? NPM_BRIDGE_PORT : DESKTOP_BRIDGE_PORT
  const port = parsePort(env.WEBCLI_BRIDGE_PORT, fallback)
  if (isolated && port !== fallback) {
    throw new Error(`${webgo ? 'webgo' : 'npm'} WebCLI uses its packaged Bridge port ${fallback}`)
  }
  return Object.freeze({
    kind: webgo ? 'webgo' : isolated ? 'npm' : 'desktop',
    port,
    connectHost: isolated ? '127.0.0.1' : 'localhost',
    bindHost: isolated ? '127.0.0.1' : undefined,
    stateDir: isolated ? join(home, '.webcli', `${webgo ? 'webgo' : 'npm'}-${port}`) : undefined,
  })
}

export function bridgeUrl(instance) {
  return `ws://${instance.connectHost}:${instance.port}`
}
