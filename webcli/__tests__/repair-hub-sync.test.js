import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reportExperienceToHub, fetchHubExperiences } from '../repair/hub-sync.js'
import { runRepairLoop } from '../repair/executor.js'
import { buildTask } from '../repair/task.js'
import { recordExperience, loadKnowledge } from '../repair/knowledge.js'

const HUB = 'http://hub.example.test/adapterhub'
const ENTRY = { id: 'k1', site: 'wekm', runtime: 'wewright', root_cause: 'login-expired', symptom: 's', fix_strategy: 'f', outcome: 'fixed' }

describe('reportExperienceToHub', () => {
  it('POST 到 experiences 端点,带 PAT', async () => {
    let called = null
    const ok = await reportExperienceToHub({ entry: ENTRY, registry: HUB, token: 'ahp_t',
      fetchImpl: async (url, opts) => { called = { url, opts }; return { ok: true, status: 200 } } })
    expect(ok).toBe(true)
    expect(called.url).toBe(`${HUB}/api/v1/experiences`)
    expect(called.opts.headers.authorization).toBe('Bearer ahp_t')
    expect(JSON.parse(called.opts.body).site).toBe('wekm')
  })
  it('缺 registry/token → false 不发请求', async () => {
    let called = 0
    expect(await reportExperienceToHub({ entry: ENTRY, registry: '', token: 't', fetchImpl: async () => { called++; return { ok: true } } })).toBe(false)
    expect(await reportExperienceToHub({ entry: ENTRY, registry: HUB, token: '', fetchImpl: async () => { called++; return { ok: true } } })).toBe(false)
    expect(called).toBe(0)
  })
  it('hub 不可达静默返回 false 不抛', async () => {
    expect(await reportExperienceToHub({ entry: ENTRY, registry: HUB, token: 't', fetchImpl: async () => { throw new Error('network dead') } })).toBe(false)
  })
  it('隐私红线:symptom 命中敏感词 → 整条跳过,不发请求(不脱敏上报)', async () => {
    let called = 0
    const ok = await reportExperienceToHub({ entry: { ...ENTRY, symptom: 'Authorization: Bearer abc' }, registry: HUB, token: 't',
      fetchImpl: async () => { called++; return { ok: true } } })
    expect(ok).toBe(false)
    expect(called).toBe(0)
  })
  it('隐私红线:rootCause/fixStrategy/playbook 片段命中敏感词同样跳过', async () => {
    let called = 0
    const hit = async (entry) => reportExperienceToHub({ entry, registry: HUB, token: 't', fetchImpl: async () => { called++; return { ok: true } } })
    expect(await hit({ ...ENTRY, root_cause: 'token 泄漏' })).toBe(false)
    expect(await hit({ ...ENTRY, fix_strategy: '读取 session 后重试' })).toBe(false)
    expect(await hit({ ...ENTRY, playbook: { detect: 'd', detectSnippet: '读取 session cookie 后重试', fixTemplate: 'f' } })).toBe(false)
    expect(await hit({ ...ENTRY, playbook: JSON.stringify({ detectSnippet: 'password=123' }) })).toBe(false)
    expect(called).toBe(0)
  })
})

describe('fetchHubExperiences', () => {
  it('GET 过滤参数,返回 items 标 shared:true', async () => {
    const fetchImpl = async (url) => {
      expect(String(url)).toContain('/api/v1/experiences?site=wekm&runtime=wewright&k=3')
      return { ok: true, json: async () => ({ items: [ENTRY] }) }
    }
    const items = await fetchHubExperiences({ registry: HUB, site: 'wekm', runtime: 'wewright', k: 3, fetchImpl })
    expect(items[0].shared).toBe(true)
  })
  it('服务端 snake_case 行补 camelCase 别名,playbook JSON 字符串解析回对象(injectContext 可直接渲染)', async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ items: [{
      ...ENTRY, hits: 2, last_outcome: 'failed', playbook: JSON.stringify({ detect: 'd', detectSnippet: 'dp', fixTemplate: 'ft' }),
    }] }) })
    const [item] = await fetchHubExperiences({ registry: HUB, site: 'wekm', k: 3, fetchImpl })
    expect(item.rootCause).toBe('login-expired')
    expect(item.fixStrategy).toBe('f')
    expect(item.lastOutcome).toBe('failed')
    expect(item.playbook).toEqual({ detect: 'd', detectSnippet: 'dp', fixTemplate: 'ft' })
    expect(item.shared).toBe(true)
  })
  it('hub 失败 → 空数组静默', async () => {
    expect(await fetchHubExperiences({ registry: HUB, fetchImpl: async () => { throw new Error('x') } })).toEqual([])
    expect(await fetchHubExperiences({ registry: '', fetchImpl: async () => { throw new Error('x') } })).toEqual([])
  })
})

