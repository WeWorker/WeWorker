/**
 * siteGate：第3层聚焦的保守站点门（`docs/intelligent_routing_design.md` §2 第 14 行）。
 *
 * 职责：确定性快路（第 0/1/2 层）未命中、进入 `streamChat` 之前，按**强信号**识别消息指向的
 * 站点；命中唯一站点时预注入该 adapter 的精简工具清单，省掉「激活 Skill」一整轮推理。
 * 未命中／歧义 → 零行为变化（维持第3层现状，漏判免费）；本判定同时是 第3层/第4层 的分流点
 * （`tier4-dispatch.ts` 只在 `reason === 'miss'` 时才考虑转交）。
 *
 * 信号（保守，两类）：
 * - S1 域名/IP 子串：manifest 的 `match` 数组，直接子串命中；
 * - S2 manifest 可选 `gate_aliases`：拉丁词按 ASCII 字母数字判边界（`XXTICKETSYY` 不命中 `tickets`，
 *   而 `在 tickets 上` 命中），CJK 词直接子串。
 * 站点名**不做**自动信号（「内部文档」这类通用词误判风险高）。
 *
 * 急停：`WEWORKER_SITE_GATE=0`（与 `WEWORKER_SCENARIO_ROUTE` 同机制）。
 */
import { parseAllAdapters, type ParsedAdapter, type StaticToolDef } from './adapter-parser.js'
import { findAdaptersDirectory, resolveToolsForAdapter } from './adapter-tool-list.js'

export type SiteGateReason = 'hit-domain' | 'hit-alias' | 'miss' | 'ambiguous' | 'disabled'

export interface SiteGateCandidate {
  id: string
  name: string
  match: string[]
  gateAliases?: string[]
}

export interface SiteGateResult {
  /** 命中的 adapter id；null = miss/ambiguous/disabled。 */
  adapterId: string | null
  reason: SiteGateReason
  /** 调试信号：命中的信号词（hit）或全部命中信号（ambiguous，形如 `id(signal)`）。 */
  signals: string[]
}

export function isSiteGateEnabled(): boolean {
  return process.env.WEWORKER_SITE_GATE !== '0'
}

/** 拉丁/数字信号按 ASCII 字母数字判词边界（`XXTICKETSYY` 不命中 `tickets`，`在 tickets 上` 命中）；CJK 信号直接子串。 */
function signalInText(signal: string, lowerText: string): boolean {
  if (/^[\w.-]+$/.test(signal)) {
    const escaped = signal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^a-z0-9])${escaped}(?![a-z0-9])`).test(lowerText)
  }
  return lowerText.includes(signal)
}

export function matchSiteAdapter(
  message: string,
  candidates: SiteGateCandidate[],
  enabledIds: Set<string>,
): SiteGateResult {
  if (!isSiteGateEnabled()) return { adapterId: null, reason: 'disabled', signals: [] }
  const text = String(message || '').toLowerCase()
  if (!text.trim()) return { adapterId: null, reason: 'miss', signals: [] }

  const hits = new Map<string, { reason: 'hit-domain' | 'hit-alias'; signal: string }>()
  for (const c of candidates) {
    if (!enabledIds.has(c.id)) continue
    for (const domain of c.match ?? []) {
      const d = String(domain || '').trim().toLowerCase()
      if (d && text.includes(d)) {
        hits.set(c.id, { reason: 'hit-domain', signal: d })
        break
      }
    }
  }
  // 别名仅在域名未命中的候选上补查（域名优先级更高，且避免同一候选重复计数）。
  for (const c of candidates) {
    if (hits.has(c.id) || !enabledIds.has(c.id)) continue
    for (const alias of c.gateAliases ?? []) {
      const a = String(alias || '').trim().toLowerCase()
      if (!a) continue
      if (signalInText(a, text)) {
        hits.set(c.id, { reason: 'hit-alias', signal: a })
        break
      }
    }
  }

  if (hits.size === 0) return { adapterId: null, reason: 'miss', signals: [] }
  if (hits.size > 1) {
    // 歧义一律不动手：命中多个站点时预注入哪一份都是猜，猜错就是用错工具清单。
    return {
      adapterId: null,
      reason: 'ambiguous',
      signals: [...hits.entries()].map(([id, h]) => `${id}(${h.signal})`).sort(),
    }
  }
  const [[id, h]] = hits
  return { adapterId: id, reason: h.reason, signals: [h.signal] }
}

/** 预注入工具清单：`prompt` 为注入文本，`toolCount` 为实际写入数，`total` 为该 adapter 全量工具数。 */
export interface SiteToolkit {
  prompt: string
  toolCount: number
  total: number
}

const MAX_TOOLS = 30
const MAX_PROMPT_CHARS = 8_000

function isDirectTool(tool: StaticToolDef): boolean {
  return Boolean(tool.directCapable) || tool.executionMode === 'direct'
}

function formatToolLine(tool: StaticToolDef): string {
  const params = (tool.parameters ?? {}) as {
    properties?: Record<string, { type?: string }>
  }
  const properties = params.properties ?? {}
  const names = Object.keys(properties).slice(0, 8)
  const paramText = names.length
    ? `。参数：${names.map((n) => `${n}（${properties[n]?.type ?? 'string'}）`).join('、')}`
    : ''
  // navigate_before 工具与 page-prep 同源声明：第3层首轮即知「先开页面再调用」，
  // 省一次鉴权失败重试。等待语义随 page-prep 事件化：open_browser 阻塞至工具就绪信号才返回
  // （仅 toolsReady: false 时需等 5 秒）。
  const nav = typeof tool.execution?.navigate_before === 'string' ? tool.execution.navigate_before.trim() : ''
  const navText = nav ? `。需先 open_browser ${nav}（返回即可调用；返回 toolsReady: false 时等 5 秒）` : ''
  const confirmationText = tool.safety === 'write' && tool.requiresConfirmation === false
    ? '。无需显式确认；用户请求且参数明确时直接调用，不要要求用户手动执行或传入 __confirmed'
    : ''
  const desc = String(tool.description || '').replace(/\s+/g, ' ').trim()
  return `- \`${tool.name}\`：${desc || '（说明见该站点 Skill 文档）'}${paramText}${navText}${confirmationText}`
}

