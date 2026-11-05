import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildPlanMatcher } from './plan-dag.js'
import type { PlanEntry } from '../router-config/types.js'

const PUBLIC_PLANS = fileURLToPath(new URL('../../../router-config/plans.json', import.meta.url))

function loadPlans(file: string): PlanEntry[] {
  const source = readFileSync(file, 'utf8').replace(/^\/\*[\s\S]*?\*\/\s*/, '').replace(/^\s*\/\/.*$/gm, '')
  const grouped = JSON.parse(source).plans as Record<string, PlanEntry[]>
  return Object.values(grouped).flat()
}

describe('plan entry precision', () => {
  it('public plan examples preserve their captured input', () => {
    const plans = loadPlans(PUBLIC_PLANS)
    const matcher = buildPlanMatcher(plans)
    for (const plan of plans) {
      for (const example of plan.examples ?? []) {
        const hit = matcher.match(example)
        expect(hit?.plan.id, example).toBe(plan.id)
        expect(hit?.matched, example).toBe(example)
        expect(Object.values(hit?.input ?? {}).every((value) => typeof value === 'string' && value.trim().length > 0), example).toBe(true)
      }
    }
  })

  it('does not accept substring regexes or zero-width capture-only lookaheads', () => {
    const plan = loadPlans(PUBLIC_PLANS)[0]
    expect(buildPlanMatcher([{ ...plan, entry: { ...plan.entry, positive: ['(?<topic>量子力学)'] } }]).match('维基百科 量子力学')).toBeNull()
    expect(buildPlanMatcher([{ ...plan, entry: { ...plan.entry, positive: ['(?=(?<topic>量子力学))'] } }]).match('量子力学')).toBeNull()
  })

  it('rejects extra clauses while retaining book, query and topic slots', () => {
    const matcher = buildPlanMatcher(loadPlans(PUBLIC_PLANS))
    expect(matcher.match('维基百科 量子力学')?.input).toEqual({ topic: '量子力学' })
    expect(matcher.match('微信读书《三体》里搜索 黑暗森林')?.input).toEqual({ book: '三体', query: '黑暗森林' })
    for (const message of [
      '维基百科 量子力学，然后删除记录',
      '维基百科 量子力学，顺便看热榜',
      '维基百科 量子力学并修改词条',
      '微信读书《三体》里搜索 黑暗森林，然后删除记录',
      '微信读书《三体》里搜索 黑暗森林。再查询其他内容',
      '微信读书《三体》里搜索 黑暗森林，顺便查别的书',
      '维基百科 人工智能',
      '微信读书《别的书》里搜索 黑暗森林',
      '微信读书《三体》里搜索 另一条线索',
    ]) expect(matcher.match(message), message).toBeNull()
  })
})