// ── executor 接线:上报(fire-and-forget)/回源(合并进诊断提示)——用 stubGlobal('fetch') 拦截 ──

const FIXED_PY = "import json\nprint(json.dumps({'ok': True}))\n"

async function fixtureHome(prefix) {
  const home = await mkdtemp(join(tmpdir(), prefix))
  const adapterRoot = join(home, 'adapters', 'demo-fixture')
  await mkdir(join(adapterRoot, 'wewright', 'commands'), { recursive: true })
  await writeFile(join(adapterRoot, 'manifest.json'), JSON.stringify({
    schema_version: 2, name: 'demo-fixture', version: '1.0.0', description: 'd', runtime_allowed_hosts: ['demo.example.com'],
    commands: [{ id: 'get-article', runtime: 'wewright', module: 'wewright/commands/get-article.py', description: 'd', schema: { type: 'object' } }],
  }, null, 2))
  await writeFile(join(adapterRoot, 'wewright', 'commands', 'get-article.py'), 'raise TypeError("broken")\n')
  const env = { WEWORKER_USER_ADAPTERS_DIR: join(home, 'adapters'), WEBCLI_ADAPTERS_DIR: join(home, 'adapters'), HOME: home }
  return { home, env }
}

const taskFor = () => buildTask({ source: 'manual', adapterId: 'demo-fixture', failures: [{ tool: 'demo-fixture.get-article', count: 3, lastErr: 'x' }] })
const OK_VERIFY = async () => ({ passed: true, checks: [] })
const PATCH_LLM = { async diagnose() { return { rootCause: 'logic-bug', reasoning: '改返回类型', patchedFiles: { 'wewright/commands/get-article.py': FIXED_PY } } } }

