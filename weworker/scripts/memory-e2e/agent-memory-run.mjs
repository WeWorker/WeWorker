#!/usr/bin/env node
/**
 * 长期记忆 Agent 驱动验收：DOM 输入自然语言 → 读取助手回复 → 记录 memory.db 变化。
 * 语义判定由执行者（Agent）阅读 ASSISTANT 日志完成，脚本不做 verdict。
 *
 * Usage:
 *   node scripts/memory-e2e/agent-memory-run.mjs [--reuse] [--phase A|C|B|NEG|SITE|ALL] [--step B2,T2]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import {
  BASE,
  bootstrapUiEnv,
  connectWeWorkerPage,
  createNewWork,
  disableProxy,
  forceStopStreaming,
  getAuthToken,
  logLive,
  sendChatViaDom,
  subscribeEvents,
} from './ui-lib.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MEMORY_DB = path.join(os.homedir(), '.weworker', 'memory.db')
const OUT_DIR = path.join(__dirname, 'out')

const args = process.argv.slice(2)
const reuseEnv = args.includes('--reuse')
const waitExtension = args.includes('--wait-extension')
const phaseArg = args.find((a) => a.startsWith('--phase='))?.split('=')[1]
  || (args.includes('--phase') ? args[args.indexOf('--phase') + 1] : 'ALL')
const stepFilterRaw = args.find((a) => a.startsWith('--step='))?.split('=')[1]
  || (args.includes('--step') ? args[args.indexOf('--step') + 1] : '')
const stepFilter = new Set(
  String(stepFilterRaw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
)

function snapshotMemoryDb() {
  if (!fs.existsSync(MEMORY_DB)) return { exists: false, active: [], events: [] }
  const db = new DatabaseSync(MEMORY_DB, { readOnly: true })
  try {
    return {
      exists: true,
      active: db.prepare(
        "SELECT id, type, key, status, site_scope, updated_at, substr(content,1,120) AS content_preview FROM memories WHERE status = 'active' ORDER BY updated_at DESC LIMIT 30",
      ).all(),
      events: db.prepare(
        'SELECT event_id, status, attempts, updated_at FROM memory_events ORDER BY updated_at DESC LIMIT 30',
      ).all(),
    }
  } finally {
    db.close()
  }
}

function diffMemory(before, after) {
  const beforeIds = new Set((before.active || []).map((r) => r.id))
  const added = (after.active || []).filter((r) => !beforeIds.has(r.id))
  const updated = (after.active || []).filter((r) => {
    const prev = (before.active || []).find((p) => p.id === r.id)
    return prev && prev.updated_at !== r.updated_at
  })
  const beforeEventIds = new Set((before.events || []).map((r) => r.event_id))
  const newEvents = (after.events || []).filter((r) => !beforeEventIds.has(r.event_id))
  return { added, updated, newEvents }
}

/** 场景定义：prompt + 验收意图（供 Agent 读回复后判定）。 */
const PHASES = {
  A: {
    name: 'user_usage 用户偏好',
    steps: [
      {
        id: 'A1',
        newWork: true,
        prompt: '以后整理版本发布说明时，先给一句结论，再列变化点，最后列测试状态。这是我的长期工作习惯。',
        expect: '保存 user_usage；banner 或 DB 有更新；内容为格式偏好而非整段原文',
      },
      {
        id: 'A1-recall',
        newWork: true,
        prompt: '请整理一下本次版本更新内容。假设有：修复登录超时、新增导出按钮、回归测试通过。',
        expect: '新会话按结论→变化点→测试状态组织，无需用户重复偏好',
      },
      {
        id: 'A2',
        newWork: true,
        prompt: '本次只需要把这一句话展开说明，不要把它作为长期习惯：「WeWorker 支持长期记忆」。',
        expect: '当前可展开说明，但不新增 active user_usage',
      },
      {
        id: 'A3',
        newWork: true,
        prompt: '以后版本发布说明改为先列变化点，再给结论，最后写测试状态。',
        expect: 'update/supersede 旧偏好；召回时是新顺序',
      },
    ],
  },
  C: {
    name: 'task_execution 任务成败经验（跨会话加载与执行效果）',
    steps: [
      {
        id: 'C-fail-seed',
        newWork: true,
        prompt: '请用 PowerShell 执行不存在的命令 memory_agent_missing_cmd_20260828，确认失败原因。不要修改任何文件。',
        expect: '真实失败；失败经验写入长期记忆（banner/DB）；缺块则协议违规可观测且不写库',
        turnTimeoutMs: 300000,
      },
      {
        id: 'C-fail-reuse',
        newWork: true,
        // 中性提示：禁止「利用已有经验／最多1次／不要查帮助」等教练语（防假绿）
        prompt: '请用 PowerShell 执行 memory_agent_missing_cmd_reuse_20260828，确认结果。不要修改文件。',
        expect: '新会话加载失败经验；相对冷启动更少试错；变快但库空=失败',
        turnTimeoutMs: 420000,
      },
      {
        id: 'C-ok-seed',
        newWork: true,
        prompt: '请用 PowerShell 执行 Write-Output "memory-agent-ok-20260828"，确认成功。不要修改文件。',
        expect: '真实成功；若有 hidden block 则成功经验可落库（允许显式 ignore）',
        turnTimeoutMs: 300000,
      },
      {
        id: 'C-ok-reuse',
        newWork: true,
        prompt: '请用 PowerShell 执行 Write-Output "memory-agent-ok-reuse-20260828"，确认输出。不要修改文件。',
        expect: '新会话快速直接执行成功；输出含 memory-agent-ok-reuse；库空不得宣称记忆加速',
        turnTimeoutMs: 300000,
      },
      {
        id: 'C-recall-only',
        newWork: true,
        prompt: 'PowerShell 里命令不存在时，通常怎么判断失败？只说明方法，不要实际执行。',
        expect: '跨会话召回失败经验要点（CommandNotFound/退出码），不编造未发生的执行；不能单独证明加快',
      },
    ],
  },
  B: {
    name: 'task_execution 网站任务经验',
    steps: [
      {
        id: 'B1',
        newWork: true,
        prompt: '记住，在 费用管理示例提交团建报销时，先选择费用归属，再上传发票，最后提交前让我确认。',
        expect: '声明式 task_execution 候选；无工具时可能仅 agent_decision',
        turnTimeoutMs: 360000,
      },
      {
        id: 'B1-recall',
        newWork: true,
        prompt: '帮我继续处理团建报销。',
        expect: '召回费用管理示例报销流程步骤',
      },
      {
        id: 'B1-unrelated',
        newWork: true,
        prompt: '帮我查询费用管理示例的会议室记录。',
        expect: '不应无条件注入团建报销流程',
      },
      {
        id: 'B2',
        newWork: true,
        prompt: '请在 GitHub 中查看 Trending，并整理最近一天值得关注的开源项目。只读，不要修改任何内容。请真实执行，不要编造结果。',
        expect: '扩展连接时按完整上下文判断任务是否完成；未登录时停在登录等待；不得伪造成功 task_execution',
        requiresExtension: true,
        turnTimeoutMs: 360000,
      },
    ],
  },
  SITE: {
    name: '真实站点工具链（需扩展+登录）',
    steps: [
      {
        id: 'T2',
        newWork: true,
        prompt: '请在 支持工单示例中查看我的待办，并打开一个工单的详情和审批进度。只读查询，不要审批、不要转交。请真实执行，不要编造结果。',
        expect: '真实 webcli 调用；成功或可复用失败均归入 task_execution；未登录应等待登录而非编造',
        requiresExtension: true,
        turnTimeoutMs: 360000,
      },
      {
        id: 'T3-GITHUB-fail',
        newWork: true,
        prompt: '请在 GitHub 中查看 Trending。只读，不要修改任何内容。请真实执行，不要编造结果。',
        expect: '扩展未登录/失败时记录分类 task_execution 失败路径，不得伪造成功经验',
        requiresExtension: true,
        turnTimeoutMs: 360000,
      },
    ],
  },
  NEG: {
    name: '负向与禁用站点',
    steps: [
      {
        id: 'T1',
        newWork: true,
        prompt: '帮我在小红书搜索蛋糕推荐，只判断这个请求在当前 WeWorker 里能不能执行，不要编造结果。',
        expect: '说明 xiaohongshu.com 禁用/不可用，不调用工具，不写成功 task_execution',
      },
      {
        id: 'T7',
        newWork: true,
        prompt: '帮我查询 Gmail 最近一封邮件，只判断能不能执行，不要编造结果。',
        expect: '说明 mail.google.com 禁用/不可用',
        turnTimeoutMs: 360000,
      },
    ],
  },
}

