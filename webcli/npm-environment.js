import { homedir } from 'node:os'
import { join } from 'node:path'
import { NPM_BRIDGE_PORT } from './bridge-instance.js'

/**
 * Prepare the environment for the npm executable before the shared core loads.
 * Explicit browser/Adapter roots win; the port and distribution marker do not,
 * because the bundled extension is built for 3712 only.
 */
export function prepareNpmEnvironment(env = process.env, home = homedir()) {
  if (env.WEWORKER_RESOURCES_PATH) {
    throw new Error('WEWORKER_RESOURCES_PATH is not supported by the npm WebCLI')
  }
  if (env.WEBCLI_BRIDGE_PORT && env.WEBCLI_BRIDGE_PORT !== String(NPM_BRIDGE_PORT)) {
    throw new Error(`npm WebCLI uses its packaged Bridge port ${NPM_BRIDGE_PORT}`)
  }
  return {
    ...env,
    WEWORKER_WEBCLI_DISTRIBUTION: 'npm',
    WEBCLI_BRIDGE_PORT: String(NPM_BRIDGE_PORT),
    WEWORKER_BROWSER_HOME: env.WEWORKER_BROWSER_HOME || join(home, '.webcli', 'browser'),
    WEWORKER_USER_ADAPTERS_DIR: env.WEWORKER_USER_ADAPTERS_DIR || join(home, '.webcli', 'adapters'),
    WEWORKER_ADAPTER_DATA_DIR: env.WEWORKER_ADAPTER_DATA_DIR || join(home, '.webcli'),
  }
}
