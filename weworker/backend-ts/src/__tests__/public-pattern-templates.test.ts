import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildPatternMatcher } from '../api-query-router/patterns.js'
import { parseJsonc } from '../router-config/jsonc.js'
import type { PatternsFile } from '../router-config/types.js'

const grouped = parseJsonc(readFileSync(new URL('../../../router-config/patterns.json', import.meta.url), 'utf8')) as PatternsFile
const config: PatternsFile = {
  ...grouped,
  configs: Object.fromEntries(Object.values(grouped.configs ?? {}).flatMap((section) =>
    Object.entries(section as Record<string, NonNullable<PatternsFile['configs']>[string]>))),
}
const match = buildPatternMatcher(config)

const successes = [
  ['维基百科搜索 量子力学', 'wikipedia.org.search', { query: '量子力学', lang: 'zh', limit: 10 }],
  ['维基百科 搜一下 图灵机', 'wikipedia.org.search', { query: '图灵机', lang: 'zh', limit: 10 }],
  ['wikipedia search for quantum mechanics', 'wikipedia.org.search', { query: 'quantum mechanics', lang: 'en', limit: 10 }],
  ['wiki 搜索 rust', 'wikipedia.org.search', { query: 'rust', lang: 'en', limit: 10 }],
  ['维基百科词条 量子力学', 'wikipedia.org.summary', { title: '量子力学', lang: 'zh' }],
  ['维基百科条目：图灵机', 'wikipedia.org.summary', { title: '图灵机', lang: 'zh' }],
  ['wiki summary rust', 'wikipedia.org.summary', { title: 'rust', lang: 'en' }],
  ['微信读书搜索 人类简史', 'weread.qq.com.search', { query: '人类简史', limit: 20 }],
  ['微信读书 搜一下 三体', 'weread.qq.com.search', { query: '三体', limit: 20 }],
  ['weread search for atomic habits', 'weread.qq.com.search', { query: 'atomic habits', limit: 20 }],
  ['hacker news search for rust', 'news.ycombinator.com.search', { query: 'rust', limit: 20, sort: 'relevance' }],
  ['hn 搜一下 playwright', 'news.ycombinator.com.search', { query: 'playwright', limit: 20, sort: 'relevance' }],
  ['hacker news 用户 pg', 'news.ycombinator.com.user', { username: 'pg' }],
  ['hn user dang', 'news.ycombinator.com.user', { username: 'dang' }],
  ['hacker news 帖子 123456', 'news.ycombinator.com.read', { id: 123456, limit: 20 }],
  ['hn item 40000000', 'news.ycombinator.com.read', { id: 40000000, limit: 20 }],
  ['hn 帖子 123456', 'news.ycombinator.com.read', { id: 123456, limit: 20 }],
] as const

const rejects = [
  '请维基百科搜索 量子力学', '维基百科搜索引擎', '维基百科搜索功能怎么用',
  '维基百科搜索 ', '维基百科搜索：量子力学',
  '维基百科 搜一下：图灵机', '维基百科条目：图灵机有哪些',
  '微信读书《三体》里搜索 黑暗森林',
  'hacker news 用户 pg 的资料', 'hn user dang 的主页',
  'hacker news 帖子 123456 的评论', 'hn item 40000000 回复',
  'hn 帖子 abc', 'hn 用户 pg',
]

describe('公开 patterns 字面全句模板', () => {
  it('每条启用规则有精确字面模板及完整正例覆盖', () => {
    const rules = Object.values(config.configs ?? {}).flatMap((entry) => entry.patterns ?? [])
    expect(rules).toHaveLength(successes.length)
    for (const rule of rules) {
      expect(rule.type).toBe('template')
      expect(rule.expression).toMatch(/\$\{(?:query|title|username|id)\}/)
      expect(rule.examples?.length).toBeGreaterThan(0)
      for (const example of rule.examples ?? []) {
        expect(successes.some(([text]) => text === example)).toBe(true)
      }
    }
  })

  it.each(successes)('%s → %s 且正确抽参', (text, tool, args) => {
    expect(match(text)).toMatchObject({ tool, args, extractedArgs: Object.fromEntries(
      Object.entries(args).filter(([key]) => !['lang', 'limit', 'sort'].includes(key)),
    ) })
  })

  it.each(rejects)('拒绝非精确全句或非法槽值：%s', (text) => {
    expect(match(text)).toBeNull()
  })
})
