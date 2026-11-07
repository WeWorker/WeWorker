#!/usr/bin/env node
/**
 * Long-term memory real E2E runner (HTTP/SSE + memory.db verification).
 * Continues blocked scenarios from docs/memory_real_e2e_test_plan.md section 6.1.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createClient } from '../chat-bench/client.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASE = process.env.WEWORKER_BASE || 'http://127.0.0.1:8765'
const MEMORY_DB = path.join(os.homedir(), '.weworker', 'memory.db')
const OUT_DIR = path.join(__dirname, 'out')

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function snapshotMemoryDb() {
  if (!fs.existsSync(MEMORY_DB)) {
    return { exists: false, active: [], events: [] }
  }
  const db = new DatabaseSync(MEMORY_DB, { readOnly: true })
  try {
    const active = db.prepare(
      "SELECT id, type, key, status, site_scope, updated_at FROM memories WHERE status = 'active' ORDER BY updated_at DESC LIMIT 20",
    ).all()
    const events = db.prepare(
      'SELECT event_id, status, attempts, updated_at FROM memory_events ORDER BY updated_at DESC LIMIT 20',
    ).all()
    return { exists: true, active, events }
  } finally {
    db.close()
  }
}

function diffMemory(before, after) {
  const beforeIds = new Set((before.active || []).map((r) => r.id))
  const added = (after.active || []).filter((r) => !beforeIds.has(r.id))
  const beforeEventIds = new Set((before.events || []).map((r) => r.event_id))
  const newEvents = (after.events || []).filter((r) => !beforeEventIds.has(r.event_id))
  return { added, newEvents }
}

async function subscribeEvents(onEvent) {
  const controller = new AbortController()
  const res = await fetch(`${BASE}/events`, { signal: controller.signal })
  if (!res.ok) throw new Error(`SSE /events failed: ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  ;(async () => {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6).trim()
        if (!raw) continue
        try { onEvent(JSON.parse(raw)) } catch {}
      }
    }
  })().catch(() => {})
  return () => controller.abort()
}

async function runScenario(client, scenario) {
  const memoryEvents = []
  const chatEvents = []
  const stopSse = await subscribeEvents((evt) => {
    if (evt?.type === 'memory_status') memoryEvents.push(evt)
    if (evt?.workId) chatEvents.push(evt)
  })

  const beforeDb = snapshotMemoryDb()
  const work = await client.createWork()
  const workId = work.id

  const result = await client.sendChat(workId, scenario.prompt, {
    timeout: scenario.timeout || 300000,
    onEvent: (evt) => chatEvents.push(evt),
  })

  await sleep(scenario.postDelayMs || 8000)
  const afterDb = snapshotMemoryDb()
  const dbDiff = diffMemory(beforeDb, afterDb)
  stopSse()

  const assistantText = chatEvents
    .filter((e) => ['assistant', 'text', 'message', 'text_delta'].includes(e.type))
    .map((e) => e.content || e.text || e.message || '')
    .join('')
    .slice(0, 2000)

  const toolSteps = chatEvents.filter((e) =>
    ['tool_use', 'tool_result', 'tool_call_start', 'tool_call_result'].includes(e.type),
  ).length
  const streamErrors = chatEvents.filter((e) => e.type === 'error').map((e) => e.content || e.error || '')
  const chatOk = result.ok && !result.timedOut && streamErrors.length === 0 && (assistantText.length > 0 || toolSteps > 0)

  return {
    id: scenario.id,
    name: scenario.name,
    ok: chatOk,
    error: result.error || (result.timedOut ? 'timeout' : undefined) || (streamErrors[0] || undefined),
    streamErrors,
    memoryStatuses: memoryEvents,
    toolSteps,
    assistantPreview: assistantText,
    dbDiff,
    workId,
  }
}

const SCENARIOS = [
  {
    id: 'T2',
    name: '支持工单示例待办查询（扩展连接后）',
    prompt: '请在 支持工单示例中查看我的待办，并打开一个工单的详情和审批进度。只读查询，不要审批、不要转交。请真实执行，不要编造结果。',
    timeout: 360000,
    postDelayMs: 12000,
  },
  {
    id: 'B2-GITHUB',
    name: 'GitHub 公开站点工具流程',
    prompt: '请在 GitHub 中查看 Trending，并整理最近一天值得关注的开源项目。只读，不要修改任何内容。请真实执行，不要编造结果。',
    timeout: 360000,
    postDelayMs: 12000,
  },
  {
    id: 'T5-B1',
    name: 'GitHub 声明式站点流程',
    prompt: '记住，在 GitHub 中调研开源项目时，固定流程是：先查看 Trending，再打开项目详情，最后整理关键信息。这是我的固定操作顺序。',
    timeout: 240000,
    postDelayMs: 10000,
  },
]

const RECOVERY_FLOW = {
  id: 'C2+T11',
  name: '任务失败与恢复（PowerShell）',
  steps: [
    {
      id: 'C2',
      prompt: '请用 PowerShell 执行一个不存在的命令 memory_missing_command_for_test_20260826b，记录失败原因，但不要修改任何文件。',
      timeout: 240000,
      postDelayMs: 10000,
    },
    {
      id: 'T11',
      prompt: '继续处理刚才的任务，改用 Write-Output "memory-recovered-check-20260826b" 验证恢复，不要重新创建任务。',
      timeout: 240000,
      postDelayMs: 10000,
    },
  ],
}

function streamErrors(record) {
  return record.streamErrors || []
}

function judgeScenario(record, status) {
  const memSaved = record.memoryStatuses.some((e) => e.status === 'saved')
  const memProcessing = record.memoryStatuses.some((e) => e.status === 'processing')
  const taskOps = record.dbDiff.added.filter((r) => r.type === 'task_execution')
  const recoveredEvents = record.dbDiff.newEvents.filter((e) => String(e.event_id || '').includes('recover'))

  let verdict = '待判定'
  if (record.id === 'T2') {
    if (status.extension !== 'connected') verdict = '阻塞：扩展未连接'
    else if (taskOps.length > 0 || memSaved) verdict = '通过或部分通过'
    else if (record.toolSteps >= 2 && !memSaved) verdict = '未通过：工具执行但未落库 task_execution'
    else if (record.ok && record.toolSteps === 0) verdict = '未通过：未执行工具'
    else verdict = record.ok ? '待核对' : `失败：${record.error || 'chat error'}`
  } else if (record.id === 'B2-GITHUB') {
    if (status.extension !== 'connected') verdict = '阻塞：扩展未连接'
    else if (taskOps.length > 0 && memSaved) verdict = '通过'
    else if (record.toolSteps >= 2 && !taskOps.length) verdict = '未通过：多次工具调用但未写入 task_execution'
    else verdict = record.ok ? '部分通过/待核对' : `失败：${record.error || 'chat error'}`
  } else if (record.id === 'T5-B1') {
    if (taskOps.length > 0 && memSaved) verdict = '通过'
    else if (memSaved && !taskOps.length) verdict = '未通过：有记忆状态但无 task_execution'
    else if (!memSaved && !taskOps.length) verdict = '未通过：声明式流程未落库'
    else verdict = '待核对'
  } else if (record.id === 'C2+T11' || record.id === 'T11') {
    if (streamErrors(record).length) verdict = `失败：${streamErrors(record)[0]}`
    else if (taskOps.length >= 1 && memSaved) verdict = '通过：任务经验已写入'
    else if (recoveredEvents.length > 0) verdict = '通过：产生恢复事件'
    else if (record.ok && taskOps.length >= 1) verdict = '部分通过：任务执行成功但记忆状态未确认'
    else if (record.ok && memSaved) verdict = '部分通过：执行成功但无 task_recovered 事件'
    else verdict = record.ok ? '部分通过' : `失败：${record.error || 'chat error'}`
  }
  return { verdict, memSaved, memProcessing, siteOps: siteOps.length, taskOps: taskOps.length, recoveredEvents: recoveredEvents.length }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const client = createClient({ base: BASE, token: '' })
  const status = await client.getStatus().catch(() => null)
  if (!status) {
    console.error(`[memory-e2e] Backend 不可用：${BASE}`)
    console.error('请先启动 WeWorker（npm run dev 或已安装客户端），并确保 8765 可访问。')
    process.exit(1)
  }

  console.log('[memory-e2e] status:', JSON.stringify({
    bridge: status.bridge,
    extension: status.extension,
    extension_version: status.extension_version,
  }))

  const settings = await client.getSettings().catch(() => null)
  if (!settings?.has_api_key) {
    console.warn('[memory-e2e] 警告：/settings 未暴露 has_api_key，将继续尝试真实聊天。')
  }

  const results = []
  {
    console.log(`\n[memory-e2e] >>> ${RECOVERY_FLOW.id} ${RECOVERY_FLOW.name}`)
    const memoryEvents = []
    const chatEvents = []
    const stopSse = await subscribeEvents((evt) => {
      if (evt?.type === 'memory_status') memoryEvents.push(evt)
      if (evt?.workId) chatEvents.push(evt)
    })
    const beforeDb = snapshotMemoryDb()
    const work = await client.createWork()
    const stepResults = []
    try {
      for (const step of RECOVERY_FLOW.steps) {
        console.log(`[memory-e2e] --- ${step.id}`)
        const chat = await client.sendChat(work.id, step.prompt, {
          timeout: step.timeout,
          onEvent: (evt) => chatEvents.push(evt),
        })
        await sleep(step.postDelayMs || 8000)
        stepResults.push({ ...step, ok: chat.ok, error: chat.error, timedOut: chat.timedOut })
      }
      const afterDb = snapshotMemoryDb()
      const toolSteps = chatEvents.filter((e) =>
        ['tool_use', 'tool_result', 'tool_call_start', 'tool_call_result'].includes(e.type),
      ).length
      const streamErrors = chatEvents.filter((e) => e.type === 'error').map((e) => e.content || e.error || '')
      const assistantText = chatEvents.filter((e) => e.type === 'text_delta').map((e) => e.content || '').join('').slice(0, 2000)
      const record = {
        id: RECOVERY_FLOW.id,
        name: RECOVERY_FLOW.name,
        workId: work.id,
        memoryStatuses: memoryEvents,
        toolSteps,
        streamErrors,
        assistantPreview: assistantText,
        dbDiff: diffMemory(beforeDb, afterDb),
        steps: stepResults,
        ok: stepResults.every((s) => s.ok) && streamErrors.length === 0,
      }
      const judgment = judgeScenario({ ...record, id: 'C2+T11' }, status)
      results.push({ ...record, judgment })
      console.log('[memory-e2e] verdict:', judgment.verdict)
    } catch (e) {
      results.push({ id: RECOVERY_FLOW.id, error: e.message, judgment: { verdict: `异常：${e.message}` } })
    } finally {
      stopSse()
    }
  }

  for (const scenario of SCENARIOS) {
    console.log(`\n[memory-e2e] >>> ${scenario.id} ${scenario.name}`)
    try {
      const liveStatus = await client.getStatus().catch(() => status)
      const record = await runScenario(client, scenario)
      const judgment = judgeScenario(record, liveStatus)
      const row = { ...record, judgment }
      results.push(row)
      console.log('[memory-e2e] verdict:', judgment.verdict)
      console.log('[memory-e2e] memory_status:', record.memoryStatuses.map((e) => e.status).join(',') || '(none)')
      console.log('[memory-e2e] db added:', record.dbDiff.added.map((r) => `${r.type}:${r.key}`).join(',') || '(none)')
      if (record.assistantPreview) {
        console.log('[memory-e2e] assistant preview:', record.assistantPreview.slice(0, 280).replace(/\s+/g, ' '))
      }
    } catch (e) {
      results.push({ id: scenario.id, name: scenario.name, error: e.message, judgment: { verdict: `异常：${e.message}` } })
      console.error('[memory-e2e] error:', e.message)
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outFile = path.join(OUT_DIR, `memory-e2e-${stamp}.json`)
  fs.writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), base: BASE, status, results }, null, 2))
  console.log(`\n[memory-e2e] 结果已写入 ${outFile}`)
}

main().catch((e) => {
  console.error('[memory-e2e] fatal:', e)
  process.exit(1)
})
