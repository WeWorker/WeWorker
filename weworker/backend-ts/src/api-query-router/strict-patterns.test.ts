import { describe, expect, it } from 'vitest'
import { buildPatternMatcher } from './patterns.js'
import { buildRouteMatcher } from './routes-layer.js'
import { validatePatternsFile } from '../router-config/validate.js'
import type { PatternsFile } from '../router-config/types.js'

describe('public route precision', () => {
  it('matches routes aliases and keywords only as complete normalized messages', () => {
    const match = buildRouteMatcher([{ id: 'read', tool: 'example.read', match: { aliases: ['列 出 项'], keywords: ['查询数据'] } }])
    expect(match('列出项')?.tool).toBe('example.read')
    expect(match('查 询 数 据')?.tool).toBe('example.read')
    expect(match('请查询数据')).toBeNull()
    expect(match('查询数据后删除')).toBeNull()
  })

  it('enumerates ordinary regex examples rather than accepting arbitrary regex substrings', () => {
    const match = buildPatternMatcher({ configs: { 'example.read': { patterns: [{ type: 'regex', expression: '查询', examples: ['查询样例'] }] } } })
    expect(match('查询样例')?.tool).toBe('example.read')
    expect(match('查询其他内容')).toBeNull()
    expect(match('请查询样例')).toBeNull()
  })

  it('anchors template, extracts slot through arg metadata and keeps unit outside capture', () => {
    const config: PatternsFile = { configs: { 'example.read': {
      priority: 5,
      default_args: { page: 1, maxDays: 2 },
      negative_patterns: ['删除'],
      arg_extractors: [{ arg: 'maxDays', regex: '近(\\d+)天', type: 'integer', min: 1, max: 30 }],
      patterns: [{ type: 'template', expression: '查看近${maxDays}天记录', examples: ['查看近7天记录'] }],
    } } }
    const match = buildPatternMatcher(config)
    expect(match('查 看 近 7 天 记 录')?.args).toEqual({ page: 1, maxDays: 7 })
    expect(match('查看近90天记录')?.args).toEqual({ page: 1, maxDays: 30 })
    expect(match('查看近天记录')).toBeNull()
    expect(match('查看近7个记录')).toBeNull()
    expect(match('请查看近7天记录')).toBeNull()
    expect(match('查看近7天记录删除')).toBeNull()
    expect(match('查看近abc天记录')).toBeNull()
    expect(validatePatternsFile(config)).toEqual([])
  })

  it('preserves spaces inside a text slot while anchoring all literal text', () => {
    const match = buildPatternMatcher({ configs: { 'example.search': { patterns: [
      { type: 'template', expression: '搜索${query}第${page}页', examples: ['搜索quantum mechanics第2页'] },
    ], arg_extractors: [{ arg: 'page', regex: '(\\d+)', type: 'integer' }] } } })
    expect(match('搜索quantum mechanics第2页')?.args).toEqual({ query: 'quantum mechanics', page: 2 })
    expect(match('搜索quantum mechanics第2楼')).toBeNull()
    expect(match('搜索quantum mechanics页第2页')).toBeNull()
  })

  it('rejects overlong IDs and invalid username tails instead of truncating', () => {
    const match = buildPatternMatcher({ configs: {
      'example.id': { patterns: [{ type: 'template', expression: 'hn 帖子 ${id}', slot_validators: { id: '\\d{1,9}' }, examples: ['hn 帖子 123456'] }],
        arg_extractors: [{ arg: 'id', regex: '(\\d{1,9})', type: 'integer' }] },
      'example.user': { patterns: [{ type: 'template', expression: 'hn user ${username}', slot_validators: { username: '[A-Za-z0-9_-]{1,30}' }, examples: ['hn user user_name'] }],
        arg_extractors: [{ arg: 'username', regex: '([A-Za-z0-9_-]{1,30})', type: 'string' }] },
    } })
    expect(match('hn 帖子 123456')?.args).toEqual({ id: 123456 })
    expect(match('hn 帖子 1234567890')).toBeNull()
    expect(match('hn user user_name')?.args).toEqual({ username: 'user_name' })
    expect(match('hn user user_name!')).toBeNull()
  })

  it('supports templated regex legacy syntax while refusing missing or ambiguous slots', () => {
    const match = buildPatternMatcher({ configs: { 'example.read': { patterns: [
      { type: 'regex', expression: '列出${count}条', examples: ['列出2条'] },
    ], arg_extractors: [{ arg: 'count', regex: '(\\d+)', type: 'integer' }] } } })
    expect(match('列出2条')?.args).toEqual({ count: 2 })
    expect(match('列出2页')).toBeNull()
    expect(match('列出条')).toBeNull()
    expect(match('列出2条并修改')).toBeNull()
  })
})
