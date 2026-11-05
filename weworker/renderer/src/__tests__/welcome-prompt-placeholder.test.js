import test from 'node:test'
import assert from 'node:assert/strict'
import { getRandomWelcomePromptPlaceholder, WELCOME_PROMPT_PLACEHOLDERS } from '../utils/welcome-prompt-placeholder.js'

test('首页场景提示使用统一引导格式', () => {
  assert.ok(WELCOME_PROMPT_PLACEHOLDERS.length >= 4)
  for (const prompt of WELCOME_PROMPT_PLACEHOLDERS) {
    assert.match(prompt, /^输入“.+”，试一试吧。$/)
  }
})

test('随机场景提示连续轮换时不会重复', () => {
  const previous = WELCOME_PROMPT_PLACEHOLDERS[0]
  const next = getRandomWelcomePromptPlaceholder(previous, [], () => 0)
  assert.notEqual(next, previous)
  assert.ok(WELCOME_PROMPT_PLACEHOLDERS.includes(next))
})

test('仅将配置启用的 Adapter 提示词放入随机池', () => {
  const sites = [
    { id: 'enabled.example.com', enabled: true, testPrompts: ['启用站点提示词'] },
    { id: 'disabled.example.com', enabled: true, testPrompts: ['关闭站点提示词'] },
    { id: 'missing.example.com', enabled: true, testPrompts: ['缺省配置提示词'] },
  ]
  const config = [
    { id: 'enabled.example.com', random_prompt_enabled: true },
    { id: 'disabled.example.com', random_prompt_enabled: false },
  ]

  assert.equal(getRandomWelcomePromptPlaceholder('', sites, () => 0, config), '输入“启用站点提示词”，试一试吧。')
})

test('Adapter 场景提示词也可参与随机池，空池时使用通用提示', () => {
  const site = {
    id: 'scenario.example.com',
    scenarios: [{ prompts: [{ text: '场景提示词' }, { text: '  ' }] }],
  }
  assert.equal(
    getRandomWelcomePromptPlaceholder('', [site], () => 0, [{ id: site.id, random_prompt_enabled: true }]),
    '输入“场景提示词”，试一试吧。',
  )

  assert.equal(getRandomWelcomePromptPlaceholder('', [site], () => 0, []), WELCOME_PROMPT_PLACEHOLDERS[0])
})
