import { describe, it, expect, afterAll } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync, writeFileSync } from 'node:fs'
import { loadKnowledge, recordExperience, searchExperience, injectContext, entryKey, KNOWLEDGE_LIMIT, pickPlaybooks, repairStats } from '../repair/knowledge.js'

// mkdtemp 临时根统一登记,afterAll 一次性清理(与 repair-verify.test.js 同惯例)
const roots = []
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function tmpFile(name = 'knowledge.json') {
  const root = await mkdtemp(join(tmpdir(), 'repair-knowledge-'))
  roots.push(root)
  return join(root, name)
}

const ENTRY = { site: 'wekm', runtime: 'wewright', symptom: 'exited with code 1: TypeError title', rootCause: 'SSO 过期后 fetch 返回登录页', fixStrategy: '先探登录态,失效返回 needs-login 引导', outcome: 'fixed' }

describe('recordExperience', () => {
  it('新增 + 同 pattern 去重合并(hits+1)', async () => {
    const f = await tmpFile()
    recordExperience(f, ENTRY, '2026-11-23T00:00:00Z')
    recordExperience(f, ENTRY, '2026-11-24T00:00:00Z')
    const { entries } = loadKnowledge(f)
    expect(entries).toHaveLength(1)
    expect(entries[0].hits).toBe(2)
  })
  it('超限淘汰 LRU(date 主键):新条目不被裁,裁的是 date 最旧', async () => {
    const f = await tmpFile()
    for (let i = 0; i < KNOWLEDGE_LIMIT; i++) recordExperience(f, { ...ENTRY, symptom: `old-${i}` }, new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString())
    recordExperience(f, { ...ENTRY, symptom: 'fresh-latest' }, '2026-12-01T00:00:00Z') // 新经验 hits=1,date 最新
    const { entries } = loadKnowledge(f)
    expect(entries.length).toBe(KNOWLEDGE_LIMIT)
    expect(entries.some((e) => e.symptom === 'fresh-latest')).toBe(true)
    expect(entries.some((e) => e.symptom === 'old-00')).toBe(false)
  })
  it('failed 合并不抹已知修法(保留 fixStrategy/rootCause/outcome,记 lastOutcome)', async () => {
    const f = await tmpFile()
    recordExperience(f, ENTRY, '2026-11-23T00:00:00Z')
    recordExperience(f, { ...ENTRY, outcome: 'failed', rootCause: '', fixStrategy: '' }, '2026-11-24T00:00:00Z')
    const { entries } = loadKnowledge(f)
    expect(entries).toHaveLength(1)
    expect(entries[0].fixStrategy).toBe(ENTRY.fixStrategy)
    expect(entries[0].rootCause).toBe(ENTRY.rootCause)
    expect(entries[0].outcome).toBe('fixed')
    expect(entries[0].lastOutcome).toBe('failed')
    expect(entries[0].hits).toBe(2)
  })
  it('entryKey 吃截断后字段:同前缀不同后缀 → 同 key', () => {
    const long = 'x'.repeat(500)
    expect(entryKey({ site: 'a', runtime: 'b', symptom: long + 'tail' })).toBe(entryKey({ site: 'a', runtime: 'b', symptom: long }))
  })
  it('损坏文件备份重建,不抛错', async () => {
    const f = await tmpFile()
    writeFileSync(f, '{broken')
    expect(loadKnowledge(f).entries).toEqual([])
  })
})

describe('searchExperience', () => {
  it('site 精确匹配权重最高;无命中返回空', async () => {
    const f = await tmpFile()
    recordExperience(f, ENTRY)
    recordExperience(f, { ...ENTRY, site: 'other', symptom: 'exited with code 1: TypeError title' })
    const hits = searchExperience(f, { site: 'wekm', runtime: 'wewright', errSignature: 'TypeError title' }, 3)
    expect(hits[0].site).toBe('wekm')
    expect(hits).toHaveLength(2)
  })
})

describe('injectContext', () => {
  it('有条目输出格式化块;空库输出提示', () => {
    expect(injectContext([])).toContain('暂无相关条目')
    const text = injectContext([{ site: 'wekm', runtime: 'wewright', symptom: 's', rootCause: 'r', fixStrategy: 'f', outcome: 'fixed', hits: 2 }])
    expect(text).toContain('[wekm/wewright]')
    expect(text).toContain('策略: f')
    expect(text).toContain('出现 2 次')
  })
})

