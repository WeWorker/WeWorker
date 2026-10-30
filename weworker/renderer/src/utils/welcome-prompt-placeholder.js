export const WELCOME_PROMPT_PLACEHOLDERS = Object.freeze([
  '输入“帮我总结这个网页”，试一试吧。',
  '输入“查找并对比几款商品”，试一试吧。',
  '输入“帮我填写并提交表单”，试一试吧。',
  '输入“筛选本周订单并导出”，试一试吧。',
  '输入“整理页面上的关键信息”，试一试吧。',
  '输入“搜索附近的咖啡店”，试一试吧。',
])

export function getRandomWelcomePromptPlaceholder(previous = '', random = Math.random) {
  const options = WELCOME_PROMPT_PLACEHOLDERS.filter((prompt) => prompt !== previous)
  const value = Number(random())
  const index = Math.min(options.length - 1, Math.max(0, Math.floor(value * options.length)))
  return options[index] || WELCOME_PROMPT_PLACEHOLDERS[0]
}
