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
  const next = getRandomWelcomePromptPlaceholder(previous, () => 0)
  assert.notEqual(next, previous)
  assert.ok(WELCOME_PROMPT_PLACEHOLDERS.includes(next))
})
