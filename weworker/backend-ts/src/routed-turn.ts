/**
 * 智能路由的**共享入口**：把「确定性级联」从 HTTP `/chat` handler 里下沉出来，
 * 供桌面对话、定时任务与 IM 渠道共用同一份接线。
 *
 * 为什么要有这个模块：承接 `docs/intelligent_routing_architecture.md` 的级联原先只在
 * `server.ts` 的 `handleChatRequest` 内联调用一次，于是定时任务（`task-executor`）与
 * 渠道（`runChannelChat` / 企微流式回合）**根本不经过路由**——配置再正确也不会被读到。
 * 把接线下沉为函数后，新增入口只需调用本函数，而不是各自复制那一段分支。
 *
 * 三条不变量（与架构文档一致，改动前先读 §12 红线）：
 * 1. **不确定即落回**：本函数只做转发与结果收集，命中/落回完全由 `tryIntelligentQueryRoute`
 *    决定；它返回 false 时调用方必须继续走原来的 `streamChat`，行为与接线前逐字一致。
 *    **接口请求报错、超时、空结果、渲染不出内容都算「未命中」**（判定在
 *    `api-query-router/route-dispatch.ts`），所以它们同样落到这条出口——快速路绝不会把
 *    `⚠️ 查询失败` 当成答案交出去。唯一例外是**已经推过流**再抛错（典型：落库失败）：
 *    那时退回模型会让用户收到两条答案，因此保留已产出的正文（见函数内 `visible`）。
 * 2. **只读是准入硬门**：由 `api-query-router` 的 `isRoutableTool` 强制，本模块不放宽。
 * 3. **权限不得因路由被绕过**：`qa_only` 渠道回合连 MCP 工具都不注册（见 `tools.ts`），
 *    因此这些回合**绝不允许**路由派发只读工具，否则等于给访客开了一条模型自己都没有的通道。
 *
 * 谁不该接入：**专属 Agent**（桌面专属 Agent 对话、专属 Agent 渠道 profile）。它们有自己的
 * 站点/技能边界，路由可能用别的站点回答，与「这是某站点的专属 Agent」直接冲突。
 */

import { randomUUID } from 'node:crypto'
import { tryIntelligentQueryRoute } from './api-query-router/index.js'
import type { ChannelPermissionMode } from './channels/channel-permissions.js'
import type { ContentBlock, Message } from './works-store.js'
import { appendWorkLog } from './work-log-file.js'
import type { DirectRouteOutcome } from './webcli-route.js'

/** 路由命中后回落的耗时与自描述字段（供 timing 块落库与 UI 识别）。 */
export interface RoutedTiming {
  totalMs: number
  llmMs: number
  execMs: number
  steps: number
  /** 命中的工具全名；非空即表示这一轮是 fast-path 回合。 */
  routeTool: string
  routeSource?: string
  routeArgs?: string
}

export interface RoutedTurnResult {
  /** Per-turn handoff to the Agent when direct routing does not answer. */
  directRoute?: DirectRouteOutcome
  /** true = 已被确定性层接走，调用方**不得**再调用 `streamChat`。 */
  handled: boolean
  /** 命中时渲染出的 markdown 正文；未命中恒为空串。 */
  text: string
  /** 命中时的 timing（含 `routeTool`）；调用方负责决定是否落库。 */
  timing: RoutedTiming | null
}

export interface RoutedTurnInput {
  /** 本轮用户输入原文（定时任务是 `prompt_template`，渠道是最后一条 user 消息）。 */
  message: string
  workId: string
  /** 与调用方 `turnTiming` 同一个起点，保证 `totalMs` 口径与普通回合一致。 */
  chatStartTime: number
  /** 日志/Trace 关联用；缺省随机生成。 */
  turnId?: string
  /**
   * **本轮之前**的消息。追问闸门（闸门①b）依赖它区分「那第二个呢」与全新查询；
   * 不传等于闸门①b 对该轮不生效（与接线前的桌面行为一致）。
   */
  history?: Message[]
  log?: (message: string) => void
  /**
   * 路由事件出口：桌面端是 SSE `send`，企微是流式推送，其它入口可以不传。
   * 事件形状与既有 SSE 一致（`turn_start` / `text_delta` / `turn_end`）。
   */
  onEvent?: (event: object) => void
  /**
   * true = 由路由层自己落库（桌面对话的既有行为）；
   * 省略或 false = 调用方用返回的 `text` / `timing` 自己落库（定时任务、渠道）。
   */
  persist?: boolean
  /**
   * 渠道权限级别。`qa_only` 的回合连工具都不注册，这里据此**直接跳过路由**，
   * 避免访客拿到一条模型自身没有的工具通道。
   */
  channelPermissionMode?: ChannelPermissionMode
}

function isQaOnly(mode: ChannelPermissionMode | undefined): boolean {
  return mode === 'qa_only'
}

/** 从路由事件里抽取正文与 timing——两个非持久化调用方都只需要这两样。 */
function toRoutedTiming(event: Record<string, unknown>): RoutedTiming | null {
  const routeTool = typeof event.routeTool === 'string' ? event.routeTool : ''
  if (!routeTool) return null
  return {
    totalMs: Number(event.totalMs ?? 0),
    llmMs: Number(event.llmMs ?? 0),
    execMs: Number(event.execMs ?? 0),
    steps: Number(event.steps ?? 0),
    routeTool,
    ...(typeof event.routeSource === 'string' ? { routeSource: event.routeSource } : {}),
    ...(typeof event.routeArgs === 'string' ? { routeArgs: event.routeArgs } : {}),
  }
}

