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
  return {
    officialUrl: normalizeUrl(config.officialUrl, 'officialUrl'),
    downloadUrl: normalizeUrl(config.downloadUrl, 'downloadUrl', { trailingSlash: true }),
    githubUrl: normalizeUrl(config.githubUrl, 'githubUrl', { trailingSlash: true }),
  }
}

module.exports = { normalizeDeploymentConfig }
