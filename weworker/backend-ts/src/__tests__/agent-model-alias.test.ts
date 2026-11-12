import { describe, expect, it } from 'vitest'
import { claudeQueryModel } from '../agent.js'

describe('claude query model', () => {
  it('uses an alias for custom gateways and keeps the official model name', () => {
    // 新版 CLI 只认 sonnet/opus/haiku；自定义网关的模型名走 ANTHROPIC_DEFAULT_*。
    expect(claudeQueryModel({ model: 'ark-code-latest', base_url: 'https://ark.example.com/api' })).toBe('sonnet')
    expect(claudeQueryModel({ model: 'claude-sonnet-4-5', base_url: 'https://api.anthropic.com' })).toBe('claude-sonnet-4-5')
  })

  it('passes the configured model through when the base url is unknown', () => {
    expect(claudeQueryModel({ model: 'glm-4.6', base_url: '' })).toBe('glm-4.6')
    expect(claudeQueryModel({ model: '', base_url: 'https://ark.example.com/api' })).toBe('')
  })
})
