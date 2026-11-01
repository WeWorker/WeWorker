/**
 * 第4层分流与即时执行转发（`docs/intelligent_routing_architecture.md` §7）。
 *
 * 分流判定（`decideExplorationDispatch`，纯函数）：**显式触发契约**命中 **且** 未被站点覆盖
 * **且** 该执行器急停未关。任一不成立 → 落回第3层/LLM（漏判免费）。
 *
 * 与旧判定的差别（旧判定见文末 `decideTier4`，仅作回滚保留）：
 *   - 旧判定只看「消息里有没有一个未注册域名」，顺手贴链接的普通对话也会被整轮顶掉；
 *   - 新判定只认 `网站 <URL> 直接查询：<问题>`（或 `!explore <URL> <问题>`），并且先查
 *     **站点覆盖集**（adapter + 探索固化的 toolkit），已有确定性工具的站点一律不再探索——
 *     重探的固化会替换目标目录，等于覆盖用户已有工具。
 *
 * 执行（`runWebwrightTaskTurn`）：网站探索agent任务事件 → 既有 chat `SSEEvent` 序列；
 * 超时/中止取消任务；`waiting_for_user` 引导去网站探索agent UI 接管（不是错误）。
 *
 * UI 与用户可见文案统一写「网站探索agent」，不出现内部组件名（见 AGENTS.md 红线）。
 */
import type { SSEEvent } from './agent.js'
import type { SiteGateResult } from './site-gate.js'
import type { ParsedAdapter } from './adapter-parser.js'
import { hostOf, isFileExtensionHost, scanUrlTokens } from './exploration-url.js'
import { isHostCovered, type SiteCoverage } from './exploration-coverage.js'
import { parseExplorationTrigger } from './exploration-trigger.js'
import { orderedExplorationProviders, type ExplorationProvider } from './exploration-providers.js'
import {
  cancelWebwrightTask,
  createWebwrightTask,
  fetchWebwrightTask,
  openWebwrightTaskEvents,
  type WebwrightClientDeps,
} from './webwright-client.js'

export const WEBWRIGHT_UI_URL = 'http://127.0.0.1:8766/ui'

/**
 * 任务入口链接文案：URL **独立成行**，括号说明另起一行。
 *
 * 为什么不能把 URL 嵌进中文句子：聊天里的自动链接与系统「打开外部链接」会把紧贴 URL 的中文
 * 一并吞进 URL——实测 2026-10-12 用户点开失败文案里的入口，服务端收到的是
 * `/ui%EF%BF%BD…`（URL 后紧跟的全角「（任务」被按单字节解码成替换字符）→ 404，轨迹入口失效。
 * 故凡输出该链接处一律经此函数，URL 两侧只留行边界，绝不与中文直接相邻。
 *
 * 括号行只写**事实**：`/ui` 是 Adapter 工作台（站点能力固化入口），不展示这一次聊天任务的
 * 逐步轨迹，所以不能承诺「查看逐步轨迹/截图」。
 */
function taskLink(taskId: string): string {
  return `${WEBWRIGHT_UI_URL}\n（任务 ${taskId}；该入口是 Adapter 工作台，可把常用站点固化成工具）`
}

// ─── 站点信号提取（纯）────────────────────────────────────────────────────

/**
 * 提取消息指向的第一个「未注册站点」URL（归一化为含 scheme 的 start_url）；无信号/均为已知站点 → null。
 * 已知站点 = 任何已注册 adapter 的 `match` 条目（含禁用——用户禁用的站点不得绕道第4层复活）。
 *
 * **只认原文里最先出现的站点信号**：消息里先出现已注册站点时，视为「用户当下说的是这个站点」，
 * 不再去找后面的未注册域名（扩大转发面只会增加误触发）。URL 边界统一由 `scanUrlTokens` 处理：
 * `http://example.com/查询公告` 的 URL 是 `http://example.com/`，不会连着半句话一起成为起点。
 * 文件扩展名顶层域（`v1.2.zip`）不算站点信号。
 *
 * 本函数现在只服务回滚路径（`WEWORKER_EXPLORATION_TRIGGER=legacy`）；正式判定走
 * `decideExplorationDispatch` 的显式触发契约。
 */
export function extractUnknownSiteUrl(message: string, knownHosts: Set<string>): string | null {
  for (const token of scanUrlTokens(String(message ?? ''))) {
    const host = hostOf(token.url)
    if (!host) continue
    if (isFileExtensionHost(host)) continue
    if (knownHosts.has(host)) continue
    return token.url
  }
  return null
}

