/**
 * Site scenarios — consumed from GET /sites `scenarios` field (backend-resolved).
 */

import { formatPromptForFill } from './prompt-var-display.js'

/**
 * Normalize API scenario payload for UI (snake_case → camelCase).
 * @param {{ scenarios?: Array<object>, promptVarDisplay?: object }} site
 */
export function normalizeSiteScenarios(site) {
  const list = site.scenarios
  if (!Array.isArray(list) || list.length === 0) return []
  return list.map((sc) => ({
    id: sc.id,
    title: sc.title,
    summary: sc.summary,
    steps: sc.steps,
    prompts: Array.isArray(sc.prompts) ? sc.prompts : [],
    updatedAt: sc.updated_at || '',
    source: sc.source || 'registry',
  }))
}

/**
 * Text to put in the chat input when user picks a scenario.
 */
export function getScenarioPromptText(site, scenario) {
  const varDisplay = site.promptVarDisplay || {}
  const prompt = scenario.prompts?.find((item) => item?.text?.trim())
  if (prompt?.text?.trim()) {
    return formatPromptForFill(prompt.text, varDisplay)
  }
  return scenario.summary?.trim() || scenario.title?.trim() || ''
}

/** Filter capability sites without assuming optional display fields are strings. */
export function filterCapabilitySites(sites, query) {
  const q = query.trim().toLowerCase()
  if (!q) return sites
  const matches = (value) => typeof value === 'string' && value.toLowerCase().includes(q)
  return sites.filter((site) =>
    matches(site.name) || matches(site.description) ||
    normalizeSiteScenarios(site).some((scenario) => matches(scenario.title) || matches(scenario.summary)),
  )
}
