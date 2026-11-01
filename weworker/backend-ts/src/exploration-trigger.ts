/**
 * 第 4 层（网站探索agent）的**触发契约**：把「消息里像不像有个未注册域名」换成
 * 「用户是不是用固定接口明确要求探索」。
 *
 * 为什么必须换：旧判定（`extractUnknownSiteUrl` + `siteGate miss`）是纯启发式——顺手贴一个
 * 链接的普通对话也会整轮被探索流顶掉，而探索成功后的固化会替换已安装的包。误触发不只是
 * 「答错一次」，还可能覆盖掉已有的确定性工具。按 `docs/intelligent_routing_architecture.md`
 * 的红线（漏判免费、误判致命），这里只认显式指令。
 *
 * 唯一合法句式（接口即契约，不做同义词扩展）：
 *
 *     网站 <URL> 直接查询：<问题>
 *
 * 四个成分缺一不可：站点标记词、URL、查询标记词、非空问题。另留一条显式强制档
 * `!explore <URL> <问题>`：它跳过「站点已有工具就不许探索」的覆盖校验，其余急停照旧生效
 * （`WEWORKER_TIER4=0`、健康检查、只读护栏）。这是唯一一条能重探已固化站点的入口，必须由
 * 用户亲手写出来，不参与任何猜测。
 *
 * **整串必须被消费**：URL 之后到查询标记词之间只允许空白。这条规则直接来自
 * `http://example.com/查询xxx` 的存量事故——URL 在中文处截止后，`查询xxx` 成为无人认领的
 * 残片，此处一律判 `ambiguous-url-boundary` 落回 LLM，绝不替用户猜测那句话属于路径还是问题。
 * 真要中文路径，写 `<http://example.com/查询xxx>`。
 */
import { isSiteLikeUrl, scanUrlTokens } from './exploration-url.js'

export interface ExplorationTriggerTokens {
  /** 站点标记词（默认只认 `网站`）。加词等于扩大触发面，属配置级决定。 */
  siteTokens: string[]
  /** 查询标记词（默认只认 `直接查询`），其后必须跟冒号。 */
  queryTokens: string[]
  /** 是否接受 `!explore <url> <query>` 强制档。 */
  allowBang: boolean
}

export const DEFAULT_EXPLORATION_TRIGGER: ExplorationTriggerTokens = {
  siteTokens: ['网站'],
  queryTokens: ['直接查询'],
  allowBang: true,
}

/** 触发失败的具体原因。区分到这一层是为了让日志能回答「为什么没走第 4 层」。 */
export type ExplorationTriggerReason =
  /** 不是以站点标记词开头的探索指令 */
  | 'not-site-command'
  /** 有站点标记词但没给 URL */
  | 'missing-url'
  /** URL 边界有无人认领的残片（典型：中文被截断后剩下的半句话） */
  | 'ambiguous-url-boundary'
  /** 缺查询标记词，或标记词后没跟冒号 */
  | 'missing-query-marker'
  /** 问句为空 */
  | 'empty-query'

export interface ExplorationRequest {
  startUrl: string
  query: string
  /** true = `!explore` 显式强制，跳过覆盖校验 */
  force: boolean
  form: 'prose' | 'bang'
}

export type ExplorationTriggerResult =
  | { ok: true; request: ExplorationRequest }
  | { ok: false; reason: ExplorationTriggerReason }

const BANG_RE = /^!\s*explore\b/i
const POLITE_PREFIX_RE = /^(?:请帮我|请|帮我|麻烦)/

function isColon(char: string): boolean {
  return char === ':' || char === '：'
}

function trimLeadingColon(text: string): string {
  return isColon(text[0] ?? '') ? text.slice(1).trimStart() : text
}

function parseBang(text: string): ExplorationTriggerResult {
  const rest = text.replace(BANG_RE, '').trim()
  if (!rest) return { ok: false, reason: 'missing-url' }
  const tokens = scanUrlTokens(rest)
  const urlToken = tokens.find((token) => token.start === 0)
  if (!urlToken) return { ok: false, reason: tokens.length ? 'ambiguous-url-boundary' : 'missing-url' }
  // 顶层域是文件扩展名（`v1.2.zip`）的不算站点，不给执行器派一个打不开的起点。
  if (!isSiteLikeUrl(urlToken.url)) return { ok: false, reason: 'missing-url' }
  const query = rest.slice(urlToken.end).trim()
  if (!query) return { ok: false, reason: 'empty-query' }
  return { ok: true, request: { startUrl: urlToken.url, query, force: true, form: 'bang' } }
}

function parseProse(text: string, tokens: ExplorationTriggerTokens): ExplorationTriggerResult {
  let rest = text
  const prefix = POLITE_PREFIX_RE.exec(rest)
  if (prefix) rest = rest.slice(prefix[0].length).trimStart()

  const siteToken = tokens.siteTokens.find((token) => token && rest.startsWith(token))
  if (!siteToken) return { ok: false, reason: 'not-site-command' }
  rest = trimLeadingColon(rest.slice(siteToken.length).trimStart())

  const urlTokens = scanUrlTokens(rest)
  const urlToken = urlTokens.find((token) => token.start === 0)
  if (!urlToken) return { ok: false, reason: urlTokens.length ? 'ambiguous-url-boundary' : 'missing-url' }
  if (!isSiteLikeUrl(urlToken.url)) return { ok: false, reason: 'missing-url' }

  const tail = rest.slice(urlToken.end).trimStart()
  const queryToken = tokens.queryTokens.find((token) => token && tail.startsWith(token))
  // URL 后面既不是空白也不是查询标记词：这就是「中文被 URL 吞掉」之后剩下的残片。
  if (!queryToken) return { ok: false, reason: tail ? 'ambiguous-url-boundary' : 'missing-query-marker' }

  const afterMarker = tail.slice(queryToken.length).trimStart()
  if (!isColon(afterMarker[0] ?? '')) return { ok: false, reason: 'missing-query-marker' }
  const query = afterMarker.slice(1).trimStart()
  if (!query) return { ok: false, reason: 'empty-query' }

  return { ok: true, request: { startUrl: urlToken.url, query, force: false, form: 'prose' } }
}

/**
 * 解析显式探索指令。不命中返回结构化原因，**不抛异常**（调用方每回合都会跑它）。
 */
export function parseExplorationTrigger(
  message: string,
  tokens: ExplorationTriggerTokens = DEFAULT_EXPLORATION_TRIGGER,
): ExplorationTriggerResult {
  const text = String(message ?? '').trim()
  if (!text) return { ok: false, reason: 'not-site-command' }
  if (BANG_RE.test(text)) {
    return tokens.allowBang ? parseBang(text) : { ok: false, reason: 'not-site-command' }
  }
  return parseProse(text, tokens)
}
