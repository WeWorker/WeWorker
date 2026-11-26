import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, appendFile } from 'node:fs/promises'
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
    expect(draft.draftDir).toBeTruthy()
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
  it('LLM 异常 → llm-error 回写 open(不烧轮次),同一任务重入可恢复', async () => {
    const bad = { async diagnose() { throw new Error('LLM 服务中断') } }
    const verifyOk = async () => ({ passed: true, checks: [] })
    // 各用例共享 home,草稿秒级 stamp 会挤进同几秒;显式错开 now 完全脱离墙钟撞车
    const first = await runRepairLoop({ task: TASK(), llm: bad, env, home, verifyImpl: verifyOk, log: () => {}, now: Date.now() + 60_000 })
    expect(first.outcome).toBe('llm-error')
    expect(first.task.status).toBe('open')
    expect(first.error).toContain('LLM')
    const good = {
      async diagnose() { return { rootCause: 'logic-bug', patchedFiles: { 'wewright/commands/get-article.py': FIXED_PY } } },
      async revise() { return { rootCause: 'logic-bug', patchedFiles: { 'wewright/commands/get-article.py': FIXED_PY } } },
    }
    const second = await runRepairLoop({ task: first.task, llm: good, env, home, verifyImpl: verifyOk, log: () => {}, now: Date.now() + 120_000 })
    expect(second.outcome).toBe('draft-ready')
    expect(second.task.status).toBe('draft-ready')
  })
  it('基线漂移(ADAPTER_BASE_CHANGED)→ base-changed 提前终止回 open', async () => {
    const llm = {
      async diagnose() {
        // 模拟诊断期间外部改动已装包(升级/重装):循环开头取证后、写草稿前基线变化。
        // 追加内容而非新增文件:wewright/commands/ 下未声明命令的新文件会被包校验拒绝。
        await appendFile(join(home, 'adapters', 'demo-fixture', 'wewright', 'commands', 'get-article.py'), '\n# externally touched\n')
        return { rootCause: 'logic-bug', patchedFiles: { 'wewright/commands/get-article.py': FIXED_PY } }
      },
    }
    const { task, outcome, error } = await runRepairLoop({ task: TASK(), llm, env, home, verifyImpl: async () => ({ passed: true, checks: [] }), log: () => {} })
    expect(outcome).toBe('base-changed')
    expect(task.status).toBe('open')
    expect(error).toContain('ADAPTER_BASE_CHANGED')
  })
})

describe('runRepairLoop 成本元数据', () => {
  it('draft-ready 时 recordExperience 带 meta(rounds/llmCalls/usedPlaybook)', async () => {
    const home2 = await mkdtemp(join(tmpdir(), 'repair-meta-'))
    const adapterRoot = join(home2, 'adapters', 'demo-fixture')
    await mkdir(join(adapterRoot, 'wewright', 'commands'), { recursive: true })
    await writeFile(join(adapterRoot, 'manifest.json'), JSON.stringify({
      schema_version: 2, name: 'demo-fixture', version: '1.0.0', description: 'd', runtime_allowed_hosts: ['demo.example.com'],
      commands: [{ id: 'get-article', runtime: 'wewright', module: 'wewright/commands/get-article.py', description: 'd', schema: { type: 'object' } }],
    }, null, 2))
    await writeFile(join(adapterRoot, 'wewright', 'commands', 'get-article.py'), 'raise TypeError("broken")\n')
    const env2 = { WEWORKER_USER_ADAPTERS_DIR: join(home2, 'adapters'), WEBCLI_ADAPTERS_DIR: join(home2, 'adapters'), HOME: home2 }
    const PB = { detect: 'd', detectSnippet: 's', fixTemplate: 'f' }
    const llm = { async diagnose(ctx) {
      expect(ctx.experienceHint).toBeDefined()
      return { rootCause: 'logic-bug', patchedFiles: { 'wewright/commands/get-article.py': FIXED_PY } }
    } }
    // 预置一条带 playbook 的经验,验证 usedPlaybook 标记
    const { recordExperience } = await import('../repair/knowledge.js')
    recordExperience(join(home2, '.webcli', 'repair-knowledge.json'), { site: 'demo-fixture', runtime: 'wewright', symptom: 'x', rootCause: 'logic-bug', fixStrategy: 'y', outcome: 'fixed', playbook: PB })
    const task2 = buildTask({ source: 'manual', adapterId: 'demo-fixture', failures: [{ tool: 'demo-fixture.get-article', count: 2, lastErr: 'x' }] })
    await runRepairLoop({ task: task2, llm, env: env2, home: home2, verifyImpl: async () => ({ passed: true, checks: [] }), log: () => {} })
    const { loadKnowledge } = await import('../repair/knowledge.js')
    const { entries } = loadKnowledge(join(home2, '.webcli', 'repair-knowledge.json'))
    const hit = entries.find((e) => e.site === 'demo-fixture' && e.meta)
    expect(hit?.meta.rounds).toBe(1)
    expect(hit?.meta.usedPlaybook).toBe(true)
  })
})
