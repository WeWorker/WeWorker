const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

function normalizeUrl(value, field, { trailingSlash = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`deployment.${field} must be a non-empty URL`)
  }
  let url
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error(`deployment.${field} must be a valid URL`)
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error(`deployment.${field} must use http or https`)
  }
  url.hash = ''
  url.search = ''
  url.pathname = trailingSlash
    ? (url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`)
    : url.pathname.replace(/\/$/, '')
  return url.toString()
}

function normalizeDeploymentConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('deployment.json must contain an object')
  }
  if (!Array.isArray(config.updateSources) || config.updateSources.length === 0) {
    throw new Error('deployment.updateSources must be a non-empty array')
  }
  return {
    officialUrl: normalizeUrl(config.officialUrl, 'officialUrl'),
    downloadUrl: normalizeUrl(config.downloadUrl, 'downloadUrl'),
    updateSources: config.updateSources.map((source, index) => {
      if (!source || typeof source !== 'object' || Array.isArray(source)) {
        throw new Error(`deployment.updateSources[${index}] must be an object`)
      }
      if (typeof source.id !== 'string' || !source.id.trim()) {
        throw new Error(`deployment.updateSources[${index}].id must be a non-empty string`)
      }
      if (typeof source.label !== 'string' || !source.label.trim()) {
        throw new Error(`deployment.updateSources[${index}].label must be a non-empty string`)
      }
      return {
        id: source.id.trim(),
        label: source.label.trim(),
        url: normalizeUrl(source.url, `updateSources[${index}].url`, { trailingSlash: true }),
      }
    }),
  }
}

module.exports = { normalizeDeploymentConfig }
