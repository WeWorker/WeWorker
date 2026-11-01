import defaultSites from '../../../default-site.json' with { type: 'json' }

/** Release-level visibility takes precedence over saved user display preferences. */
export function filterAvailableSites(sites, config = defaultSites) {
  const disabledIds = new Set(config
    .filter((entry) => typeof entry === 'object' && entry !== null && entry.enabled === false)
    .map((entry) => entry.id))
  return sites.filter((site) => !disabledIds.has(site.id))
}
