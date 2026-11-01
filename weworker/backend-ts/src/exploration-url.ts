/**
 * 探索指令里的 URL 识别（纯函数，零 I/O，零副作用）。
 *
 * 为什么单独成模块：同一个解析要被三处共用——第 4 层分流判定、显式口令解析、回归用例。
 * 三处各写一份正则必然漂移，而这类漂移已经出过事故：**中文被吞进 URL**。旧实现用
 * `/https?:\/\/[^\s<>"'`]+/i` 取 URL，`http://example.com/查询公告` 会整串成为一个 URL，
 * 于是探索起点带着半句话、路径指向一个不存在的中文页面，任务跑偏且没有任何报错。
 *
 * 边界规则（这次修复的核心）：
 *   1. **裸 URL 只吃 ASCII URL 字符**（RFC 3986 的 unreserved / reserved 子集）。遇到任何
 *      非 ASCII 字符（含中文）立即结束。所以 `http://example.com/查询公告` 的 URL 是
 *      `http://example.com/`，`查询公告` 不在 URL 里。
 *   2. **要表达中文路径，用尖括号显式界定**：`<http://example.com/查询公告>`。尖括号是唯一
 *      允许 URL 含中文/空格的写法，也是「用户明确知道自己在给一个中文路径」的信号。
 *   3. **末尾标点剥掉**：`.,;:!?'"` 与不配对的 `)]}` 视为句子标点，不进 URL。
 *      `网站 http://example.com/a;` 与 `…example.com/a。` 都得到 `http://example.com/a`。
 *   4. **多个候选按原文位置排序**，调用方拿到的是「消息里第一个出现的站点信号」，不再
 *      像旧实现那样「先看全部带 scheme 的、再看全部裸域」（那样会把后出现的 URL 当成首选）。
 *
 * 归一化：裸域补 `https://`；host 一律小写。**不做**任何猜测性补全（不加路径、不改大小写
 * 路径、不展开短链）——猜错就等于把任务开到别的页面。
 */

/** 裸 URL 允许的字符集。刻意只到 ASCII：中文/空白/中文标点都从这里结束。 */
const URL_TEXT_CHARS = /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/

/** `<...>` 包裹形式：URL 里可以出现中文，这是唯一的口子。 */
const WRAPPED_RE = /<([^<>\s]+)>/g

const SCHEME_RE = /https?:\/\//gi

/** 主机名（可带端口）。只用于判断「这串东西像不像一个域名」，最终仍以 `new URL()` 为准。 */
const HOST_PREFIX_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}(?::\d{2,5})?/

/**
 * 裸域（可带端口/路径）。前置否定环视避免把 `user@example.com` 的后半段、以及已经落在
 * 其它 token 里的片段当成新站点。
 */
const BARE_HOST_RE =
  /(?<![A-Za-z0-9._@/-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}(?::\d{2,5})?(?:\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]*)?/g

export interface UrlToken {
  /** 归一化后的 URL（裸域补 `https://`，标点已剥离） */
  url: string
  /** 在原文中的起止偏移（`end` 为开区间），用于「整串必须被消费」的判定 */
  start: number
  end: number
  /** 是否来自 `<...>` 包裹形式 */
  wrapped: boolean
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !!parsed.hostname
  } catch {
    return false
  }
}

function countOf(text: string, char: string): number {
  let count = 0
  for (const current of text) if (current === char) count += 1
  return count
}

