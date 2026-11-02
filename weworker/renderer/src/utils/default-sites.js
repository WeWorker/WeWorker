import defaultSites from '../../../default-site.json' with { type: 'json' }

/** Either manifest or release defaults can disable a site; omitted flags default to enabled. */
export function filterAvailableSites(sites, config = defaultSites) {
  const configById = new Map(config
    .filter((entry) => typeof entry === 'object' && entry !== null && typeof entry.id === 'string')
    .map((entry) => [entry.id, entry]))

  return sites.filter((site) => {
    const releaseConfig = configById.get(site.id)
    return site.clientEnabled !== false && releaseConfig?.enabled !== false
  })
}
