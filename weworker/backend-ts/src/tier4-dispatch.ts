/**
 * 第4层分流与即时执行转发（`docs/intelligent_routing_design.md` §2 第 15 行）。
 *
 * 分流判定（`decideTier4`，纯函数）：siteGate miss **且** 消息含未注册站点的 URL/域名信号
 * **且** env 急停未关。任一不成立 → 第3层（今天的行为；漏判免费）。
 *
 * 执行（`runWebwrightTaskTurn`）：网站探索agent任务事件 → 既有 chat `SSEEvent` 序列；
 * 超时/中止取消任务；`waiting_for_user` 引导去网站探索agent UI 接管（不是错误）。
 *
 * UI 与用户可见文案统一写「网站探索agent」，不出现内部组件名（见 AGENTS.md 红线）。
 */
import type { SSEEvent } from './agent.js'
import type { SiteGateResult } from './site-gate.js'
import type { ParsedAdapter } from './adapter-parser.js'
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

/** TLD 为常见文件扩展名的不算站点信号（防「下载 v1.2.zip」误判）。 */
const FILE_EXTENSION_TLDS = new Set([
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'exe', 'msi', 'dmg', 'pkg', 'apk',
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'ico', 'pdf', 'doc', 'docx',
  'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt', 'md', 'log', 'js', 'ts', 'py',
  'json', 'xml', 'html', 'htm', 'css', 'yaml', 'yml',
])

const URL_RE = /https?:\/\/[^\s<>"'`]+/i
const BARE_DOMAIN_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b(?::\d{2,5})?(?:\/[^\s<>"'`]*)?/i

function stripTrailingPunctuation(raw: string): string {
  return raw.replace(/[.,;:!?()[\]{}<>"'`、。，；！？）】…—-]+$/g, '')
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * 提取消息指向的第一个「未注册站点」URL（归一化为含 scheme 的 start_url）；无信号/均为已知站点 → null。
 * 已知站点 = 任何已注册 adapter 的 `match` 条目（含禁用——用户禁用的站点不得绕道第4层复活）。
 *
 * **只认首个信号**（`URL_RE` / `BARE_DOMAIN_RE` 非全局）：消息里先出现已注册站点时，视为「用户
 * 当下说的是这个站点」，不再去找后面的未注册域名。这是刻意的保守取舍——考虑后续域名只会**扩大**
 * 第4层转发面，而漏判的代价只是落回第3层（设计允许的方向）。
 */
export function extractUnknownSiteUrl(message: string, knownHosts: Set<string>): string | null {
  const text = String(message || '')
  const candidates = [
    ...(text.match(URL_RE) ?? []).map(stripTrailingPunctuation),
    ...(text.match(BARE_DOMAIN_RE) ?? []).map(stripTrailingPunctuation),
  ].filter(Boolean)
  for (const candidate of candidates) {
    const withScheme = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`
    const host = hostOf(withScheme)
    if (!host) continue
    if (FILE_EXTENSION_TLDS.has(host.slice(host.lastIndexOf('.') + 1))) continue
    if (knownHosts.has(host)) continue
    return withScheme
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

export function decideTier4(
  message: string,
  siteGate: SiteGateResult,
  allAdapters: Map<string, ParsedAdapter>,
): Tier4Decision {
  if (process.env.WEWORKER_TIER4 === '0') return { dispatch: false, startUrl: null, reason: 'env-off' }
  if (siteGate.reason !== 'miss') return { dispatch: false, startUrl: null, reason: `sitegate-${siteGate.reason}` }
  const startUrl = extractUnknownSiteUrl(message, buildKnownHosts(allAdapters))
  if (!startUrl) return { dispatch: false, startUrl: null, reason: 'no-unknown-site-signal' }
  return { dispatch: true, startUrl, reason: 'unknown-site' }
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
