// 单用例 SSE 事件采集器：把 POST /works/:id/chat 的 SSE 事件流累积成结构化 CaseResult。
//
// 采集的埋点全部来自后端既有产出（零侵入）：
//   turn_end(totalMs/llmMs/execMs/steps)   —— server.ts:2204
//   tool_call_start(thinkMs)               —— server.ts:2124
//   tool_call_result(execMs)               —— server.ts:2158
//   usage(token + cache_hit + cost)        —— agent.ts:733
// collector 只做"累积 + 摘要"，不调用任何后端接口。

const SNIPPET_MAX = 500
/** 单条回答最多留存多少字符（超出截断；`textLength` 始终是精确值）。 */
const ANSWER_MAX = 20000

function snippet(value) {
  if (value == null) return ''
  const s = typeof value === 'string' ? value : safeStringify(value)
  return s.length > SNIPPET_MAX ? `${s.slice(0, SNIPPET_MAX)}…(+${s.length - SNIPPET_MAX})` : s
}

function safeStringify(v) {
  try { return JSON.stringify(v) } catch { return String(v) }
}

// 与 health-check.ts:84-88 一致：tool_result 的 JSON 含 error 字段视为失败。
function resultIsError(resultStr) {
  if (!resultStr) return false
  try {
    const p = JSON.parse(resultStr)
    return !!(p && typeof p === 'object' && 'error' in p)
  } catch {
    return false
  }
}

/**
 * @param {object} caseDef — { id, prompt, siteId?, category?, expectTools?, expectMaxMs? }
 * @param {number} startedAt — 起始时间戳 (Date.now())
 */
