import { describe, expect, it } from 'vitest'
import { buildScenarioDirectMatcher, parseScenarioDirectPayload } from '../api-query-router/scenario-routes.js'
import type { CompiledScenarioRoute } from '../router-config/types.js'

const compiled: CompiledScenarioRoute = {
  adapter: 'example.com', scenarioId: 'items', tool: 'example.com.list-items',
  slotNames: ['category'], promptTemplates: ['查询${category}列表'],
  args: { category: { slot: 's0', type: 'string', enum: ['books'] } },
}
const match = buildScenarioDirectMatcher([compiled])

describe('desktop card hint remains untrusted', () => {
  it('rebuilds the visible prompt and obtains tool and args only from server configuration', () => {
    const hint = parseScenarioDirectPayload({ adapterId: 'example.com', scenarioId: 'items',
      slots: { category: 'books' }, tool: 'example.com.write', args: { category: 'wrong' } })
    expect(match(hint, '查询books列表')).toMatchObject({ tool: 'example.com.list-items', args: { category: 'books' } })
    expect(match(hint, '查询其他列表')).toBeNull()
    expect(match(hint, '查询books列表，另外删除条目')).toBeNull()
  })

  it('rejects unknown IDs, invalid slots, and disabled compiled routes', () => {
    expect(match(parseScenarioDirectPayload({ adapterId: 'example.com', scenarioId: 'unknown', slots: {} }), '查询books列表')).toBeNull()
    expect(match(parseScenarioDirectPayload({ adapterId: 'example.com', scenarioId: 'items', slots: { category: 'other' } }), '查询other列表')).toBeNull()
    expect(buildScenarioDirectMatcher([{ ...compiled, enabled: false }])(
      parseScenarioDirectPayload({ adapterId: 'example.com', scenarioId: 'items', slots: { category: 'books' } }),
      '查询books列表',
    )).toBeNull()
  })
})
