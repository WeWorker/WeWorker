/**
 * 守卫式短路（`router-config/shortcuts.json`，详见设计文档 §2 第 12 行）。
 *
 * 与 Tier -1（patterns.json）的分工：**这层是「带门槛的精细正则」**——每条自带
 * `patterns.negative`（命中即否决，如「不要把陈述句当成查询」）与 `args.extract`
 * （从原句抽参），因此可以比 Tier -1 更早、更敢用正则，代价是必须逐条写清负向。
 *
 * 三条硬性纪律：
 *   1. **负向优先**：`patterns.negative` 命中即整条否决，不给任何翻盘机会；
 *   2. **抽参失败即整条否决**：`extract` 里有 `min`/`max`/类型转换失败 → 不猜，落回下游；
 *   3. **同类命中取 priority 大者**：priority 相同则取配置靠前者（稳定）。
 */

import type { ShortcutEntry, ShortcutExtractRule } from '../router-config/types.js'
import { createLogger } from '../logger.js'

const log = createLogger('api-query-router')

export type ShortcutHit = {
  id: string
  tool: string
  args: Record<string, unknown>
  /** 命中该条时使用的置信度：仅日志与排序用 */
  confidence: number
  render?: { type?: 'generic' | 'schema'; schemaId?: string }
}

type CompiledShortcut = {
  entry: ShortcutEntry
  positives: RegExp[]
  negatives: RegExp[]
  /** keyword 型正向：与正则分开存，避免把用户词当正则转义出错 */
  positiveKeywords: string[]
  extractors: { re: RegExp; rule: ShortcutExtractRule }[]
}

function compileRegex(source: string, flags: string | undefined): RegExp | null {
  try {
    return new RegExp(source, flags ?? 'i')
  } catch (error) {
    log.warn(`shortcuts: invalid regex dropped: ${source}`, error)
    return null
  }
}

/** 逐条编译；非法正则**只丢自己**，整层不失效。 */
export function compileShortcuts(entries: readonly ShortcutEntry[] | null | undefined): CompiledShortcut[] {
  const out: CompiledShortcut[] = []
  for (const entry of entries ?? []) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.tool !== 'string') continue
    if (entry.enabled === false) continue
    const positives: RegExp[] = []
    for (const source of entry.patterns?.positive ?? []) {
      if (typeof source !== 'string' || !source) continue
      const re = compileRegex(source, undefined)
      if (re) positives.push(re)
    }
    const negatives: RegExp[] = []
    for (const source of entry.patterns?.negative ?? []) {
      if (typeof source !== 'string' || !source) continue
      const re = compileRegex(source, undefined)
      if (re) negatives.push(re)
    }
    const positiveKeywords = (entry.patterns?.positive ?? []).filter((source) => typeof source === 'string' && source)
    const extractors: CompiledShortcut['extractors'] = []
    for (const rule of entry.extract ?? []) {
      if (!rule || typeof rule.regex !== 'string' || !rule.regex || !rule.arg) continue
      const re = compileRegex(rule.regex, rule.flags)
      if (re) extractors.push({ re, rule })
    }
    if (!positives.length && !positiveKeywords.length) continue
    out.push({ entry, positives, negatives, positiveKeywords, extractors })
  }
  // priority 大者优先；同分保持配置顺序，避免「改一行顺序就换答案」
  return out.sort((a, b) => (b.entry.priority ?? 0) - (a.entry.priority ?? 0))
}

function clamp(value: number, min?: number, max?: number): number {
  let out = value
  if (typeof min === 'number') out = Math.max(min, out)
  if (typeof max === 'number') out = Math.min(max, out)
  return out
}

function extractOne(raw: string, rule: ShortcutExtractRule): unknown {
  switch (rule.type) {
    case 'integer': {
      const num = Number(raw)
      if (!Number.isInteger(num)) return undefined
      return clamp(num, rule.min, rule.max)
    }
    case 'number': {
      const num = Number(raw)
      if (!Number.isFinite(num)) return undefined
      return clamp(num, rule.min, rule.max)
    }
    case 'boolean':
      return raw === 'true' ? true : raw === 'false' ? false : undefined
    default:
      return typeof rule.min === 'number' || typeof rule.max === 'number'
        ? undefined // 字符串类型不做钳制，配了 min/max 视为配置错误 → 不产出
        : raw
  }
}

/** 抽参：捕获组 1（缺省整个匹配）。任一规则失败 → 整条短路否决（不猜）。 */
function extractArgs(compiled: CompiledShortcut, message: string): Record<string, unknown> | null {
  const out: Record<string, unknown> = {}
  for (const { re, rule } of compiled.extractors) {
    const match = re.exec(message)
    if (!match) continue
    const raw = match[1] ?? match[0]
    if (raw === undefined) return null
    const value = extractOne(raw, rule)
    if (value === undefined) return null
    out[rule.arg] = value
  }
  return out
}

/**
 * 构造短路匹配器：`(message) => ShortcutHit | null`。纯函数、无 IO。
 * 命中顺序按 `priority` 降序；命中的工具是否可用由调用方（级联）裁决。
 */
export function buildShortcutMatcher(
  shortcuts: readonly ShortcutEntry[] | null | undefined,
): (message: string) => ShortcutHit | null {
  const compiled = compileShortcuts(shortcuts)

  return function matchShortcut(message: string): ShortcutHit | null {
    const trimmed = message?.trim()
    if (!trimmed) return null

    for (const item of compiled) {
      if (item.negatives.some((re) => re.test(trimmed))) continue
      const positive =
        item.positives.some((re) => re.test(trimmed)) ||
        item.positiveKeywords.some((keyword) => trimmed.includes(keyword))
      if (!positive) continue

      const extracted = extractArgs(item, trimmed)
      if (!extracted) continue

      return {
        id: item.entry.id,
        tool: item.entry.tool,
        args: { ...(item.entry.args ?? {}), ...extracted },
        confidence: 1,
        render: item.entry.render,
      }
    }
    return null
  }
}