export function buildKnownHosts(allAdapters: Map<string, ParsedAdapter>): Set<string> {
  const hosts = new Set<string>()
  for (const adapter of allAdapters.values()) {
    for (const match of adapter.match ?? []) {
      const host = hostOf(`https://${String(match)}`)
      if (host) hosts.add(host)
    }
  }
  return hosts
}

// ─── 分流判定（纯）────────────────────────────────────────────────────────

export interface Tier4Decision {
  dispatch: boolean
  /** `dispatch=true` 时的起点 URL。 */
  startUrl: string | null
  /** 观测/调试用：不转发的判定原因。 */
  reason: string
}

/**
 * 不转发的原因。区分到这一层是为了让「这条为什么没走第 4 层」有唯一答案：
 * `not-explicit`（不是探索指令）、`ambiguous-url-boundary`（URL 边界有残片）、
 * `covered-by-*`（站点已有确定性能力）、`sitegate-*`（站点门已命中）。
 */
export type ExplorationDispatchReason =
  | 'env-off'
  | 'not-explicit'
  | 'missing-url'
  | 'ambiguous-url-boundary'
  | 'missing-query-marker'
  | 'empty-query'
  | 'covered-by-adapter'
  | 'covered-by-toolkit'
  | 'explicit-trigger'
  | 'force-trigger'
  | 'legacy-unknown-site'

export interface ExplorationDispatchDecision {
  dispatch: boolean
  /** 命中的执行器 id（不转发时为 null）。 */
  providerId: string | null
  startUrl: string | null
  /** 交给执行器的问题正文（不转发时为 null）。 */
  query: string | null
  /** true = `!explore` 显式强制，跳过了站点覆盖校验。 */
  force: boolean
  reason: ExplorationDispatchReason | string
}

export type ExplorationTriggerMode = 'strict' | 'legacy'

/**
 * 触发契约版本。`legacy` = 改动前的启发式判定（消息含未注册站点 URL 即转交），只作回滚用；
 * 缺省 `strict`。用环境变量而不是配置项：它是事故时的止血阀，不能依赖读盘成功。
 */
export function explorationTriggerMode(env: NodeJS.ProcessEnv = process.env): ExplorationTriggerMode {
  return String(env.WEWORKER_EXPLORATION_TRIGGER ?? '').trim().toLowerCase() === 'legacy' ? 'legacy' : 'strict'
}

export interface ExplorationDispatchInput {
  message: string
  siteGate: SiteGateResult
  /** 站点覆盖集（已安装 adapter + 探索固化的 toolkit） */
  coverage: SiteCoverage
  /** 注册表；缺省用随包默认表 */
  providers?: readonly ExplorationProvider[]
  /** 触发契约版本；缺省读 env */
  mode?: ExplorationTriggerMode
  /** 回滚路径判断「已注册站点」用 */
  knownHosts?: ReadonlySet<string>
  env?: NodeJS.ProcessEnv
}

function skip(reason: ExplorationDispatchReason | string): ExplorationDispatchDecision {
  return { dispatch: false, providerId: null, startUrl: null, query: null, force: false, reason }
}

/**
 * 第 4 层分流判定（纯函数，不派发、不读盘）。
 *
 * 严格模式的两道条件**同时**成立才转交：
 *   ① 显式触发契约命中——`网站 <URL> 直接查询：<问题>`，或 `!explore <URL> <问题>`；
 *   ② 站点未被覆盖——adapter / 探索固化的 toolkit 都没有接管它（`!explore` 显式豁免这一条，
 *      因为那是用户亲手要求重探，且是唯一能更新既有固化包的入口）。
 *
 * 顺序也重要：先判触发再判覆盖。反过来的话，`网站 https://已覆盖站点 直接查询：…` 会以
 * 「已覆盖」为由静默落回 LLM，用户看不出自己写的指令被谁的规则吃掉了。
 */
