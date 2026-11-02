import defaultSites from '../../../default-site.json' with { type: 'json' }

export const WELCOME_PROMPT_PLACEHOLDERS = Object.freeze([
  '输入“帮我总结这个网页”，试一试吧。',
  '输入“查找并对比几款商品”，试一试吧。',
  '输入“帮我填写并提交表单”，试一试吧。',
  '输入“筛选本周订单并导出”，试一试吧。',
  '输入“整理页面上的关键信息”，试一试吧。',
  '输入“搜索附近的咖啡店”，试一试吧。',
])

function getAdapterPrompts(site) {
  const prompts = [
    ...(Array.isArray(site?.testPrompts) ? site.testPrompts : []),
    ...(Array.isArray(site?.scenarios) ? site.scenarios.flatMap((scenario) =>
      Array.isArray(scenario?.prompts) ? scenario.prompts.map((prompt) => prompt?.text) : [],
    ) : []),
  ]
  return [...new Set(prompts.map((prompt) => String(prompt || '').trim()).filter(Boolean))]
}

export function getRandomWelcomePromptPlaceholder(previous = '', sites = [], random = Math.random, config = defaultSites) {
  const enabledSiteIds = new Set(config
    .filter((entry) => entry && typeof entry === 'object' && entry.random_prompt_enabled === true)
    .map((entry) => entry.id))
  const adapterPrompts = sites
    .filter((site) => site?.enabled !== false && enabledSiteIds.has(site?.id))
    .flatMap(getAdapterPrompts)
  const prompts = adapterPrompts.length
    ? adapterPrompts
    : WELCOME_PROMPT_PLACEHOLDERS.map((prompt) => prompt.replace(/^输入“/, '').replace(/”，试一试吧。$/, ''))
  const previousPrompt = String(previous || '').replace(/^输入“/, '').replace(/”，试一试吧。$/, '')
  const options = prompts.filter((prompt) => prompt !== previousPrompt)
  const value = Number(random())
  const index = Math.min(options.length - 1, Math.max(0, Math.floor(value * options.length)))
  const selected = options[index] || prompts[0] || WELCOME_PROMPT_PLACEHOLDERS[0]
  return `输入“${selected}”，试一试吧。`
}