async function fetchBackendStatus(token = '') {
  const headers = token ? { 'X-WeWorker-Auth': token } : {}
  const res = await fetch(`${BASE}/status`, { headers }).catch(() => null)
  if (!res?.ok) return null
  return res.json().catch(() => null)
}

async function waitForExtensionConnected(token = '', maxWaitMs = 600000) {
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    const status = await fetchBackendStatus(token)
    if (status?.extension === 'connected') {
      logLive('env', 'extension connected', status.extension_version || '')
      return status
    }
    logLive('env', '等待 Chrome 扩展连接…', `bridge=${status?.bridge || '?'} ext=${status?.extension || '?'}`)
    logLive('env', '请打开 Chrome，加载 WeWorker 扩展，确保左下角显示「扩展已连接」')
    await new Promise((r) => setTimeout(r, 8000))
  }
  throw new Error('扩展在时限内未连接')
}

async function runStep(ctx, step) {
  logLive('scenario', `>>> ${step.id}`, step.expect)
  await forceStopStreaming(ctx.page).catch(() => {})
  if (step.newWork) {
    logLive('scenario', '新建会话')
    await createNewWork(ctx.page, { token: ctx.token })
  }
  const beforeDb = snapshotMemoryDb()
  const memBefore = ctx.memoryEvents.length
  let out
  try {
    out = await sendChatViaDom(ctx.page, step.prompt, {
      turnTimeoutMs: step.turnTimeoutMs || 240000,
      postDelayMs: 8000,
    })
  } catch (e) {
    await forceStopStreaming(ctx.page).catch(() => {})
    throw e
  }
  const afterDb = snapshotMemoryDb()
  const dbDiff = diffMemory(beforeDb, afterDb)
  const memNew = ctx.memoryEvents.slice(memBefore)
  const record = {
    id: step.id,
    prompt: step.prompt,
    expect: step.expect,
    assistantReply: out.assistantReply,
    banner: out.banner,
    tools: out.tools,
    elapsedMs: out.elapsedMs,
    memoryStatuses: memNew,
    dbDiff,
  }
  logLive('scenario', `${step.id} db+`, dbDiff.added.map((r) => `${r.type}:${r.key}`).join(',') || '(none)')
  logLive('scenario', `${step.id} db~`, dbDiff.updated.map((r) => `${r.type}:${r.key}`).join(',') || '(none)')
  const stepMatch = String(out.assistantReply || '').match(/(\d+)\s*步/)
  const steps = stepMatch ? Number(stepMatch[1]) : null
  logLive('effect', `${step.id}`, {
    elapsedSec: Math.round(out.elapsedMs / 1000),
    steps,
    banner: out.banner,
    memorySaved: memNew.some((e) => e.status === 'saved') || dbDiff.added.length > 0,
    replyHead: String(out.assistantReply || '').slice(0, 180).replace(/\s+/g, ' '),
  })
  return record
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  disableProxy()
  await bootstrapUiEnv({ reuse: reuseEnv })

  const { page } = await connectWeWorkerPage()
  const token = await getAuthToken(page)
  const status = (await fetchBackendStatus(token)) || {}
  logLive('env', 'extension', status.extension, 'bridge', status.bridge)
  const memoryEvents = []
  const stopSse = await subscribeEvents((evt) => {
    if (evt?.type === 'memory_status') {
      memoryEvents.push(evt)
      logLive('sse', 'memory_status', evt.status, evt.eventId?.slice(-28))
    }
  }, token)

  const pickPhases = phaseArg === 'ALL' ? ['NEG', 'B', 'SITE'] : [phaseArg]
  const results = []

  if (waitExtension || pickPhases.some((k) => PHASES[k]?.steps?.some((s) => s.requiresExtension))) {
    try {
      await waitForExtensionConnected(token)
    } catch (e) {
      logLive('warn', e.message, '站点场景将跳过')
    }
  }

  for (const key of pickPhases) {
    const phase = PHASES[key]
    if (!phase) {
      logLive('warn', `未知 phase: ${key}`)
      continue
    }
    logLive('phase', `==== ${key}: ${phase.name} ====`)
    for (const step of phase.steps) {
      if (stepFilter.size > 0 && !stepFilter.has(step.id)) {
        logLive('scenario', `>>> ${step.id} SKIP（--step 过滤）`)
        continue
      }
      const statusNow = (await fetchBackendStatus(token)) || {}
      if (step.requiresExtension && statusNow.extension !== 'connected') {
        logLive('scenario', `>>> ${step.id} SKIP（扩展未连接）`)
        results.push({ id: step.id, skipped: true, reason: 'extension disconnected' })
        continue
      }
      try {
        results.push(await runStep({ page, token, memoryEvents }, step))
      } catch (e) {
        logLive('error', step.id, e.message)
        results.push({ id: step.id, error: e.message })
      }
    }
  }

  stopSse()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outFile = path.join(OUT_DIR, `memory-agent-${stamp}.json`)
  fs.writeFileSync(outFile, JSON.stringify({
    at: new Date().toISOString(),
    status,
    memoryDb: snapshotMemoryDb(),
    results,
  }, null, 2))
  logLive('done', outFile)
  process.exit(results.some((r) => r.error) ? 1 : 0)
}

main().catch((e) => {
  logLive('fatal', e.message)
  process.exit(1)
})
