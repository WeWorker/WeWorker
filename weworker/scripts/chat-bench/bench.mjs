#!/usr/bin/env node
// WeWorker 对话自动化测试 + 埋点采集 harness（零侵入）。
// 通过 HTTP+SSE 驱动真实 /works/:id/chat 链路，采集 timing/usage/每步明细，输出 JSONL + Markdown。
// 详见 README.md。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from './client.mjs'
import { createCollector } from './collector.mjs'
import { loadCustomCases, loadRouterCases, fetchTestPrompts, assembleCases } from './cases.mjs'
import { writeReport } from './report.mjs'
import { startBackend, waitForReady, stopBackend } from './server-spawn.mjs'

/** 路由用例清单（与 `npm run route:replay` 同一份来源，见 docs/router-config-manual-testcases.md） */
const DEFAULT_ROUTER_DOC = fileURLToPath(new URL('../../../docs/router-config-manual-testcases.md', import.meta.url))

function printHelp() {
  console.log(`WeWorker chat-bench — 对话自动化测试 + 埋点采集

用法:
  node scripts/chat-bench/bench.mjs [options]

参数:
  --target self|remote      驱动目标（默认 self：自动起独立 dev 后端）
  --base <url>              后端地址（默认 http://127.0.0.1:8765）
  --token <auth>            X-WeWorker-Auth（remote 必填；self 留空）
  --cases <file>            自定义用例（.json 数组 或 .csv）
  --router-cases [doc]      跑路由用例清单（默认 docs/router-config-manual-testcases.md）。
                            与 route:replay 同一份来源；每条输出「是否命中路由 / 耗时 / 实际回答」
  --sites <a,b>             仅跑这些 site 的 test-prompts
  --only <a,b>              只跑 id 含这些子串的用例（如 --only router-pos-1,router-neg-88）
  --prompts                 仅跑 test-prompts（忽略自定义）
  --no-test-prompts         不拉 test-prompts（仅自定义用例）
  --concurrency <n>         并发 work 数（默认 1）
  --timeout <ms>            单用例 SSE 超时（默认 180000）
  --out <dir>               输出目录（默认 ./bench-out）
  --cleanup / --no-cleanup  删除本次创建的 work（self 默认开，remote 默认关）
  --skip-preflight          跳过 provider 预检
`)
}

function parseArgs(argv) {
  const a = {
    target: 'self', base: 'http://127.0.0.1:8765', concurrency: 1,
    timeout: 180000, out: './bench-out', testPrompts: true,
  }
  for (let i = 2; i < argv.length; i++) {
    const cur = argv[i]
    const next = () => argv[++i]
    switch (cur) {
      case '--target': a.target = next(); break
      case '--base': a.base = next(); break
      case '--token': a.token = next(); break
      case '--cases': a.cases = next(); break
      case '--router-cases': {
        // 值可省略：`--router-cases` 单独出现时用仓库里那份路由用例清单。
        const value = argv[i + 1]
        a.routerCases = !value || value.startsWith('--') ? DEFAULT_ROUTER_DOC : next()
        break
      }
      case '--sites': a.sites = next(); break
      case '--only': a.only = next(); break
      case '--prompts': a.promptsOnly = true; break
      case '--no-test-prompts': a.testPrompts = false; break
      case '--concurrency': a.concurrency = Number(next()); break
      case '--timeout': a.timeout = Number(next()); break
      case '--out': a.out = next(); break
      case '--cleanup': a.cleanup = true; break
      case '--no-cleanup': a.cleanup = false; break
      case '--skip-preflight': a.skipPreflight = true; break
      case '-h': case '--help': printHelp(); process.exit(0)
      default: console.error(`未知参数: ${cur}`); process.exit(2)
    }
  }
  return a
}

/** 当前激活的 provider id：优先 `active_provider`，退回「第一个配了 key 的」。 */
function activeProvider(settings) {
  if (settings?.active_provider) return settings.active_provider
  const providers = settings?.providers || {}
  const withKey = Object.entries(providers).find(([, v]) => v?.has_key || v?.openai_has_key)
  return withKey ? withKey[0] : null
}

async function preflight(client) {
  let s
  try { s = await client.getSettings() }
  catch (e) { console.error('[bench] 预检失败：无法读取 settings:', e.message); process.exit(1) }
  if (!s.has_api_key) {
    console.error('[bench] provider 未配置 api_key，请在 WeWorker 应用内配置后重试（或 --skip-preflight）。')
    process.exit(1)
  }

  const provider = activeProvider(s)
  if (!provider) {
    console.log('[bench] 预检跳过：settings 里认不出激活的 provider，无法探活（不阻断）。')
    return
  }
  try {
    const t = await client.testProvider(provider)
    if (t && t.ok === false) {
      console.error('[bench] provider 连通性测试失败:', t.detail || t.error || JSON.stringify(t))
      process.exit(1)
    }
    console.log(`[bench] provider 预检通过（${provider}）`)
  } catch (e) {
    // 探活接口本身出问题（端点/参数变更、build 白名单拒绝）不当作「provider 不可用」：
    // 那是预检自己的事，不该阻断整批用例。真失败会在用例里如实记为 error。
    console.log(`[bench] provider 探活未能完成（${e.message}），继续跑；用例失败会如实记录。`)
  }
}

