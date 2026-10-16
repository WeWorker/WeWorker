/**
 * Tier -1：提示词配置层（`router-config/patterns.json`，详见设计文档 §2 第 9 行）。
 *
 * 与其它层的分工：**这层是「宽泛正则」层**——用关键词/正则表达「这类话术该走哪个工具」，
 * 因此它排在卡片话术（第 0 层）之后，且被卡片 opt-out 抑制：卡片句与宽泛正则撞型时，
 * 宽泛正则常派发到错工具（跨 adapter、或把写操作派给只读工具）。顺序即精度。
 *
 * 能力边界（必须明确，超出即不支持，不做半吊子实现）：
 *   - 支持 `regex` / `keyword`（`match_mode`: any / all / phrase）两种模式；
 *   - **不支持** `semantic` / `hybrid`（配置里写了会被校验层拒绝或按不命中处理）；
 *   - **不支持** A/B 实验、模糊相似度打分；
 *   - 单条配置的置信度 = 命中模式的最大 `weight`（缺省 1），全局门槛取
 *     `global.min_confidence_for_match`（缺省 0.8）。
 */

import type { PatternConfigEntry, PatternRule, PatternsFile } from '../router-config/types.js'
import { createLogger } from '../logger.js'

const log = createLogger('api-query-router')

/** 缺省命中门槛：0.8（与既有行为一致；可由 `global.min_confidence_for_match` 覆盖）。 */
export const DEFAULT_MIN_CONFIDENCE = 0.8

export type PatternHit = {
  /** 配置键，即工具全名 `<adapterId>.<tool>` */
  tool: string
  args: Record<string, unknown>
  confidence: number
  /** 命中的模式描述，仅日志用 */
  matchedPatterns: string[]
  /** 由 `arg_extractors` 从原句抽到的参数（覆盖 default_args） */
  extractedArgs: Record<string, unknown>
}

type CompiledEntry = {
  key: string
  entry: PatternConfigEntry
  patterns: PatternRule[]
  negative: RegExp[]
  extractors: { re: RegExp; rule: NonNullable<PatternConfigEntry['arg_extractors']>[number] }[]
}

function compileRegex(source: string, flags: string | undefined, caseSensitive: boolean): RegExp | null {
  try {
    return new RegExp(source, flags ?? (caseSensitive ? '' : 'i'))
  } catch (error) {
    log.warn(`patterns: invalid regex dropped: ${source}`, error)
    return null
  }
}

/** 逐条编译配置。非法正则/项**只丢自己**，不让整层失效。 */
export function compilePatternEntries(
  config: PatternsFile | null | undefined,
  caseSensitive = false,
): CompiledEntry[] {
  const entries: CompiledEntry[] = []
  for (const [key, entry] of Object.entries(config?.configs ?? {})) {
    if (!entry || typeof entry !== 'object') continue
    if (entry.enabled === false) continue
    const patterns = (entry.patterns ?? []).filter(
      (pattern) =>
        pattern &&
        (pattern.type === 'regex' || pattern.type === 'keyword') &&
        !(pattern.type === 'regex' && !pattern.expression) &&
        !(pattern.type === 'keyword' && !(pattern.keywords ?? []).length),
    )
    const negative: RegExp[] = []
    for (const source of entry.negative_patterns ?? []) {
      if (typeof source !== 'string' || !source) continue
      const re = compileRegex(source, undefined, caseSensitive)
      if (re) negative.push(re)
    }
    const extractors: CompiledEntry['extractors'] = []
    for (const rule of entry.arg_extractors ?? []) {
      if (!rule || typeof rule.regex !== 'string' || !rule.regex || !rule.arg) continue
      const re = compileRegex(rule.regex, rule.flags, caseSensitive)
      if (re) extractors.push({ re, rule })
    }
    entries.push({ key, entry, patterns, negative, extractors })
  }
  // priority 大者先匹配；缺省视为 0，同分保持文件顺序（稳定）
  return entries.sort((a, b) => (b.entry.priority ?? 0) - (a.entry.priority ?? 0))
}

function keywordScore(input: string, pattern: PatternRule, caseSensitive: boolean): number {
  const keywords = (pattern.keywords ?? []).map((keyword) => (caseSensitive ? keyword : keyword.toLowerCase())).filter(Boolean)
  if (!keywords.length) return 0
  const mode = pattern.match_mode ?? 'any'
  if (mode === 'all') return keywords.every((keyword) => input.includes(keyword)) ? 1 : 0
  if (mode === 'phrase') return input.includes(keywords.join('')) ? 1 : 0
  return keywords.some((keyword) => input.includes(keyword)) ? 1 : 0
}

