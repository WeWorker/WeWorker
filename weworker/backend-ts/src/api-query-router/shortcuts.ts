/**
 * 守卫式短路（`router-config/shortcuts.json`，详见设计文档 §2 第 12 行）。
 *
 * 无参数入口枚举全句全等；参数入口必须使用显式锚定模板和严格槽值。
 * `patterns.negative` 先于正向判断；抽参失败绝不派发。
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
  /** Enumerated complete utterances, compared case-insensitively after trimming. */
  exact: string[]
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
    const exact = (entry.patterns?.exact ?? [])
      .filter((phrase): phrase is string => typeof phrase === 'string' && !!phrase.trim())
      .map((phrase) => phrase.trim().toLocaleLowerCase())
    const extractors: CompiledShortcut['extractors'] = []
    let validExtractors = true
    for (const rule of entry.extract ?? []) {
      if (!rule || typeof rule.regex !== 'string' || !rule.regex || !rule.arg ||
          !rule.regex.startsWith('^') || !rule.regex.endsWith('$')) {
        validExtractors = false
        break
      }
      const re = compileRegex(rule.regex, rule.flags)
      if (!re) { validExtractors = false; break }
      extractors.push({ re, rule })
    }
    const parameterized = !!entry.extract?.length
    if (!validExtractors || (parameterized && (!positives.length || exact.length)) ||
        (!parameterized && (!exact.length || positives.length))) continue
    if (parameterized && (entry.patterns?.positive ?? []).some((source) => !source.startsWith('^') || !source.endsWith('$') || /\.\*|\.\+|\[\\s\\S\]|\[\^\]/.test(source))) continue
    out.push({ entry, positives, negatives, exact, extractors })
  }
  // priority 大者优先；同分保持配置顺序，避免「改一行顺序就换答案」
  return out.sort((a, b) => (b.entry.priority ?? 0) - (a.entry.priority ?? 0))
}

function extractOne(raw: string, rule: ShortcutExtractRule): unknown {
  switch (rule.type) {
    case 'integer': {
      const num = Number(raw)
      if (!Number.isInteger(num)) return undefined
      return (rule.min !== undefined && num < rule.min) || (rule.max !== undefined && num > rule.max)
        ? undefined : num
    }
    case 'number': {
      const num = Number(raw)
      if (!Number.isFinite(num)) return undefined
      return (rule.min !== undefined && num < rule.min) || (rule.max !== undefined && num > rule.max)
        ? undefined : num
    }
    case 'boolean':
      return raw === 'true' ? true : raw === 'false' ? false : undefined
    default:
      return !raw.trim() || typeof rule.min === 'number' || typeof rule.max === 'number'
        ? undefined // 空槽或字符串 min/max 配置均不得派发
        : raw
  }
}

/** 抽参：捕获组 1（缺省整个匹配）。任一规则失败 → 整条短路否决（不猜）。 */
function extractArgs(compiled: CompiledShortcut, message: string): Record<string, unknown> | null {
  const out: Record<string, unknown> = {}
  for (const { re, rule } of compiled.extractors) {
    const match = re.exec(message)
    if (!match || match[1] === undefined) return null
    const raw = match[1]
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
      const positive = item.exact.includes(trimmed.toLocaleLowerCase()) ||
        item.positives.some((re) => re.test(trimmed))
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
