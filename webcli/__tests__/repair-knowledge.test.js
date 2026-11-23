import { describe, it, expect, afterAll } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync, writeFileSync } from 'node:fs'
import { loadKnowledge, recordExperience, searchExperience, injectContext, KNOWLEDGE_LIMIT } from '../repair/knowledge.js'

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
  it('超限淘汰最旧(保留 LIMIT 条)', async () => {
    const f = await tmpFile()
    for (let i = 0; i < KNOWLEDGE_LIMIT + 5; i++) recordExperience(f, { ...ENTRY, symptom: `symptom-${i}` })
    expect(loadKnowledge(f).entries.length).toBe(KNOWLEDGE_LIMIT)
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
  })
})