/** 剥掉句尾标点与不配对的闭括号；`http://example.com/a;` → `http://example.com/a`。 */
export function stripUrlPunctuation(raw: string): string {
  let out = String(raw ?? '')
  for (let guard = 0; guard < 8; guard += 1) {
    const next = out.replace(/[.,;:!?'"`]+$/, '')
    if (next === out) break
    out = next
  }
  const pairs: Array<[string, string]> = [['(', ')'], ['[', ']'], ['{', '}']]
  for (const [open, close] of pairs) {
    while (out.endsWith(close) && countOf(out, open) < countOf(out, close)) out = out.slice(0, -1)
  }
  return out
}

/** 单个候选 → 归一化 URL；不像 URL 返回 null（绝不抛）。 */
export function normalizeUrlCandidate(raw: string): string | null {
  const trimmed = stripUrlPunctuation(String(raw ?? '').trim())
  if (!trimmed) return null
  if (/^https?:\/\//i.test(trimmed)) return isHttpUrl(trimmed) ? trimmed : null
  if (!HOST_PREFIX_RE.test(trimmed)) return null
  const withScheme = `https://${trimmed}`
  return isHttpUrl(withScheme) ? withScheme : null
}

/** 取 host（小写）；解析失败返回空串（绝不抛）。 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * 顶层域是常见文件扩展名的不算站点信号（防「下载 v1.2.zip」「报告.pdf」被当成站点）。
 *
 * 这条判定放在 URL 模块而不是调用方：分流判定与触发契约都必须用它，两处各写一份必然漂移，
 * 而漂移的后果是「探索任务被派到 https://v1.2.zip」这种没人会去排查的怪请求。
 */
const FILE_EXTENSION_TLDS = new Set([
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'exe', 'msi', 'dmg', 'pkg', 'apk',
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'ico', 'pdf', 'doc', 'docx',
  'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt', 'md', 'log', 'js', 'ts', 'py',
  'json', 'xml', 'html', 'htm', 'css', 'yaml', 'yml',
])

/** 该 host 的顶层域是不是文件扩展名（是 → 这不是一个站点）。 */
export function isFileExtensionHost(host: string): boolean {
  const value = String(host ?? '').toLowerCase()
  if (!value) return false
  const tld = value.slice(value.lastIndexOf('.') + 1)
  return FILE_EXTENSION_TLDS.has(tld)
}

/** 该 URL 能不能当作站点起点（有 host 且顶层域不是文件扩展名）。 */
export function isSiteLikeUrl(url: string): boolean {
  const host = hostOf(url)
  return !!host && !isFileExtensionHost(host)
}

/**
 * 扫描文本里的全部 URL 候选，按原文位置排序。
 *
 * 三种形态共用一套归一化：`<...>` 包裹、带 scheme 的裸 URL、裸域名。
 * 重叠候选（例如尖括号里又写了 scheme）只保留先命中的那个。
 */
export function scanUrlTokens(text: string): UrlToken[] {
  const source = String(text ?? '')
  if (!source) return []
  const tokens: UrlToken[] = []
  const taken: Array<{ start: number; end: number }> = []
  const overlaps = (start: number, end: number) =>
    taken.some((range) => start < range.end && end > range.start)

  for (const match of source.matchAll(WRAPPED_RE)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    if (overlaps(start, end)) continue
    const url = normalizeUrlCandidate(match[1])
    if (!url) continue
    tokens.push({ url, start, end, wrapped: true })
    taken.push({ start, end })
  }

  SCHEME_RE.lastIndex = 0
  for (let match = SCHEME_RE.exec(source); match; match = SCHEME_RE.exec(source)) {
    const start = match.index
    let cursor = start + match[0].length
    while (cursor < source.length && URL_TEXT_CHARS.test(source[cursor])) cursor += 1
    const cleaned = stripUrlPunctuation(source.slice(start, cursor))
    const url = cleaned ? normalizeUrlCandidate(cleaned) : null
    if (!url) {
      SCHEME_RE.lastIndex = cursor
      continue
    }
    const end = start + cleaned.length
    if (overlaps(start, end)) {
      SCHEME_RE.lastIndex = Math.max(end, cursor)
      continue
    }
    tokens.push({ url, start, end, wrapped: false })
    taken.push({ start, end })
    SCHEME_RE.lastIndex = Math.max(end, cursor)
  }

  for (const match of source.matchAll(BARE_HOST_RE)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    if (overlaps(start, end)) continue
    const url = normalizeUrlCandidate(match[0])
    if (!url) continue
    tokens.push({ url, start, end, wrapped: false })
    taken.push({ start, end })
  }

  return tokens.sort((a, b) => a.start - b.start || a.end - b.end)
}
