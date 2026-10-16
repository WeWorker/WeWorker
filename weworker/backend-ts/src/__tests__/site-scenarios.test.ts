import { describe, it, expect } from 'vitest'
import { resolveSiteScenarios } from '../site-scenarios.js'
import type { ParsedAdapter } from '../adapter-parser.js'

const mockAdapter = (overrides: Partial<ParsedAdapter> = {}): ParsedAdapter => ({
  id: 'expense.example.com',
  name: 'ExpenseDemo费用管理示例',
  description: 'ExpenseDemo费用管理示例：团建预算提单，团建报销',
  detailDescription: 'ExpenseDemo detail description',
  match: ['expense.example.com'],
  gateAliases: [],
  homepageUrl: 'https://expense.example.com/',
  tools: [
    { name: 'expense.example.com.navigate_to_budget_request', description: 'nav', parameters: {} },
    { name: 'expense.example.com.fill_budget_request', description: 'fill', parameters: {} },
  ],
  testPrompts: [],
  requiresAuth: true,
  authCheckTool: null,
  hidden: false,
  defaultEnabled: true,
  registryScenarios: [],
  icon: 'globe',
  promptVarDisplay: {},
  ...overrides,
})

describe('resolveSiteScenarios', () => {
  it('uses registry scenarios when provided', () => {
    const scenarios = resolveSiteScenarios(mockAdapter(), [
      {
        id: 'team-budget',
        title: '团建预算提单',
        summary: '填写预算',
        prompts: [
          {
            text: '帮我提团建预算',
            reply: '我会先确认页面状态，再继续执行。',
          },
        ],
      },
    ])
    expect(scenarios).toHaveLength(1)
    expect(scenarios[0].source).toBe('registry')
    expect(scenarios[0].title).toBe('团建预算提单')
    expect(scenarios[0].prompts[0].text).toContain('团建')
  })

  it('resolves reply previews from scenario prompts', () => {
    const scenarios = resolveSiteScenarios(mockAdapter(), [
      {
        id: 'team-budget',
        title: '团建预算提单',
        summary: '填写预算',
        prompts: [{ text: '帮我提团建预算', reply: '我会先确认页面状态，再继续执行。' }],
      },
    ])
    expect(scenarios[0].prompts[0].reply).toBe('我会先确认页面状态，再继续执行。')
  })

  it('falls back when registry scenarios empty', () => {
    const scenarios = resolveSiteScenarios(mockAdapter(), undefined)
    expect(scenarios.length).toBeGreaterThan(0)
    expect(scenarios[0].source).toBe('fallback')
  })
})
