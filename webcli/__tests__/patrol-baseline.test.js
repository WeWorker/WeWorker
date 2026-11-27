import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildBaseline, baselinePath, diffBaselinePlan, loadBaseline, saveBaseline } from '../patrol/baseline.js'

const roots = []
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'patrol-'))
  roots.push(dir)
  return dir
}

afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }) })

describe('buildBaseline', () => {
  it('从首跑结果生成基线条目，记录 requiredNonEmpty', () => {
    const entry = buildBaseline({
      tool: 'jd.com.search_products',
      parsed: { items: [{ id: 1, name: 'x' }], total: 3 },
      sampleSource: 'a.json#jd-search',
      updatedAt: '2026-10-13',
      updatedBy: 'tester',
    })
    expect(entry.source).toBe('first-run')
    expect(entry.sampleSource).toBe('a.json#jd-search')
    expect(entry.shape['items[].id']).toBe('number')
    expect(entry.requiredNonEmpty).toContain('items')
  })

  it('有 verificationFixture 时优先用它推导 shape', () => {
    const entry = buildBaseline({
      tool: 'a.com.list',
      parsed: null,
      sampleSource: 'verification-fixture#a.com.list',
      updatedAt: '2026-10-13',
      updatedBy: 'tester',
      fixture: {
        requiredPaths: ['data.list'],
        types: { data: 'object', 'data.list': 'array', 'data.list[].id': 'number' },
        notEmpty: ['data.list'],
      },
    })
    expect(entry.source).toBe('verificationFixture')
    expect(entry.shape).toEqual({ data: 'object', 'data.list': 'array', 'data.list[].id': 'number' })
    expect(entry.requiredNonEmpty).toEqual(['data.list'])
    expect(entry.sampleSource).toBe('verification-fixture#a.com.list')
  })
})

describe('saveBaseline / loadBaseline', () => {
  it('写入后可读回', () => {
    const root = tmp()
    saveBaseline(root, 'jd.com', { version: 1, adapterId: 'jd.com', tools: { t: { shape: { a: 'string' } } } })
    expect(loadBaseline(root, 'jd.com').tools.t.shape.a).toBe('string')
    expect(loadBaseline(root, 'absent.com')).toBeNull()
  })

  it('落盘内容不含业务值', () => {
    const root = tmp()
    saveBaseline(root, 'jd.com', { version: 1, adapterId: 'jd.com', tools: { t: { shape: { a: 'string' } } } })
    const text = readFileSync(baselinePath(root, 'jd.com'), 'utf8')
    expect(text).not.toContain('秘密')
  })
})

describe('diffBaselinePlan', () => {
  it('列出将要新增/变化的条目，供更新前预览', () => {
    const plan = diffBaselinePlan(
      { tools: { a: { shape: { x: 'string' } } } },
      { tools: { a: { shape: { x: 'number' } }, b: { shape: { y: 'string' } } } },
    )
    expect(plan.changed).toEqual(['a'])
    expect(plan.added).toEqual(['b'])
    expect(plan.removed).toEqual([])
  })
})
