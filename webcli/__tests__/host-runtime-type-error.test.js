// Feature: args-json-quote, host-runtime 类型校验报错增强(问题2:agent 无法自纠)
import { describe, expect, it } from 'vitest'
import { createHostRuntime } from '../host-runtime.js'

describe('validateArgs 类型错误报错增强', () => {
  const runtime = createHostRuntime()
  const schema = {
    type: 'object',
    properties: {
      'story-id': { type: 'string' },
      maxDays: { type: 'integer' },
    },
    required: [],
  }

  it('数组值 vs string schema → 报错含 收到类型/期望类型/规避指引', () => {
    try {
      runtime.validateArgs({ 'story-id': [554712] }, schema)
      expect.unreachable('应抛 INVALID_ARGS')
    } catch (e) {
      expect(e.code).toBe('INVALID_ARGS')
      expect(e.message).toContain('story-id')
      expect(e.message).toContain('array')
      expect(e.message).toContain('string')
      expect(e.message).toContain('--args')
    }
  })
  it('数字值 vs string schema → 同样引导', () => {
    try {
      runtime.validateArgs({ maxDays: '7' }, schema)
      expect.unreachable('应抛 INVALID_ARGS')
    } catch (e) {
      expect(e.message).toContain('maxDays')
      expect(e.message).toContain('string')
    }
  })
  it('类型匹配时不抛错(行为不变)', () => {
    expect(() => runtime.validateArgs({ 'story-id': '554712', maxDays: 7 }, schema)).not.toThrow()
  })
})