export function decideExplorationDispatch(
  input: ExplorationDispatchInput,
): ExplorationDispatchDecision {
  const env = input.env ?? process.env
  const mode = input.mode ?? explorationTriggerMode(env)
  if (mode === 'legacy') return decideLegacyDispatch(input, env)

  const providers = orderedExplorationProviders(input.providers)
  if (!providers.length) return skip('not-explicit')

  let reason: ExplorationDispatchReason | string = 'not-explicit'
  for (const provider of providers) {
    if (env[provider.killSwitchEnv] === '0') {
      reason = 'env-off'
      continue
    }
    const trigger = parseExplorationTrigger(input.message, provider.trigger)
    if (!trigger.ok) {
      reason = trigger.reason
      continue
    }
    if (!trigger.request.force) {
      if (input.siteGate.reason !== 'miss') return skip(`sitegate-${input.siteGate.reason}`)
      const covered = isHostCovered(trigger.request.startUrl, input.coverage)
      if (covered.covered) return skip(`covered-by-${covered.by}`)
    }
    return {
      dispatch: true,
      providerId: provider.id,
      startUrl: trigger.request.startUrl,
      query: trigger.request.query,
      force: trigger.request.force,
      reason: trigger.request.force ? 'force-trigger' : 'explicit-trigger',
    }
  }
  return skip(reason)
}

/** 回滚路径：改动前的启发式判定，逐字保留其语义（含「整条消息作为指令」）。 */
function decideLegacyDispatch(
  input: ExplorationDispatchInput,
  env: NodeJS.ProcessEnv,
): ExplorationDispatchDecision {
  if (env.WEWORKER_TIER4 === '0') return skip('env-off')
  // 显式 CLI 请求属于 chat Agent，它自己持有 exploration.*；这里不能截走整轮。
  // 漏判只保住 chat，绝不会授予工具权限。
  if (/\bwebcli\b|\bexploration\.[a-z-]+\b|\bbrowser\.open\b/i.test(input.message)) return skip('explicit-webcli')
  if (input.siteGate.reason !== 'miss') return skip(`sitegate-${input.siteGate.reason}`)
  const startUrl = extractUnknownSiteUrl(input.message, new Set(input.knownHosts ?? []))
  if (!startUrl) return skip('no-unknown-site-signal')
  return {
    dispatch: true,
    providerId: 'webwright',
    startUrl,
    query: input.message,
    force: false,
    reason: 'legacy-unknown-site',
  }
}

/**
 * @deprecated 回滚入口，等价于 `WEWORKER_EXPLORATION_TRIGGER=legacy`。
 * 新代码一律用 `decideExplorationDispatch`；保留本函数只为让旧回归用例与旧调用方不炸。
 */
export function decideTier4(
  message: string,
  siteGate: SiteGateResult,
  allAdapters: Map<string, ParsedAdapter>,
): Tier4Decision {
  const decision = decideLegacyDispatch(
    { message, siteGate, coverage: { hosts: new Map() }, knownHosts: buildKnownHosts(allAdapters) },
    process.env,
  )
  return { dispatch: decision.dispatch, startUrl: decision.startUrl, reason: decision.reason }
}

// ─── 即时执行回合（async generator）──────────────────────────────────────

export function isTier4Enabled(): boolean {
  return process.env.WEWORKER_TIER4 !== '0'
}

export function tier4TimeoutMs(): number {
  const raw = Number(process.env.WEWORKER_TIER4_TIMEOUT_MS || '')
  return Number.isFinite(raw) && raw >= 30_000 ? raw : 10 * 60_000
}

const READ_ONLY_GUARD =
  '（系统护栏：本次为客户端自动转交的任务，请只做浏览与信息获取，不要执行提交、下单、发送、删除等写入操作；若任务必须写入，请暂停并等待用户接管。）'

export function buildTier4Instruction(message: string): string {
  if (process.env.WEWORKER_TIER4_ALLOW_WRITES === '1') return message
  return `${message}\n\n${READ_ONLY_GUARD}`
}

/**
 * 建任务（成功才进入执行流）。失败返回 `{ok:false}`，调用方落回第3层。
 * 与 `runWebwrightTaskTurn` 分离：调用方需要在「换事件源」之前知道建任务结果。
 */
export async function openTier4Turn(input: {
  message: string
  startUrl: string
  title?: string
  abortSignal?: AbortSignal
  deps?: WebwrightClientDeps
  now?: () => number
}): Promise<{ ok: true; taskId: string; run: AsyncGenerator<SSEEvent> } | { ok: false; code: string; message: string }> {
  const created = await createWebwrightTask(
    { instruction: buildTier4Instruction(input.message), startUrl: input.startUrl, title: input.title },
    input.deps,
  )
  if (!created.ok) return { ok: false, code: created.code, message: created.message }
  return {
    ok: true,
    taskId: created.taskId,
    run: runWebwrightTaskTurn({
      taskId: created.taskId,
      startUrl: input.startUrl,
      abortSignal: input.abortSignal,
      deps: input.deps,
      now: input.now,
    }),
  }
}

