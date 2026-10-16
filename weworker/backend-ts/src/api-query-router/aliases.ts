/**
 * `!别名` 显式点名（`router-config/aliases.json`，详见设计文档 §2 第 12 行）。
 *
 * 语义：消息以 `!` 开头且后续文本与某个别名**归一化全等** → 直连该工具。这是用户对系统的
 * **显式指令**，因此：
 *   - 豁免硬门①（讨论态）与硬门①b（追问态）——用户已经点名了，不该再被守卫拦下；
 *   - 在级联中位置**靠后**：显式点名不得凌驾于卡片话术与模板直达之上（后者是作者逐字策划的
 *     更特化句式）。`!` 只保证「不会被宽泛层误抢」，不保证「优先级最高」。
 *
 * 与其它层一致的失败姿态：别名指向的工具不在当前目录 / 不可直调 / 非只读 → 不命中，
 * 整条落回 LLM（一句话都没错，只是没生效）。
 */

import type { AliasEntry } from '../router-config/types.js'

export type AliasHit = {
  id: string
  tool: string
  args: Record<string, unknown>
  /** 配置里声明的渲染方式（`type: 'schema'` 时走声明式表格） */
  render?: AliasEntry['render']
}

/** `!` 前缀判定（允许前导空白，与硬门豁免口径一致）。 */
export function isAliasPrefixed(message: string): boolean {
  return String(message ?? '').trimStart().startsWith('!')
}

/** 去 `!` 与全部空白后小写（`! My-Todo` 与 `mytodo` 等价）。 */
export function normalizeAliasText(value: string): string {
  // 去内部空白与层 P / 第 0 层同规则：别名常按卡片原文抄写，只 trim 会永远不等。
  return String(value ?? '')
    .replace(/^!/, '')
    .replace(/\s+/g, '')
    .toLowerCase()
}

/** 条目 → 别名文本：显式 `alias` 优先，缺省用 `id` 推断。 */
function aliasTextOf(entry: AliasEntry): string {
  const raw = typeof entry.alias === 'string' && entry.alias ? entry.alias : entry.id
  return normalizeAliasText(raw)
}

/**
 * 构造别名匹配器：`(message) => AliasHit | null`。纯函数、无 IO。
 * 只认「`!` + 全等」，不做包含匹配——包含匹配会让 `!foo` 意外命中 `!foobar`。
 */
export function buildAliasMatcher(
  aliases: readonly AliasEntry[] | null | undefined,
): (message: string) => AliasHit | null {
  const byText = new Map<string, AliasEntry>()
  for (const entry of aliases ?? []) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.tool !== 'string') continue
    if (entry.enabled === false) continue
    const text = aliasTextOf(entry)
    if (!text || byText.has(text)) continue
    byText.set(text, entry)
  }

  return function matchAlias(message: string): AliasHit | null {
    if (!isAliasPrefixed(message)) return null
    const entry = byText.get(normalizeAliasText(message))
    if (!entry) return null
    return { id: entry.id, tool: entry.tool, args: { ...(entry.args ?? {}) }, render: entry.render }
  }
}

/** 便于输入框提示 / 文档：当前全部可用别名（含 `!` 前缀），按配置顺序。 */
export function listAliasTexts(aliases: readonly AliasEntry[] | null | undefined): string[] {
  const out: string[] = []
  for (const entry of aliases ?? []) {
    if (!entry || entry.enabled === false || typeof entry.id !== 'string') continue
    const text = aliasTextOf(entry)
    if (text) out.push(`!${text}`)
  }
  return out
}
