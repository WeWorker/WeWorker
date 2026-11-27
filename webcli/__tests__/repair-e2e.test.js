import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, cp, readFile } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTask } from '../repair/task.js'
import { runRepairLoop } from '../repair/executor.js'
import { verifyRepair } from '../repair/verify.js'
import { resolveToolkitRuntime } from '../toolkit-runner.js'

// mkdtemp 临时根统一登记,afterAll 一次性清理(与 repair-verify.test.js 同惯例)
const roots = []
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

let runtimePath = null
try { runtimePath = resolveToolkitRuntime(); } catch { /* 无运行时环境:跳过 */ }

describe.runIf(runtimePath)('repair 端到端(Webwright 实跑,需外网可达 example.com)', () => {
  let env, home
  beforeAll(async () => {
    // hub 同步关闭:端到端只验本地修复链路,不触发经验回源外呼
    process.env.WEBCLI_REPAIR_EXPERIENCE_UPLOAD = 'off'
    home = await mkdtemp(join(tmpdir(), 'repair-e2e-'))
    roots.push(home)
    const adapters = join(home, 'adapters')
    // 参考答案 *.fixed.py 是修复元数据,不属 adapter 包;装入目录带未声明文件会被
    // 包校验(validatePackageFiles 文件封闭性)拒绝,故 cp 时排除,只复制可安装包体。
    await cp(join(import.meta.dirname, 'fixtures', 'repair-fixture'), join(adapters, 'demo-fixture'), { recursive: true, filter: (src) => !src.endsWith('.fixed.py') })
    env = { ...process.env, WEWORKER_USER_ADAPTERS_DIR: adapters, WEBCLI_ADAPTERS_DIR: adapters, HOME: home, WEWORKER_TOOLKIT_RUNTIME: runtimePath }
  })

  it('故障 fixture:真实验证层跑通修复循环(假 LLM 按参考答案出补丁)', async () => {
    const FIXED_PY = await readFile(join(import.meta.dirname, 'fixtures', 'repair-fixture', 'wewright', 'commands', 'get-article.fixed.py'), 'utf8')
    const llm = { async diagnose() { return { rootCause: 'logic-bug', reasoning: '参数缺失需结构化返回', patchedFiles: { 'wewright/commands/get-article.py': FIXED_PY } } } }
    // 运行时 runner 把命令结果包在 data 字段(adapter_v2 生成模块同款 success_output:ok/tool/data/page),
    // 顶层 ok 恒为 true(执行成功),业务断言走 data.* 路径。
    const fixtures = [{ id: 'f1', commandId: 'get-article', expect: { equals: { ok: true }, patterns: { 'data.title': '^article:' }, rowCount: { 'data.rows': 2 } } }]
    const task = buildTask({
      source: 'manual', adapterId: 'demo-fixture',
      failures: [{ tool: 'demo-fixture.get-article', count: 3, lastErr: 'TypeError' }],
      repro: { sample: { keyword: 'hello' } },
    })
    // 真实验证层外包一层失败详情输出:环境类故障(spawn EPERM / 网络不通 / page_recovery)
    // 的根因在 checks[].error/stderrTail,后续轮次 outcome(llm-error/archived)不携带
    // verification,须在失败当场打印,否则只剩断言差值无从定位。
    const verifyImpl = async (args) => {
      const v = await verifyRepair(args)
      for (const c of v.checks) {
        if (!c.passed && (c.error || c.stderrTail)) console.error(`[e2e] check ${c.name} 失败: ${c.error || ''} ${c.stderrTail || ''}`.trim())
      }
      return v
    }
    const { outcome, verification, error } = await runRepairLoop({ task, llm, env, home, runtimePath, fixtures, verifyImpl, log: (m) => console.error(m) })
    // 终态未达 draft-ready(llm-error / base-changed / archived)时整包输出,补齐根因上下文。
    if (outcome !== 'draft-ready') console.error('[e2e] 未达 draft-ready:', JSON.stringify({ outcome, error: error || null, verification }, null, 2))
    expect(outcome).toBe('draft-ready')
    expect(verification.passed).toBe(true)
    expect(verification.checks.find((c) => c.name === 'replay:get-article').passed).toBe(true)
    expect(verification.checks.find((c) => c.name === 'fixture:f1').passed).toBe(true)
  })
})
