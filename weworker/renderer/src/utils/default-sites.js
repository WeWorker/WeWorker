import defaultSites from '../../../default-site.json' with { type: 'json' }
import defaultWelcomePrompts from '../../../welcome-prompts.json' with { type: 'json' }

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

/** Fixed shortcuts belong to release-configured sites, independently of favorites and prompt rotation. */
export function getFixedWelcomePrompts(sites = [], prompts = defaultWelcomePrompts, config = defaultSites) {
  if (!Array.isArray(sites) || !Array.isArray(prompts) || !Array.isArray(config)) return []
  const availableIds = new Set(filterAvailableSites(sites, config)
    .filter(site => site.enabled !== false)
    .map(site => site.id))

  return prompts.filter(prompt => availableIds.has(prompt?.siteId)
    && typeof prompt.text === 'string' && prompt.text.trim())
    .slice(0, 5)
}