export async function* runWebwrightTaskTurn(input: {
  taskId: string
  startUrl: string
  abortSignal?: AbortSignal
  deps?: WebwrightClientDeps
  now?: () => number
}): AsyncGenerator<SSEEvent> {
  const now = input.now ?? Date.now
  const taskId = input.taskId
  const link = taskLink(taskId)
  // 起点同样独立成行：URL 后面紧跟全角括号时会被链接器吞进去（同 taskLink 的成因）。
  yield {
    type: 'text_delta',
    content: `已识别出尚未接入的站点，转交网站探索agent执行本次请求。\n起点：${input.startUrl}\n\n`,
  }

  const opened = await openWebwrightTaskEvents(taskId, input.deps)
  if (!opened.ok) {
    await cancelWebwrightTask(taskId, input.deps)
    yield {
      type: 'text_delta',
      content: `任务事件流打开失败（${opened.reason}），已取消本次任务。原始请求请稍后重试，或直接在浏览器打开：\n${WEBWRIGHT_UI_URL}`,
    }
    return
  }

  const deadline = now() + tier4TimeoutMs()
  let lastStep = 0
  try {
    for await (const ev of opened.events) {
      if (input.abortSignal?.aborted) break
      if (now() > deadline) {
        await cancelWebwrightTask(taskId, input.deps)
        yield {
          type: 'text_delta',
          content: `\n\n任务超过时限（${Math.round(tier4TimeoutMs() / 60_000)} 分钟），已请求取消；如需继续：\n${link}`,
        }
        return
      }
      const data = ev.data ?? {}
      if (ev.event === 'step_finished') {
        const step = Number(data.step ?? 0)
        if (step > lastStep) {
          lastStep = step
          yield { type: 'text_delta', content: `[执行] 步骤 ${step} 完成\n` }
        }
      } else if (ev.event === 'task_started') {
        yield { type: 'text_delta', content: `[执行] 浏览器已启动，开始执行…\n` }
      } else if (ev.event === 'waiting_for_user') {
        yield { type: 'text_delta', content: `\n\n任务已暂停，等待人工接管。请在以下入口完成所需操作后继续：\n${link}` }
        return
      } else if (ev.event === 'task_succeeded') {
        const task = await fetchWebwrightTask(taskId, input.deps)
        const final = String(task?.final_response ?? '').trim()
        yield {
          type: 'text_delta',
          content: final
            ? `\n\n${final}\n\n---\n（以上由网站探索agent完成，共 ${task?.current_step ?? lastStep} 步）\n${link}`
            : `\n\n任务已完成（${task?.current_step ?? lastStep} 步），但未生成总结。详情：\n${link}`,
        }
        return
      } else if (ev.event === 'task_failed' || ev.event === 'task_cancelled') {
        const task = await fetchWebwrightTask(taskId, input.deps)
        const detail = String(task?.error ?? '').trim() || ev.event
        yield { type: 'text_delta', content: `\n\n任务未完成（${detail}）。\n可在以下入口查看，或换一种问法再让我处理：\n${link}` }
        return
      }
      // pause_requested / cancel_requested / 其他中间态：不打扰用户，继续等待。
    }
    // 用户中止：静默返回（对齐 streamChat 的 AbortError 语义），取消交给 finally。
    if (input.abortSignal?.aborted) return
    // 事件流意外关闭且未收到停态：拉一次任务视图定性。
    const task = await fetchWebwrightTask(taskId, input.deps)
    const status = task?.status ?? 'unknown'
    if (status === 'succeeded') {
      const final = String(task?.final_response ?? '').trim()
      yield { type: 'text_delta', content: `\n\n${final || '任务已完成。'}\n\n---\n${link}` }
    } else {
      await cancelWebwrightTask(taskId, input.deps)
      yield { type: 'text_delta', content: `\n\n任务进度流中断（状态 ${status}），已请求取消；如需继续：\n${link}` }
    }
  } finally {
    // 用户中止：尽力取消远端任务，避免浏览器继续空转。
    if (input.abortSignal?.aborted) await cancelWebwrightTask(taskId, input.deps)
  }
}
