import { describe, expect, it } from 'vitest'

import { classify, safeArgs } from '../scripts/run-api-adapter-live-reads.js'

const guardedTool = {
  name: 'example.write',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'integer' },
      ids: { type: 'array', items: { type: 'string' } },
      yes: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
    required: ['id', 'ids'],
  },
}

describe('API Adapter live certification runner', () => {
  it('builds confirmation-guard arguments without any confirmation bypass', () => {
    expect(safeArgs(guardedTool, 'guards')).toEqual({ id: 1, ids: ['__webcli_cert_probe_no_match__'] })
  })

  it('builds declared dry-run arguments without yes or __confirmed', () => {
    expect(safeArgs(guardedTool, 'dry-runs')).toEqual({
      id: 1,
      ids: ['__webcli_cert_probe_no_match__'],
      'dry-run': true,
    })
  })

  it('classifies an explicit confirmation barrier deterministically', () => {
    expect(classify('tool requires explicit user confirmation', 1, false)).toBe('CONFIRMATION_GUARD')
  })

  it('does not mistake successful payload fields for timeout errors', () => {
    expect(classify('{"result":{"timeout":10000}}', 0, false)).toBe('PASS')
  })

  it('classifies common live dry-run environment failures', () => {
    expect(classify('Browser authentication is required for URL', 1, false)).toBe('AUTH')
    expect(classify('API 会话过期或签名无效，请确认已登录', 1, false)).toBe('AUTH')
    expect(classify('您没有权限查看', 1, false)).toBe('PERMISSION')
    expect(classify('查询结果为空', 1, false)).toBe('FIXTURE_NOT_FOUND')
  })
})
