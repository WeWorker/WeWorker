import { describe, expect, it } from 'vitest'
import { diffShape, extractShape } from '../patrol/shape.js'

describe('extractShape', () => {
  it('提取标量字段的类型', () => {
    expect(extractShape({ title: 'a', price: 12 })).toEqual({ title: 'string', price: 'number' })
  })

  it('嵌套对象用点号路径', () => {
    expect(extractShape({ a: { b: 'x' } })).toEqual({ a: 'object', 'a.b': 'string' })
  })

  it('数组取首元素形状，路径用 [] 标记', () => {
    const shape = extractShape({ items: [{ id: 1, name: 'x' }] })
    expect(shape['items']).toBe('array')
    expect(shape['items[].id']).toBe('number')
    expect(shape['items[].name']).toBe('string')
  })

  it('空数组记为 empty-array（内容信号，不是结构）', () => {
    expect(extractShape({ items: [] })['items[]']).toBe('empty-array')
  })

  it('null 单独记类型', () => {
    expect(extractShape({ x: null }).x).toBe('null')
  })

  it('忽略数组里的 null 元素，取首个非空元素', () => {
    const shape = extractShape({ items: [null, { id: 1 }] })
    expect(shape['items[].id']).toBe('number')
  })

  it('超过最大深度即停（防爆栈）', () => {
    let deep = { v: 'leaf' }
    for (let i = 0; i < 12; i += 1) deep = { child: deep }
    expect(Object.keys(extractShape(deep)).length).toBeLessThan(10)
  })
})

describe('diffShape', () => {
  const base = { a: 'string', 'b.c': 'number', 'items[].id': 'number' }

  it('字段缺失算退化', () => {
    const r = diffShape(base, { a: 'string', 'items[].id': 'number' })
    expect(r.degraded).toBe(true)
    expect(r.missing).toEqual([{ path: 'b.c', baselineType: 'number' }])
  })

  it('类型变化算退化', () => {
    const r = diffShape(base, { a: 'number', 'b.c': 'number', 'items[].id': 'number' })
    expect(r.degraded).toBe(true)
    expect(r.typeChanged).toEqual([{ path: 'a', baselineType: 'string', currentType: 'number' }])
  })

  it('新增字段不算退化，只记 added', () => {
    const r = diffShape(base, { ...base, extra: 'boolean' })
    expect(r.degraded).toBe(false)
    expect(r.added).toEqual(['extra'])
  })

  it('数组变空不算结构退化，交给内容层', () => {
    const r = diffShape(base, { a: 'string', 'b.c': 'number', 'items[]': 'empty-array' })
    expect(r.degraded).toBe(false)
    expect(r.emptied).toEqual(['items'])
  })

  it('完全一致时无退化无新增', () => {
    const r = diffShape(base, base)
    expect(r).toMatchObject({ degraded: false, missing: [], typeChanged: [], added: [], emptied: [] })
  })
})
