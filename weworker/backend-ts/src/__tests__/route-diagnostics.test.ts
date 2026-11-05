import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configureWorkLogs } from '../work-log-file.js'
import { executeRoutePlan, tryIntelligentQueryRoute, type RouteEngine } from '../api-query-router/index.js'
import type { CascadePlan } from '../api-query-router/cascade.js'

const tool = 'example.com.read'
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'route-diagnostic-test-'))
const events = (): Array<{ type: string; data: Record<string, unknown> }> =>
  fs.readFileSync(path.join(temp, 'example-work.log'), 'utf8').split('\n').filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line) as { type: string; data: Record<string, unknown> }).filter(event => event.type === 'route_diagnostic')
const context = () => ({ message: 'private request secret-message', workId: 'example-work', turnId: 'turn-1', chatStartTime: Date.now(), send: vi.fn(), log: vi.fn() })
const plan: CascadePlan = { suppressed: [], steps: [
  { layer: 'pattern', decision: { kind: 'tool', tool, args: { token: 'private-token', limit: 10 }, source: 'pattern', render: {}, label: 'pattern' }, onFailure: { action: 'continue' } },
] }
const engine = { routableTools: new Set([tool]), bundle: {}, plans: [], signature: 'example-signature' } as unknown as RouteEngine

configureWorkLogs(temp)
afterEach(() => {
  fs.rmSync(path.join(temp, 'example-work.log'), { force: true })
})

describe('route diagnostic events', () => {
  it('records selected rule, request shape, response shape and successful rendering without payloads', async () => {
    const ctx = context()
    expect(await executeRoutePlan(plan, ctx, { engine, dispatch: async () => '{"items":[{"secret":"private-response"}]}', persistAssistantMessage: vi.fn() })).toBe(true)
    expect(events().map(event => event.data.phase)).toEqual(['candidate_selected', 'dispatch_start', 'dispatch_result', 'render_succeeded', 'candidate_outcome'])
    expect(events().find(event => event.data.phase === 'dispatch_result')?.data).toMatchObject({ type: 'object', arrayCounts: [1] })
    expect(JSON.stringify(events())).not.toMatch(/private-token|private-response|secret-message/)
  })

  it('explains dispatch failure, no answer, and LLM fallback without trying the next candidate', async () => {
    const ctx = context()
    const dispatch = vi.fn(async () => '{"ok":false,"error":"private-response"}')
    expect(await executeRoutePlan(plan, ctx, { engine, dispatch })).toBe(false)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(events().find(event => event.data.phase === 'dispatch_failed')?.data).toMatchObject({ category: 'error_payload', fallback: 'llm' })
    expect(JSON.stringify(events())).not.toContain('private-response')
  })

  it('records a non-matching route and fallback with the active engine fingerprint', async () => {
    const ctx = context()
    const emptyEngine = {
      ...engine,
      matchers: {
        route: () => null, pattern: () => null, plan: () => null, alias: () => null, shortcut: () => null, template: () => null,
        scenario: { match: () => null, matchDirect: () => null, matchPlan: () => null, matchPlanDirect: () => null, matchOptOut: () => null },
      },
    } as unknown as RouteEngine
    expect(await tryIntelligentQueryRoute(ctx, { engine: emptyEngine })).toBe(false)
    expect(events().map(event => event.data.phase)).toEqual(['route_config', 'route_plan', 'route_unmatched'])
    expect(events().at(-1)?.data).toMatchObject({ reason: 'no_eligible_candidate', fallback: 'llm' })
  })
})