describe('playbook', () => {
  const PB = { detect: '页面 URL 含 /login 即登录态失效', detectSnippet: "if ('/login' in page.url) return NEEDS_LOGIN", fixTemplate: 'goto 后先探登录重定向,失效返回 {ok:false, code:NEEDS_LOGIN, needs_user:true}' }
  it('recordExperience 存 playbook;merge failed 时 playbook 保留', () => {
    const f = join(tmpdir(), `rk-pb-${Math.random().toString(36).slice(2)}.json`)
    recordExperience(f, { ...ENTRY, rootCause: 'login-expired', playbook: PB }, '2026-11-26T00:00:00Z')
    recordExperience(f, { ...ENTRY, rootCause: 'login-expired', outcome: 'failed' }, '2026-11-26T01:00:00Z')
    const { entries } = loadKnowledge(f)
    expect(entries[0].playbook.detectSnippet).toBe(PB.detectSnippet)
  })
  it('pickPlaybooks 按 rootCause 过滤', () => {
    const f = join(tmpdir(), `rk-pb2-${Math.random().toString(36).slice(2)}.json`)
    recordExperience(f, { ...ENTRY, rootCause: 'login-expired', playbook: PB })
    recordExperience(f, { ...ENTRY, site: 'other', symptom: 's2', rootCause: 'logic-bug' })
    const hits = pickPlaybooks(loadKnowledge(f).entries, 'login-expired')
    expect(hits).toHaveLength(1)
    expect(hits[0].playbook.fixTemplate).toContain('NEEDS_LOGIN')
  })
  it('injectContext 渲染 playbook 块与 failed 警示', () => {
    const text = injectContext([{ site: 'wekm', runtime: 'wewright', symptom: 's', rootCause: 'r', fixStrategy: 'f', outcome: 'fixed', hits: 1, lastOutcome: 'failed', playbook: PB }])
    expect(text).toContain('检测片段')
    expect(text).toContain('修复模板')
    expect(text).toContain('最近一次复现失败')
  })
  it('meta(rounds/llmCalls/usedPlaybook)随条目存储', () => {
    const f = join(tmpdir(), `rk-meta-${Math.random().toString(36).slice(2)}.json`)
    recordExperience(f, { ...ENTRY }, '2026-11-26T00:00:00Z', { rounds: 2, llmCalls: 2, durationMs: 45000, usedPlaybook: false })
    expect(loadKnowledge(f).entries[0].meta).toEqual({ rounds: 2, llmCalls: 2, durationMs: 45000, usedPlaybook: false })
  })
  it('fixed 合并 incoming 无 meta → 旧 meta 保留(与 playbook 同规则)', () => {
    const f = join(tmpdir(), `rk-merge-${Math.random().toString(36).slice(2)}.json`)
    recordExperience(f, { ...ENTRY }, '2026-11-26T00:00:00Z', { rounds: 1, llmCalls: 1, durationMs: 1000, usedPlaybook: true })
    recordExperience(f, { ...ENTRY }, '2026-11-26T01:00:00Z')
    const { entries } = loadKnowledge(f)
    expect(entries).toHaveLength(1)
    expect(entries[0].hits).toBe(2)
    expect(entries[0].meta).toEqual({ rounds: 1, llmCalls: 1, durationMs: 1000, usedPlaybook: true })
  })
})

describe('repairStats', () => {
  it('首轮成功率/平均轮数/playbook 命中率聚合(比率分母 = 带 meta 条目,无 meta 只计 total/fixed)', () => {
    const entries = [
      { outcome: 'fixed', meta: { rounds: 1, usedPlaybook: true } },
      { outcome: 'fixed', meta: { rounds: 2, usedPlaybook: false } },
      { outcome: 'fixed', meta: { rounds: 1, usedPlaybook: true } },
      { outcome: 'failed', meta: { rounds: 3, usedPlaybook: false } },
      { outcome: 'fixed' }, // 无 meta 不计入比率
    ]
    const s = repairStats(entries)
    expect(s.total).toBe(5)
    expect(s.fixed).toBe(4)
    expect(s.firstRoundSuccessRate).toBe(50)   // rounds===1 共 2 条 / 带 meta 4 条
    expect(s.avgRounds).toBe(1.8)              // (1+2+1+3)/4 = 1.75 → toFixed(1)
    expect(s.playbookHitRate).toBe(50)         // usedPlaybook 共 2 条 / 带 meta 4 条
  })
  it('空库全零', () => {
    expect(repairStats([])).toEqual({ total: 0, fixed: 0, firstRoundSuccessRate: 0, avgRounds: 0, playbookHitRate: 0 })
  })
})
