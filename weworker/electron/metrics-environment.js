import fs from 'node:fs'
import path from 'node:path'

export function packagedMetricsEnvironment({ packaged, resourcesPath, env = process.env }) {
  if (!packaged) return {}
  let config
  try { config = JSON.parse(fs.readFileSync(path.join(resourcesPath, 'metrics-client.json'), 'utf8')) }
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