describe('runRepairLoop hub 接线', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('WEBCLI_REPAIR_EXPERIENCE_UPLOAD=off:无任何 hub 请求,循环照常 draft-ready', async () => {
    vi.stubEnv('WEBCLI_REPAIR_EXPERIENCE_UPLOAD', 'off')
    const calls = []
    vi.stubGlobal('fetch', async (...args) => { calls.push(args); throw new Error('hub should not be called') })
    const { home, env } = await fixtureHome('repair-sync-off-')
    const { outcome } = await runRepairLoop({ task: taskFor(), llm: PATCH_LLM, env, home, verifyImpl: OK_VERIFY, log: () => {} })
    await new Promise((r) => setTimeout(r, 20)) // 静置:fire-and-forget 上报若误触发也会显形
    expect(outcome).toBe('draft-ready')
    expect(calls).toHaveLength(0)
  })

  it('默认开启:draft-ready 后有一次对 hub 的 POST(id 与本地沉淀一致、字段转 hub 契约)', async () => {
    vi.stubEnv('WEBCLI_ADAPTERHUB_ENDPOINT', HUB)
    vi.stubEnv('ADAPTERHUB_TOKEN', 'ahp_test_token')
    const posts = []
    vi.stubGlobal('fetch', async (url, opts = {}) => {
      if (opts.method === 'POST') posts.push({ url: String(url), opts })
      return { ok: true, status: 200, json: async () => ({ items: [] }) }
    })
    const { home, env } = await fixtureHome('repair-sync-post-')
    const { outcome } = await runRepairLoop({ task: taskFor(), llm: PATCH_LLM, env, home, verifyImpl: OK_VERIFY, log: () => {} })
    expect(outcome).toBe('draft-ready')
    await vi.waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].url).toBe(`${HUB}/api/v1/experiences`)
    expect(posts[0].opts.headers.authorization).toBe('Bearer ahp_test_token')
    const body = JSON.parse(posts[0].opts.body)
    expect(body.site).toBe('demo-fixture')
    expect(body.symptom).toBe('x')
    expect(body.root_cause).toBe('logic-bug')
    expect(body.fix_strategy).toBe('改返回类型')
    expect(body.outcome).toBe('fixed')
    expect(body.id).toMatch(/^[0-9a-f]{12}$/)
    const { entries } = loadKnowledge(join(home, '.webcli', 'repair-knowledge.json'))
    expect(body.id).toBe(entries.find((e) => e.site === 'demo-fixture' && e.outcome === 'fixed').id) // 两端 id 一致
    await new Promise((r) => setTimeout(r, 20)) // 等 fire-and-forget 收尾再拆 stub
  })

  it('本地命中不足 → hub 回源合并,camelCase 归一后进诊断提示', async () => {
    vi.stubEnv('WEBCLI_ADAPTERHUB_ENDPOINT', HUB)
    vi.stubEnv('ADAPTERHUB_TOKEN', 'ahp_test_token')
    const gets = []
    vi.stubGlobal('fetch', async (url, opts = {}) => {
      if (!opts.method) gets.push(String(url))
      return { ok: true, status: 200, json: async () => ({ items: [{
        id: 'hub1', site: 'demo-fixture', runtime: 'wewright', symptom: 'hub症状信号',
        root_cause: 'login-expired', fix_strategy: '先探登录态', outcome: 'fixed', hits: 2,
        last_outcome: 'failed', playbook: JSON.stringify({ detect: 'd', detectSnippet: 'if url has /login', fixTemplate: '先探登录' }),
      }] }) }
    })
    const { home, env } = await fixtureHome('repair-sync-merge-')
    // 预置 1 条本地经验(命中 1 < 3 → 触发回源,k=2)
    recordExperience(join(home, '.webcli', 'repair-knowledge.json'), { site: 'demo-fixture', runtime: 'wewright', symptom: 'x', rootCause: 'logic-bug', fixStrategy: '本地修法', outcome: 'fixed' })
    let hint = ''
    const llm = { async diagnose(ctx) { hint = ctx.experienceHint; return { rootCause: 'logic-bug', patchedFiles: { 'wewright/commands/get-article.py': FIXED_PY } } } }
    const { outcome } = await runRepairLoop({ task: taskFor(), llm, env, home, verifyImpl: OK_VERIFY, log: () => {} })
    expect(outcome).toBe('draft-ready')
    expect(gets).toHaveLength(1)
    expect(gets[0]).toContain('/api/v1/experiences?site=demo-fixture&runtime=wewright&k=2')
    expect(hint).toContain('hub症状信号')
    expect(hint).toContain('login-expired')
    expect(hint).toContain('先探登录态')
    expect(hint).toContain('检测片段')
    expect(hint).toContain('(注意:最近一次复现失败)')
    await new Promise((r) => setTimeout(r, 20))
  })

  it('回源条目与本地条目同 id → 去重,不重复进提示', async () => {
    vi.stubEnv('WEBCLI_ADAPTERHUB_ENDPOINT', HUB)
    vi.stubEnv('ADAPTERHUB_TOKEN', 'ahp_test_token')
    const { home, env } = await fixtureHome('repair-sync-dedup-')
    const local = recordExperience(join(home, '.webcli', 'repair-knowledge.json'), { site: 'demo-fixture', runtime: 'wewright', symptom: 'local信号', rootCause: 'logic-bug', fixStrategy: '本地修法', outcome: 'fixed' })
    // hub 返回同 id 条目(本机上报回流),symptom 不同 → 应被过滤
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({ items: [{ id: local.id, site: 'demo-fixture', runtime: 'wewright', symptom: '回流重复', root_cause: 'logic-bug', fix_strategy: '回流策略', outcome: 'fixed', hits: 1 }] }) }))
    let hint = ''
    const llm = { async diagnose(ctx) { hint = ctx.experienceHint; return { rootCause: 'logic-bug', patchedFiles: { 'wewright/commands/get-article.py': FIXED_PY } } } }
    const { outcome } = await runRepairLoop({ task: taskFor(), llm, env, home, verifyImpl: OK_VERIFY, log: () => {} })
    expect(outcome).toBe('draft-ready')
    expect(hint).toContain('local信号')
    expect(hint).not.toContain('回流重复')
    await new Promise((r) => setTimeout(r, 20))
  })

  it('沉淀条目命中敏感词 → 本地照常沉淀,但不上报(不发请求)', async () => {
    vi.stubEnv('WEBCLI_ADAPTERHUB_ENDPOINT', HUB)
    vi.stubEnv('ADAPTERHUB_TOKEN', 'ahp_test_token')
    const posts = []
    vi.stubGlobal('fetch', async (url, opts = {}) => {
      if (opts.method === 'POST') posts.push(String(url))
      return { ok: true, status: 200, json: async () => ({ items: [] }) }
    })
    const { home, env } = await fixtureHome('repair-sync-privacy-')
    const task = buildTask({ source: 'manual', adapterId: 'demo-fixture', failures: [{ tool: 'demo-fixture.get-article', count: 3, lastErr: 'Authorization: Bearer abc 失败' }] })
    const { outcome } = await runRepairLoop({ task, llm: PATCH_LLM, env, home, verifyImpl: OK_VERIFY, log: () => {} })
    expect(outcome).toBe('draft-ready')
    await new Promise((r) => setTimeout(r, 20))
    expect(posts).toHaveLength(0)
    const { entries } = loadKnowledge(join(home, '.webcli', 'repair-knowledge.json'))
    expect(entries.some((e) => e.site === 'demo-fixture' && e.outcome === 'fixed')).toBe(true) // 本地沉淀不受影响
  })
})