/** 单条模式是否命中 + 其置信度（`weight` 缺省 1，钳到 [0,1] 之外也接受，仅作相对排序）。 */
function patternHit(
  message: string,
  pattern: PatternRule,
  caseSensitive: boolean,
): { hit: boolean; confidence: number; label: string } {
  const confidence = typeof pattern.weight === 'number' ? pattern.weight : 1
  if (pattern.type === 'regex') {
    if (!pattern.expression) return { hit: false, confidence: 0, label: '' }
    let re: RegExp | null = null
    try {
      re = new RegExp(pattern.expression, pattern.flags ?? (caseSensitive ? '' : 'i'))
    } catch {
      return { hit: false, confidence: 0, label: '' }
    }
    return { hit: re.test(message), confidence, label: `regex:${pattern.expression}` }
  }
  const matched = keywordScore(caseSensitive ? message : message.toLowerCase(), pattern, caseSensitive) > 0
  return { hit: matched, confidence, label: `keyword:${(pattern.keywords ?? []).join(',')}` }
}

function clampNumber(value: unknown, min?: number, max?: number): unknown {
  let out = value
  if (typeof min === 'number' || typeof max === 'number') {
    const num = Number(value)
    if (!Number.isFinite(num)) return undefined
    out = Math.min(typeof max === 'number' ? max : num, Math.max(typeof min === 'number' ? min : num, num))
  }
  return out
}

function coerceExtracted(raw: string, type: string | undefined): unknown {
  switch (type) {
    case 'integer': {
      const num = Number(raw)
      return Number.isInteger(num) ? num : undefined
    }
    case 'number': {
      const num = Number(raw)
      return Number.isFinite(num) ? num : undefined
    }
    case 'boolean':
      return raw === 'true' ? true : raw === 'false' ? false : undefined
    default:
      return raw
  }
}

/** 抽参：捕获组 1 为值；类型转换或 `min`/`max` 钳制失败则该条不产出（不猜）。 */
function extractArgs(entry: CompiledEntry, message: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const { re, rule } of entry.extractors) {
    const match = re.exec(message)
    if (!match) continue
    const raw = match[1] ?? match[0]
    if (raw === undefined) continue
    const value = coerceExtracted(raw, rule.type)
    if (value === undefined) continue
    const clamped = clampNumber(value, rule.min, rule.max)
    if (clamped === undefined) continue
    out[rule.arg] = clamped
  }
  return out
}

export type PatternMatcherDeps = {
  /** 命中门槛；缺省取配置里的 `global.min_confidence_for_match`，再缺省 0.8 */
  minConfidence?: number
  /** 只在这些工具里匹配（当前 catalog 的工具全名集合）；缺省不过滤 */
  allowedTools?: ReadonlySet<string>
}

/**
 * 构造匹配器：`(message) => PatternHit | null`。纯函数、无 IO。
 * 未过门槛 / 命中负向 / 工具不在作用域 → `null`（落回下游层，绝不硬派发）。
 */
export function buildPatternMatcher(
  config: PatternsFile | null | undefined,
  deps: PatternMatcherDeps = {},
): (message: string) => PatternHit | null {
  const caseSensitive = config?.global?.case_sensitive === true
  const threshold =
    deps.minConfidence ??
    (typeof config?.global?.min_confidence_for_match === 'number'
      ? config.global.min_confidence_for_match
      : DEFAULT_MIN_CONFIDENCE)
  const compiled = compilePatternEntries(config, caseSensitive)

  return function matchPattern(message: string): PatternHit | null {
    const trimmed = message?.trim()
    if (!trimmed) return null

    for (const entry of compiled) {
      if (deps.allowedTools && !deps.allowedTools.has(entry.key)) continue
      // 负向优先：命中任一条即整条配置不参与（防宽泛正则误伤）
      if (entry.negative.some((re) => re.test(trimmed))) continue

      let best = 0
      const matchedPatterns: string[] = []
      let bestDefaultArgs: Record<string, unknown> | undefined
      for (const pattern of entry.patterns) {
        const { hit, confidence, label } = patternHit(trimmed, pattern, caseSensitive)
        if (!hit) continue
        matchedPatterns.push(label)
        if (confidence > best) {
          best = confidence
          bestDefaultArgs = pattern.default_args
        }
      }
      if (!matchedPatterns.length) continue
      if (best < threshold) continue

      const extractedArgs = extractArgs(entry, trimmed)
      return {
        tool: entry.key,
        args: { ...(entry.entry.default_args ?? {}), ...(bestDefaultArgs ?? {}), ...extractedArgs },
        confidence: best,
        matchedPatterns,
        extractedArgs,
      }
    }
    return null
  }
}