/**
 * 尝试用确定性路由回答一轮；`handled === false` 时调用方照常走 `streamChat`。
 *
 * 本函数**永不抛错**：级联内部已把异常收敛为「落回 LLM」，这里再兜一层，
 * 保证任何路由故障都不会让定时任务或渠道回合直接失败。
 */
export async function tryRoutedTurn(input: RoutedTurnInput): Promise<RoutedTurnResult> {
  const miss: RoutedTurnResult = { handled: false, text: '', timing: null, directRoute: { status: 'miss' } }

  if (!input.message?.trim()) return { ...miss, directRoute: { status: 'skipped', reason: 'no_text' } }
  if (isQaOnly(input.channelPermissionMode)) {
    input.log?.('routed turn skipped: qa_only channel cannot dispatch tools')
    return { ...miss, directRoute: { status: 'skipped', reason: 'qa_only' } }
  }

  let text = ''
  let timing: RoutedTiming | null = null
  /** 是否已经把可见输出推给调用方（正文或 turn_end）。推过之后就不许再落回，否则同一条消息答两遍。 */
  let visible = false
  const turnId = input.turnId ?? randomUUID().slice(0, 8)
  appendWorkLog(input.workId, 'route_input', { message: input.message, history: input.history }, turnId)

  const send = (event: object): void => {
    appendWorkLog(input.workId, 'route_event', event, turnId)
    const record = event as Record<string, unknown>
    if (record.type === 'text_delta' && typeof record.content === 'string') text += record.content
    else if (record.type === 'turn_end') timing = toRoutedTiming(record)
    if (record.type === 'text_delta' || record.type === 'turn_end') visible = true
    input.onEvent?.(event)
  }

  let handled = false
  try {
    handled = await tryIntelligentQueryRoute(
      {
        message: input.message,
        workId: input.workId,
        turnId,
        chatStartTime: input.chatStartTime,
        send,
        log: input.log,
        history: input.history,
        onFallback: outcome => { miss.directRoute = outcome },
      },
      // 非持久化调用方：给一个空实现顶掉默认落库，由调用方写自己那份（带各自的
      // timing 口径与 external-write 标记），否则同一条回复会被写两次。
      input.persist ? {} : { persistAssistantMessage: () => {} },
    )
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    appendWorkLog(input.workId, 'route_error', { error: error instanceof Error ? error.stack || reason : reason, visible }, turnId)
    // 已经推流之后再抛错（典型：落库写失败）不能落回——调用方再跑一次 `streamChat`
    // 会让用户看到两条答案。这里保留已产出的正文，由调用方照常收尾。
    if (visible) {
      input.log?.(`routed turn failed after output: ${reason} → keep routed answer, no LLM fallback`)
      return { handled: true, text, timing }
    }
    input.log?.(`routed turn failed: ${reason} → fall back to LLM`)
    miss.directRoute = { status: 'failed', reason: 'direct_route_error' }
    return miss
  }

  if (!handled) {
    appendWorkLog(input.workId, 'route_end', { handled: false }, turnId)
    // 落回时清掉半成品，避免调用方误以为有答案（级联某些层可能已推过流）。
    return miss
  }
  appendWorkLog(input.workId, 'route_end', { handled: true }, turnId)
  return { handled: true, text, timing }
}

/**
 * 把路由结果转成落库用的 `ContentBlock[]`（正文 + 带 `routeTool` 的 timing）。
 * 非持久化调用方用它保持与桌面对话同一形态，UI 与追问闸门都能识别 fast-path 回合。
 */
export function routedAssistantBlocks(result: RoutedTurnResult): ContentBlock[] {
  if (!result.handled) return []
  const blocks: ContentBlock[] = []
  if (result.text) blocks.push({ type: 'text', text: result.text })
  if (result.timing) blocks.push({ type: 'timing', ...result.timing })
  return blocks
}

/**
 * 取「本轮之前」的历史：渠道与定时任务拿到的 `messages` 都含本轮 user 消息。
 * 只按尾部一条裁，不做其它猜测。
 */
export function historyBeforeLastUser(messages: Message[] | undefined): Message[] | undefined {
  if (!messages?.length) return undefined
  const last = messages[messages.length - 1]
  return last?.role === 'user' ? messages.slice(0, -1) : messages
}

/**
 * 渠道入口用：取**最后一条消息**的 user 正文；不是 user、或没有正文时返回空串。
 *
 * 刻意只看最后一条、不向前回溯：渠道的当前回合永远是尾条消息，向前找会把**上一轮**
 * 的问题当成这一轮去路由——用户明明发的是附件或空消息，却收到上一条的答案。
 * 拿不到正文就返回空串，调用方按「不路由」处理（漏判免费）。
 */
export function lastUserMessageText(messages: Message[] | undefined): string {
  const last = messages?.[messages.length - 1]
  if (!last || last.role !== 'user') return ''
  return (last.content ?? [])
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim()
}
