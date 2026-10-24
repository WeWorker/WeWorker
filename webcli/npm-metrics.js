import fs from 'node:fs'
import path from 'node:path'

/**
 * Packaged metrics defaults for the npm executable.
 *
 * prepack writes metrics-client.json next to the package root: `{enabled:false}`
 * for public builds, `{enabled,endpoint,token}` when the build environment
 * approved reporting. Existing process environment always wins so users can
 * override or opt out; missing or tampered files fail closed.
 */
export function packagedMetricsEnvironment({ packageDir, env = process.env }) {
  let config
  try { config = JSON.parse(fs.readFileSync(path.join(packageDir, 'metrics-client.json'), 'utf8')) }
  catch { return {} }
  if (config?.enabled !== true || typeof config.token !== 'string' || config.token.length < 32) return {}
  let endpoint
  try { endpoint = new URL(config.endpoint) } catch { return {} }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.pathname !== '/v1/metrics/batch'
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return {}
  return Object.fromEntries([
    ['WEBCLI_METRICS_ENDPOINT', endpoint.href],
    ['WEBCLI_METRICS_TOKEN', config.token],
    ['WEBCLI_METRICS_UPLOAD', 'on'],
  ].filter(([key]) => env[key] === undefined))
}
