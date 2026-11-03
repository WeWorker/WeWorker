import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { expandAdapterGroupedField } from '../router-config/adapter-grouped.js'
import { validateShortcutsFile } from '../router-config/validate.js'
import { buildShortcutMatcher } from '../api-query-router/shortcuts.js'
import type { ShortcutEntry } from '../router-config/types.js'

const configPath = path.resolve(process.cwd(), '../router-config/shortcuts.json')
const rawText = fs.readFileSync(configPath, 'utf8')
// The public config is JSONC: remove only comments, not escaped regex contents.
const raw = JSON.parse(rawText.replace(/^\s*\/\*[\s\S]*?\*\//, ''))
const expanded = expandAdapterGroupedField(raw, 'shortcuts')
const entries = (expanded.raw as { shortcuts: ShortcutEntry[] }).shortcuts
const match = buildShortcutMatcher(entries)

describe('public shortcuts: exact utterances and bounded slots', () => {
  it('validates the public adapter-grouped config', () => {
    expect(expanded.errors).toEqual([])
    expect(validateShortcutsFile(expanded.raw)).toEqual([])
  })

  it.each([
    ['v2ex 热门', 'v2ex-hot', { limit: 20 }],
    ['v2ex 最新', 'v2ex-latest', { limit: 20 }],
    ['v2ex nodes', 'v2ex-nodes', { limit: 50 }],
    ['github trending', 'github-trending', { since: 'daily', limit: 25 }],
    ['v2ex 主题 12345', 'v2ex-topic', { id: 12345 }],
    ['v2ex 987', 'v2ex-topic', { id: 987 }],
    ['v2ex:987', 'v2ex-topic', { id: 987 }],
    ['v2ex#987', 'v2ex-topic', { id: 987 }],
    ['v2ex/987', 'v2ex-topic', { id: 987 }],
    ['v2ex 主题:12345', 'v2ex-topic', { id: 12345 }],
    ['v2ex 用户 example_user', 'v2ex-member', { username: 'example_user' }],
    ['v2ex 节点 python', 'v2ex-node', { name: 'python', limit: 20 }],
    ['arxiv 搜索 transformer', 'arxiv-search', { query: 'transformer', limit: 20 }],
    ['帮我在 arxiv 上搜索 RAG 相关论文', 'arxiv-search', { query: 'RAG', limit: 20 }],
    ['arxiv 2401.12345', 'arxiv-paper', { id: '2401.12345' }],
  ] as const)('accepts only complete allowed phrase: %s', (utterance, id, args) => {
    expect(match(utterance)).toMatchObject({ id, args })
  })

  it.each([
    '给我看看 v2ex 热门', 'v2ex 热门有哪些', 'v2ex 最新版本是哪一版',
    'github 上有什么热门仓库', 'github trending 今天', 'github 热门项目哪个',
    'v2ex 节点 python 列表', 'v2ex 用户 example_user 功能',
    'v2ex 节点 python!!', 'v2ex 节点 ' + 'a'.repeat(31),
    'v2ex12345', 'v2ex主题12345', 'v2ex主题 12345', 'v2ex 主题12345',
    'v2ex 主题 0', 'v2ex 主题 1000000000', 'v2ex 主题 12345 再分析',
    'arxiv 搜索', 'arxiv 搜索 transformer？', 'arxiv 搜索 transformer 然后查别的',
    'arxiv 搜索 transformer and summarize', 'arxiv 搜索 transformer 的实现',
    'arxiv 搜索 transformer 搜索另一个', 'arxiv 搜索 ' + 'a'.repeat(81),
    'arxiv 2401.12345 再总结', 'arxiv 2401.12345v9999',
  ])('rejects ambiguous or out-of-bound utterance: %s', (utterance) => {
    expect(match(utterance)).toBeNull()
  })

  it('fails closed on missing captures, invalid extractors and numeric bounds', () => {
    const spec: ShortcutEntry = {
      id: 'test', tool: 'example.com.read',
      patterns: { positive: ['^example\\s+\\d+$'] },
      extract: [{ regex: '^example\\s+(\\d+)$', arg: 'id', type: 'integer', min: 1, max: 10 }],
    }
    expect(buildShortcutMatcher([spec])('example 11')).toBeNull()
    expect(buildShortcutMatcher([spec])('example 10')?.args).toEqual({ id: 10 })
    expect(buildShortcutMatcher([{ ...spec, extract: [{ regex: '^different (\\d+)$', arg: 'id' }] }])('example 10')).toBeNull()
    expect(buildShortcutMatcher([{ ...spec, extract: [{ regex: '^example\\s+\\d+$', arg: 'id' }] }])('example 10')).toBeNull()
    expect(buildShortcutMatcher([{ ...spec, patterns: { positive: ['example'] } }])('example 10')).toBeNull()
  })
})