export function formatSiteToolkitPrompt(
  adapter: { name: string; match: string[] },
  tools: StaticToolDef[],
): SiteToolkit {
  const byName = (a: StaticToolDef, b: StaticToolDef) => a.name.localeCompare(b.name)
  // direct 组在前（与系统提示「API 工具必须直接调用」规则对齐），组内按名排序。
  const ordered = [
    ...tools.filter((t) => isDirectTool(t)).sort(byName),
    ...tools.filter((t) => !isDirectTool(t)).sort(byName),
  ]
  const shown = ordered.slice(0, MAX_TOOLS)

  const header = [
    `## 站点工具速查：${adapter.name}（${adapter.match[0] ?? ''}）`,
    '',
    '系统已根据用户消息识别出该站点；以下工具清单已预载，无需再激活该站点的 Skill，可直接执行：`webcli call <完整工具名> --参数名=参数值`（本节不改变任何既有调用规则）。',
    '',
  ]
  let body: string[] = []
  const sections: Array<[string, StaticToolDef[]]> = [
    ['direct（API 后台工具；标注「需先 open_browser」的工具例外，先开页面、open_browser 返回即可调用）：', shown.filter((t) => isDirectTool(t))],
    ['page（页面/DOM 工具，需先 open_browser 该站点）：', shown.filter((t) => !isDirectTool(t))],
  ]
  for (const [label, list] of sections) {
    if (!list.length) continue
    body.push(`**${label}**`)
    for (const t of list) body.push(formatToolLine(t))
  }
  // 字符上限兜底：从尾部整行丢弃（不截半个 markdown 结构）；MAX_TOOLS 正常路径不会走到这里。
  while (body.join('\n').length > MAX_PROMPT_CHARS && body.length) body = body.slice(0, -1)
  const shownCount = body.filter((line) => line.startsWith('- ')).length
  const omitted = ordered.length - shownCount

  const prompt = [
    ...header,
    ...body,
    ...(omitted > 0 ? [`（其余 ${omitted} 个工具见该站点 Skill 文档，如需可再激活 Skill。）`] : []),
  ]
    .join('\n')
    .trim()
  return { prompt, toolCount: shownCount, total: ordered.length }
}

const toolkitCache = new Map<string, { toolkit: SiteToolkit | null; at: number }>()
const TOOLKIT_TTL_MS = 5 * 60_000

export function clearSiteToolkitCache(): void {
  toolkitCache.clear()
}

/**
 * 解析 adapter 的预注入工具清单（TTL 缓存，含 0 工具负缓存）。
 * 缓存原因：`resolveToolsForAdapter()` 无缓存、每次读盘，而 siteGate 每 chat 一调；
 * adapter 热更新最长 TTL 后自动生效。
 */
export function resolveSiteToolkitPrompt(adapterId: string): SiteToolkit | null {
  const now = Date.now()
  const cached = toolkitCache.get(adapterId)
  if (cached && now - cached.at < TOOLKIT_TTL_MS) return cached.toolkit

  const adapter: ParsedAdapter | undefined = parseAllAdapters().get(adapterId)
  let toolkit: SiteToolkit | null = null
  if (adapter) {
    const tools = resolveToolsForAdapter(adapter, findAdaptersDirectory())
    toolkit = tools.length ? formatSiteToolkitPrompt(adapter, tools) : null
  }
  toolkitCache.set(adapterId, { toolkit, at: now })
  return toolkit
}