export function createCollector(caseDef, startedAt = Date.now()) {
  const t0 = startedAt
  const trace = []            // 每事件一行（轻量字段），用于 JSONL 明细
  let turnId = ''
  let textLength = 0
  let answer = ''             // 回答原文（**用户实际看到的那段**），上限 ANSWER_MAX 字符
  let status = 'running'      // running → ok | error | timeout | aborted
  let error = null
  const steps = new Map()     // toolId -> step accumulator
  let timing = null           // { totalMs, llmMs, execMs, steps }
  let usage = null            // 来自 usage 事件

  function record(event, extra = {}) {
    trace.push({ t: Date.now() - t0, type: event.type, ...extra })
  }

  function ingest(event) {
    switch (event.type) {
      case 'turn_start':
        if (event.turnId) turnId = event.turnId
        record(event, { turnId: event.turnId, workId: event.workId })
        break

      case 'text_delta': {
        // trace（JSONL）可能很长，只记长度避免膨胀；**回答原文**另存在结果里（cases.json + 报告）。
        // 走快速路由的回合只发一次 text_delta（渲染好的 md），走 LLM 的回合按 token 增量发。
        const chunk = event.content || ''
        textLength += chunk.length
        if (answer.length < ANSWER_MAX) answer += chunk.slice(0, ANSWER_MAX - answer.length)
        record(event, { len: chunk.length })
        break
      }

      case 'tool_call_start': {
        const id = event.id
        const name = event.name || ''
        if (!steps.has(id)) {
          steps.set(id, {
            name,
            thinkMs: event.thinkMs,
            execMs: undefined,
            argsSnippet: snippet(event.args),
            resultSnippet: '',
            ok: null,
          })
        } else {
          // streaming 模式下 tool_call_start 会发两次（stream_event + assistant message），
          // 第二次用于补全 name/args（见 server.ts:2126 isUpdate 分支）。
          const s = steps.get(id)
          if (!s.name && name) s.name = name
          if (event.args != null) s.argsSnippet = snippet(event.args)
          if (event.thinkMs != null && s.thinkMs == null) s.thinkMs = event.thinkMs
        }
        record(event, { id, name, thinkMs: event.thinkMs })
        break
      }

      case 'tool_call_result': {
        const id = event.id
        const s = steps.get(id)
        if (s) {
          s.execMs = event.execMs
          s.resultSnippet = snippet(event.result)
          s.ok = !resultIsError(event.result)
        }
        record(event, { id, execMs: event.execMs, ok: s ? s.ok : null })
        break
      }

      case 'tool_call_image':
        record(event, { id: event.id })
        break

      case 'usage':
        usage = { ...(event.usage || {}) }
        record(event)
        break

      case 'turn_end':
        timing = {
          totalMs: event.totalMs,
          llmMs: event.llmMs,
          execMs: event.execMs,
          steps: event.steps,
          // 路由自描述字段：只有**走了快速路由**的回合才带（api-query-router/index.ts 的 emitRoutedAnswer）。
          // 走 LLM 的回合由 agent 侧发 turn_end，这些字段为 undefined —— 所以「有没有 routeTool」
          // 就是「有没有走路由」的唯一判据，不必去猜。
          routeTool: event.routeTool ?? null,
          routeSource: event.routeSource ?? null,
          routeArgs: event.routeArgs ?? null,
        }
        if (status === 'running') status = 'ok'
        record(event, { routeTool: event.routeTool, routeSource: event.routeSource })
        break

      case 'error':
        error = event.content || 'unknown error'
        status = 'error'
        record(event, { content: snippet(event.content) })
        break

      case 'done':
        record(event)
        break

      default:
        // user_message_saved / title_update / user_choice / terminal_event 等：原样留痕
        record(event)
    }
  }

  /** 上层在 sendChat 返回后据结果标记最终状态（timeout/aborted/error）。 */
  function setStatus(s) { status = s }

  function finalize() {
    const stepList = [...steps.values()].map(s => ({
      name: s.name,
      thinkMs: s.thinkMs,
      execMs: s.execMs,
      argsSnippet: s.argsSnippet,
      resultSnippet: s.resultSnippet,
      ok: s.ok,
    }))
    const endedAt = Date.now()

    // 断言（仅对显式声明的用例生效；test-prompts 不声明）
    const assertions = {}
    if (Array.isArray(caseDef.expectTools) && caseDef.expectTools.length) {
      const called = new Set(stepList.map(s => s.name).filter(Boolean))
      assertions.expectToolsHit = caseDef.expectTools.filter(t => called.has(t))
      assertions.expectToolsMissed = caseDef.expectTools.filter(t => !called.has(t))
      assertions.expectToolsOk = assertions.expectToolsMissed.length === 0
    }
    if (caseDef.expectMaxMs != null && timing) {
      assertions.expectMaxMs = caseDef.expectMaxMs
      assertions.maxMsOk = timing.totalMs <= caseDef.expectMaxMs
    }
    // 路由命中断言：唯一判据是 turn_end 有没有带 routeTool（见 ingest 的 turn_end 分支）。
    const route = {
      hit: !!timing?.routeTool,
      tool: timing?.routeTool || null,
      source: timing?.routeSource || null,
      args: timing?.routeArgs || null,
    }
    if (typeof caseDef.expectRoute === 'boolean') {
      assertions.expectRoute = caseDef.expectRoute
      assertions.routeOk = route.hit === caseDef.expectRoute
    }

    // 兜底：流正常结束但未收到 turn_end（理论上不应发生）。
    if (status === 'running') status = timing ? 'ok' : 'aborted'

    return {
      id: caseDef.id,
      prompt: caseDef.prompt,
      siteId: caseDef.siteId || null,
      category: caseDef.category || null,
      source: caseDef.source || 'custom',
      availableTools: caseDef.availableTools || null,
      workId: caseDef.workId || null,
      turnId,
      status,
      startedAt: t0,
      endedAt,
      wallMs: endedAt - t0,
      timing,
      route,
      usage,
      steps: stepList,
      stepCount: stepList.length,
      answer,
      answerTruncated: textLength > answer.length,
      textLength,
      assertions,
      error,
      trace,
    }
  }

  return { ingest, finalize, setStatus, getTrace: () => trace }
}
