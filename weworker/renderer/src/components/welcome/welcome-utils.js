export const FEATURED_ORDER_KEY = 'weworker.welcome.featuredSiteOrder'
export const FEATURED_VISIBLE_COUNT_KEY = 'weworker.welcome.featuredVisibleCount.v2'
export const FEATURED_SQUARE_CARDS_KEY = 'weworker.welcome.featuredSquareCards'
export const CONVERSATION_EXAMPLE_VISIBLE_KEY = 'weworker.welcome.conversationExampleVisible'
export const DEFAULT_FEATURED_VISIBLE_COUNT = 5
export const DEFAULT_WELCOME_FEATURED_SITE_LIMIT = 50
export const DEFAULT_FEATURED_SQUARE_CARDS = true
export const ADD_FEATURED_DROP_TARGET = '__add-featured-drop-target__'

export function getFeaturedSiteAvailability({ siteLimit, visibleCount, availableCount }) {
  const limit = Math.max(1, Number(siteLimit) || DEFAULT_WELCOME_FEATURED_SITE_LIMIT)
  const count = Math.max(0, Number(visibleCount) || 0)
  const available = Math.max(0, Number(availableCount) || 0)
  return {
    limitReached: count >= limit,
    canAdd: count < limit && available > 0,
    nextVisibleCount: Math.min(limit, count + 1),
  }
}

export function getHiddenFeaturedSites({ visibleSites, enabledSites, visibleCount }) {
  const candidates = [
    ...visibleSites.slice(visibleCount),
    ...enabledSites.filter(({ site }) => !site.visible),
  ]
  const candidateIds = new Set()
  return candidates.filter(({ site }) => {
    if (candidateIds.has(site.id)) return false
    candidateIds.add(site.id)
    return true
  })
}

export function readFeaturedOrder() {
  if (typeof window === 'undefined') return []
  try {
    const parsed = JSON.parse(window.localStorage.getItem(FEATURED_ORDER_KEY) || '[]')
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []
  } catch {
    return []
  }
}

export function readFeaturedVisibleCount() {
  if (typeof window === 'undefined') return DEFAULT_FEATURED_VISIBLE_COUNT
  const raw = window.localStorage.getItem(FEATURED_VISIBLE_COUNT_KEY)
  if (raw === null) return DEFAULT_FEATURED_VISIBLE_COUNT
  const saved = Number(raw)
  return Number.isFinite(saved) ? Math.max(0, saved) : DEFAULT_FEATURED_VISIBLE_COUNT
}

export function readFeaturedSquareCards() {
  if (typeof window === 'undefined') return DEFAULT_FEATURED_SQUARE_CARDS
  const raw = window.localStorage.getItem(FEATURED_SQUARE_CARDS_KEY)
  if (raw === null) return DEFAULT_FEATURED_SQUARE_CARDS
  return raw === 'true'
}

export function readConversationExampleVisible() {
  if (typeof window === 'undefined') return true
  const raw = window.localStorage.getItem(CONVERSATION_EXAMPLE_VISIBLE_KEY)
  if (raw === null) return true
  return raw === 'true'
}

export function fallbackScenarios(site) {
  if (!site.description?.trim()) return []
  return [{
    id: `${site.id}-default`,
    title: '通用操作',
    summary: site.description,
    prompts: [],
  }]
}

export function clampText(text, max = 100) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}...` : clean
}

export function assistantText(site, scenario) {
  const reply = scenario.prompts?.find((prompt) => prompt?.reply?.trim())?.reply
  if (reply?.trim()) return reply.trim()
  const summary = scenario.summary || `完成「${scenario.title}」`
  const action = summary.replace(/^在[^中]+中/, '').replace(/^帮我/, '')
  return `我会打开 ${site.name}，先确认当前页面状态。\n然后${action}。\n需要你确认时，我会先停下来。`
}

export function userPromptTemplate(scenario) {
  return scenario.prompts?.find((prompt) => prompt?.text?.trim())?.text || ''
}

export function filterScenarios(scenarios, query) {
  const normalizedQuery = String(query || '').trim().toLowerCase()
  if (!normalizedQuery) return scenarios
  return scenarios.filter((scenario) => scenarioSearchText(scenario).includes(normalizedQuery))
}

function scenarioSearchText(scenario) {
  return [
    scenario.title,
    scenario.summary,
    ...(scenario.prompts || []).flatMap((prompt) => [prompt?.text || '', prompt?.reply || '']),
  ].join(' ').toLowerCase()
}