async function runCase(client, caseDef, { timeout, analyze }) {
  const collector = createCollector(caseDef, Date.now())
  let workId = null
  try {
    const work = await client.createWork()
    workId = work?.id
    caseDef.workId = workId
    if (workId) await client.setTitle(workId, `[bench] ${caseDef.id}`).catch(() => {})

    const res = await client.sendChat(workId, caseDef.prompt, {
      onEvent: (ev) => collector.ingest(ev),
      timeout,
    })
    if (!res.ok) {
      collector.setStatus(res.timedOut ? 'timeout' : 'error')
      if (res.error) collector.ingest({ type: 'error', content: res.error })
    }
    const result = collector.finalize()
    result.workId = workId

    // 事后 tool 成败分析（仅 siteId 用例，复用 POST /health-check/analyze）
    if (analyze && caseDef.siteId && result.status !== 'timeout' && result.status !== 'aborted') {
      try {
        const a = await client.analyze(workId, caseDef.siteId)
        const tools = a?.tools ? Object.values(a.tools) : []
        if (tools.length) {
          result.healthCheck = {
            pass: tools.filter((t) => t.status === 'pass').length,
            fail: tools.filter((t) => t.status === 'fail').length,
            uncovered: tools.filter((t) => t.status === 'uncovered').length,
          }
        }
      } catch { /* 分析失败不影响主结果 */ }
    }
    return { result, workId }
  } catch (e) {
    collector.setStatus('error')
    collector.ingest({ type: 'error', content: e instanceof Error ? e.message : String(e) })
    const result = collector.finalize()
    result.workId = workId
    return { result, workId }
  }
}

async function runPool(items, concurrency, worker) {
  const out = new Array(items.length)
  let cursor = 0
  async function next() {
    while (cursor < items.length) {
      const idx = cursor++
      out[idx] = await worker(items[idx], idx)
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length))
  await Promise.all(Array.from({ length: n }, () => next()))
  return out
}

async function main() {
  const args = parseArgs(process.argv)
  const cleanup = args.cleanup == null ? (args.target === 'self') : args.cleanup
  const here = path.dirname(fileURLToPath(import.meta.url))
  const backendDir = path.resolve(here, '../../backend-ts')

  const client = createClient({ base: args.base, token: args.token || '' })
  let backendChild = null

  try {
    if (args.target === 'self') {
      console.log(`[bench] 启动独立后端 (cwd=${backendDir})`)
      backendChild = startBackend({ backendDir })
      await waitForReady(async () => {
        if (backendChild.exitCode != null) {
          throw new Error(
            '独立后端已退出——多为端口 8765 被运行中的客户端占用。请先关闭 WeWorker 客户端，或改用 --target remote。',
          )
        }
        const s = await client.getStatus()
        // 只认自己刚起的那个进程（instanceId 来自 WEWORKER_BACKEND_INSTANCE_ID）：
        // 否则 8765 上已运行的旧客户端会被误判为「就绪」，整批用例打到旧进程上。
        return s && s.backend_instance_id === backendChild.instanceId ? s : null
      }, { timeout: 60000 })
      console.log('[bench] 后端就绪')
    } else {
      const s = await client.getStatus()
      if (!s) {
        console.error(`[bench] 无法连接已运行客户端 ${args.base}（GET /status 无响应）。确认 WeWorker 已启动。`)
        process.exit(1)
      }
      console.log(`[bench] 连接已运行客户端 ${args.base}`)
    }

    if (!args.skipPreflight) await preflight(client)

    // 装配用例：自定义 + 路由清单 + test-prompts（去重）
    const custom = args.promptsOnly ? [] : loadCustomCases(args.cases)
    const routerCases = args.promptsOnly ? [] : loadRouterCases(args.routerCases)
    const tp = args.testPrompts ? await fetchTestPrompts(client, args.sites) : []
    const assembled = assembleCases({
      custom: [...custom, ...routerCases],
      testPrompts: tp,
      promptsOnly: args.promptsOnly,
    })
    const only = args.only
      ? new Set(String(args.only).split(',').map((v) => v.trim()).filter(Boolean))
      : null
    const cases = only ? assembled.filter((c) => [...only].some((k) => String(c.id).includes(k))) : assembled
    if (!cases.length) {
      console.error('[bench] 没有可用用例（提供 --cases / --router-cases，或去掉 --no-test-prompts，或检查 --sites / --only 拼写）。')
      process.exit(1)
    }
    console.log(
      `[bench] 装配 ${assembled.length} 个用例（custom ${custom.length} / 路由清单 ${routerCases.length} / test-prompts ${tp.length}）` +
        `${only ? `，--only 过滤后保留 ${cases.length}` : ''}，concurrency=${args.concurrency}`,
    )

    const runTs = new Date().toISOString().replace(/[:.]/g, '-')
    let done = 0
    const collected = await runPool(cases, args.concurrency, async (c) => {
      const { result } = await runCase(client, c, { timeout: args.timeout, analyze: !!c.siteId })
      done++
      const t = result.timing || {}
      const route = result.route?.hit ? `命中路由(${result.route.tool})` : '落回 LLM'
      console.log(`[bench] (${done}/${cases.length}) ${result.id} → ${result.status}  ${route}  totalMs=${t.totalMs ?? '-'}  steps=${result.stepCount}`)
      return { result, workId: result.workId }
    })

    const results = collected.map((x) => x.result)
    const { runDir, summaryPath } = writeReport({ outDir: args.out, runTs, results })
    console.log(`[bench] 报告：${summaryPath}`)
    console.log(`[bench] 目录：${runDir}`)

    if (cleanup) {
      console.log('[bench] 清理本次 work...')
      for (const { workId } of collected) {
        if (workId) await client.deleteWork(workId).catch(() => {})
      }
    }
  } finally {
    if (backendChild) stopBackend(backendChild)
  }
}

main().catch((e) => {
  console.error('[bench] 致命错误:', e instanceof Error ? e.stack || e.message : e)
  process.exit(1)
})
