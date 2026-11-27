import { describe, expect, it } from 'vitest'
import { buildPatrolList, indexSamples } from '../patrol/enumerate.js'

const caseManifest = {
  name: 'demo',
  cases: [
    { id: 'jd-search', site: 'jd.com', command: 'jd.com.search_products', safety: 'read', safetyMode: 'read', args: { keyword: '手机' } },
    { id: 'jd-del', site: 'jd.com', command: 'jd.com.delete_item', safety: 'mutating', safetyMode: 'nonexistent-resource', args: { id: '__x__' } },
    { id: 'xx-risky', site: 'x.com', command: 'x.com.submit', safety: 'high_risk', safetyMode: 'none' },
  ],
}

describe('indexSamples', () => {
  it('按 command 建索引，多份清单后者覆盖并保留来源', () => {
    const map = indexSamples([['a.json', caseManifest]])
    expect(map.get('jd.com.search_products').source).toBe('a.json#jd-search')
    expect(map.get('jd.com.search_products').safetyMode).toBe('read')
  })
})

describe('buildPatrolList', () => {
  const tools = [
    { tool: 'jd.com.search_products' },
    { tool: 'jd.com.view_cart' },
    { tool: 'jd.com.delete_item' },
    { tool: 'x.com.submit' },
  ]

  it('每条工具一行，标出样本与基线状态', () => {
    const rows = buildPatrolList({
      adapterId: 'jd.com',
      tools: tools.slice(0, 3),
      samples: indexSamples([['a.json', caseManifest]]),
      baseline: { tools: { 'jd.com.search_products': { shape: { a: 'string' } } } },
    })
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ tool: 'jd.com.search_products', hasSample: true, hasBaseline: true })
    expect(rows[1]).toMatchObject({ tool: 'jd.com.view_cart', hasSample: false, hasBaseline: false, skipReason: 'needs-sample' })
  })

  it('有安全跑法的写命令可执行；safetyMode=none 的写命令跳过', () => {
    const rows = buildPatrolList({
      adapterId: 'x.com',
      tools: [{ tool: 'x.com.submit' }],
      samples: indexSamples([['a.json', caseManifest]]),
      baseline: null,
    })
    expect(rows[0].skipReason).toBe('unsafe-write')
  })
})
