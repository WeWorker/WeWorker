import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runRepairLoop } from '../repair/executor.js'
import { buildTask } from '../repair/task.js'

const FIXED_PY = "import json\nprint(json.dumps({'ok': True}))\n"
let env, home

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'repair-exec-'))
  const adapterRoot = join(home, 'adapters', 'demo-fixture')
  await mkdir(join(adapterRoot, 'wewright', 'commands'), { recursive: true })
  await writeFile(join(adapterRoot, 'manifest.json'), JSON.stringify({
    schema_version: 2, name: 'demo-fixture', version: '1.0.0', description: 'd', runtime_allowed_hosts: ['demo.example.com'],
    commands: [{ id: 'get-article', runtime: 'wewright', module: 'wewright/commands/get-article.py', description: 'd', schema: { type: 'object' } }],
  }, null, 2))
  await writeFile(join(adapterRoot, 'wewright', 'commands', 'get-article.py'), 'raise TypeError("broken")\n')
  env = { WEWORKER_USER_ADAPTERS_DIR: join(home, 'adapters'), WEBCLI_ADAPTERS_DIR: join(home, 'adapters'), HOME: home }
})

const TASK = () => buildTask({ source: 'manual', adapterId: 'demo-fixture', failures: [{ tool: 'demo-fixture.get-article', count: 3, lastErr: 'x' }] })

describe('runRepairLoop', () => {
  it('诊断→补丁→验证通过 → draft-ready', async () => {
    const llm = { async diagnose() { return { rootCause: 'logic-bug', reasoning: 'r', patchedFiles: { 'wewright/commands/get-article.py': FIXED_PY } } } }
    const verifyImpl = async () => ({ passed: true, checks: [{ name: 'fake', passed: true }] })
    const { task, outcome, draft } = await runRepairLoop({ task: TASK(), llm, env, home, verifyImpl, log: () => {} })
    expect(outcome).toBe('draft-ready')
    expect(task.status).toBe('draft-ready')
    expect(draft.version).toBe('1.0.1')
  })
  it('needs-regeneration 提前终止', async () => {
    const llm = { async diagnose() { return { rootCause: 'needs-regeneration', reasoning: '站点改版' } } }
    const { task, outcome } = await runRepairLoop({ task: TASK(), llm, env, home, verifyImpl: async () => ({ passed: true, checks: [] }), log: () => {} })
    expect(outcome).toBe('needs-regeneration')
    expect(task.status).toBe('needs-regeneration')
  })
  it('3 轮仍失败 → archived(exhausted),验证抛错也计入轮次', async () => {
    let verifyThrows = true
    const llm = {
      async diagnose() { return { rootCause: 'logic-bug', patchedFiles: { 'wewright/commands/get-article.py': FIXED_PY } } },
      async revise() { verifyThrows = false; return { rootCause: 'logic-bug', patchedFiles: { 'wewright/commands/get-article.py': FIXED_PY } } },
    }
    // 计划原稿翻转后返回 passed:true 会让第 2 轮提前 draft-ready,与「3 轮仍失败」矛盾;
    // 修正为:第 1 轮验证抛错(计入轮次),第 2/3 轮验证未通过,3 轮耗尽 → archived。
    const verifyImpl = async () => { if (verifyThrows) throw new Error('unexpected draft corruption'); return { passed: false, checks: [{ name: 'fake', passed: false }] } }
    const { task, outcome } = await runRepairLoop({ task: TASK(), llm, env, home, verifyImpl, log: () => {} })
    expect(outcome).toBe('archived')
    expect(task.status).toBe('archived')
  })
  it('修复结果回写经验库(固定 home)', async () => {
    const llm = { async diagnose() { return { rootCause: 'logic-bug', patchedFiles: { 'wewright/commands/get-article.py': FIXED_PY } } } }
    await runRepairLoop({ task: TASK(), llm, env, home, verifyImpl: async () => ({ passed: true, checks: [] }), log: () => {} })
    const { loadKnowledge } = await import('../repair/knowledge.js')
    const { entries } = loadKnowledge(join(home, '.webcli', 'repair-knowledge.json'))
    expect(entries.some((e) => e.site === 'demo-fixture' && e.outcome === 'fixed')).toBe(true)
  })
})
