import { homedir } from 'node:os'
import { join } from 'node:path'
import { NPM_BRIDGE_PORT, WEBGO_BRIDGE_PORT } from './bridge-instance.js'

/**
 * Prepare the isolated npm-packaged environment before the shared core loads.
 * Explicit browser/Adapter roots win; the port and distribution marker do not,
 * because the bundled extension is built for a fixed port only.
 */
function prepareIsolatedEnvironment(env, home, { distribution, port, label }) {
  if (env.WEWORKER_RESOURCES_PATH) {
    throw new Error(`WEWORKER_RESOURCES_PATH is not supported by the ${label} WebCLI`)
  }
  if (env.WEBCLI_BRIDGE_PORT && env.WEBCLI_BRIDGE_PORT !== String(port)) {
    throw new Error(`${label} WebCLI uses its packaged Bridge port ${port}`)
  }
  return {
    ...env,
    WEWORKER_WEBCLI_DISTRIBUTION: distribution,
    WEBCLI_BRIDGE_PORT: String(port),
    WEWORKER_BROWSER_HOME: env.WEWORKER_BROWSER_HOME || join(home, '.webcli', 'browser'),
    WEWORKER_USER_ADAPTERS_DIR: env.WEWORKER_USER_ADAPTERS_DIR || join(home, '.webcli', 'adapters'),
    WEWORKER_ADAPTER_DATA_DIR: env.WEWORKER_ADAPTER_DATA_DIR || join(home, '.webcli'),
  }
}

export function prepareNpmEnvironment(env = process.env, home = homedir()) {
  return prepareIsolatedEnvironment(env, home, { distribution: 'npm', port: NPM_BRIDGE_PORT, label: 'npm' })
}

export function prepareWebgoEnvironment(env = process.env, home = homedir()) {
  return prepareIsolatedEnvironment(env, home, { distribution: 'webgo', port: WEBGO_BRIDGE_PORT, label: 'webgo' })
}
