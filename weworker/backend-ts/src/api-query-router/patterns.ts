import type { ArgExtractorRule, PatternConfigEntry, PatternRule, PatternsFile, RouterRenderSpec } from '../router-config/types.js'
import { createLogger } from '../logger.js'

const log = createLogger('api-query-router')
export const DEFAULT_MIN_CONFIDENCE = 0.8

export type PatternHit = {
  tool: string
  args: Record<string, unknown>
  confidence: number
  render?: RouterRenderSpec
  matchedPatterns: string[]
  extractedArgs: Record<string, unknown>
}

type CompiledRule = {
  rule: PatternRule
  template?: { re: RegExp; slots: string[] }
  examples?: Set<string>
}
type CompiledEntry = {
  key: string
  entry: PatternConfigEntry
  patterns: CompiledRule[]
  negative: RegExp[]
  extractors: { re: RegExp; rule: ArgExtractorRule }[]
}

function compileRegex(source: string, flags: string | undefined, caseSensitive: boolean): RegExp | null {
  try {
    return new RegExp(source, flags ?? (caseSensitive ? '' : 'i'))
  } catch (error) {
    log.warn(`patterns: invalid regex dropped: ${source}`, error)
    return null
  }
}

const SLOT = /\$\{([a-zA-Z_][\w]*)\}/g
const UNIT = /(?:小时|分钟|公里|公斤|天|个|条|页|楼|层|周|月|年|次|秒|米|元|件|张|位|人|岁|吨|克|只|辆)$/u
function normalize(value: string, caseSensitive: boolean): string {
  const compact = value.replace(/\s+/g, '')
  return caseSensitive ? compact : compact.toLowerCase()
}
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
function literalRegex(value: string): string {
  // Whitespace explicitly present in a template is a required separator. Elsewhere,
  // incidental whitespace between literal characters is harmless (Chinese card text).
  return value.split(/(\s+)/).filter(Boolean).map((part) =>
    /^\s+$/.test(part) ? '\\s+' : Array.from(part).map(escapeRegex).join('\\s*'),
  ).join('')
}

/** Templates are literal text with named, nonempty slots; units are fixed literals outside slots. */
function compileTemplate(expression: string, caseSensitive: boolean): CompiledRule['template'] {
  const slots: string[] = []
  let source = '^'
  let end = 0
  for (const match of expression.matchAll(SLOT)) {
    const literal = expression.slice(end, match.index)
    // Adjacent unconstrained slots have ambiguous boundaries: reject rather than guess.
    if (slots.length && !literal) return undefined
    source += literalRegex(literal)
    slots.push(match[1])
    source += `(?<slot${slots.length}>.+?)`
    end = match.index + match[0].length
  }
  if (!slots.length || /\$\{/.test(expression.replace(SLOT, ''))) return undefined
  const suffix = expression.slice(end)
  source += literalRegex(suffix) + '$'
  try {
    return { re: new RegExp(source, caseSensitive ? 'u' : 'iu'), slots }
  } catch {
    return undefined
  }
}

export function compilePatternEntries(config: PatternsFile | null | undefined, caseSensitive = false): CompiledEntry[] {
  const entries: CompiledEntry[] = []
  for (const [key, entry] of Object.entries(config?.configs ?? {})) {
    if (!entry || typeof entry !== 'object' || entry.enabled === false) continue
    const patterns: CompiledRule[] = []
    for (const rule of entry.patterns ?? []) {
      if (!rule) continue
      if (rule.type === 'keyword') {
        if (rule.keywords?.length) patterns.push({ rule })
      } else if (rule.type === 'template' || (rule.type === 'regex' && rule.expression?.includes('${'))) {
        const template = compileTemplate(rule.expression ?? '', caseSensitive)
        if (template) patterns.push({ rule, template })
      } else if (rule.type === 'regex' && rule.expression) {
        // A free-form regex cannot authorize arbitrary substring matches. Only its explicitly
        // reviewed examples are eligible, and those examples must satisfy the original regex.
        const re = compileRegex(rule.expression, rule.flags, caseSensitive)
        if (!re) continue
        const examples = new Set((rule.examples ?? []).filter((example) => {
          re.lastIndex = 0
          return typeof example === 'string' && re.test(example)
        }).map((example) => normalize(example, caseSensitive)))
        if (examples.size) patterns.push({ rule, examples })
      }
    }
    const negative: RegExp[] = []
    for (const source of entry.negative_patterns ?? []) {
      if (typeof source !== 'string' || !source) continue
      const re = compileRegex(source, undefined, caseSensitive)
      if (re) negative.push(re)
    }
    const extractors: CompiledEntry['extractors'] = []
    for (const rule of entry.arg_extractors ?? []) {
      if (!rule || !rule.regex || !rule.arg) continue
      const re = compileRegex(rule.regex, rule.flags, caseSensitive)
      if (re) extractors.push({ re, rule })
    }
    entries.push({ key, entry, patterns, negative, extractors })
  }
  return entries.sort((a, b) => (b.entry.priority ?? 0) - (a.entry.priority ?? 0))
}

function keywordMatches(message: string, rule: PatternRule, caseSensitive: boolean): boolean {
  const keywords = (rule.keywords ?? []).map((keyword) => normalize(keyword, caseSensitive)).filter(Boolean)
  if (!keywords.length) return false
  const mode = rule.match_mode ?? 'any'
  if (mode === 'phrase' || mode === 'all') return message === keywords.join('')
  return keywords.some((keyword) => message === keyword)
}

function clampNumber(value: unknown, min?: number, max?: number): unknown {
  if (typeof min !== 'number' && typeof max !== 'number') return value
  const num = Number(value)
  if (!Number.isFinite(num)) return undefined
  return Math.min(typeof max === 'number' ? max : num, Math.max(typeof min === 'number' ? min : num, num))
}
function coerceExtracted(raw: string, type: string | undefined): unknown {
  switch (type) {
    case 'integer': {
      if (!/^[+-]?\d+$/.test(raw)) return undefined
      const num = Number(raw)
      return Number.isSafeInteger(num) ? num : undefined
    }
    case 'number': {
      if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) return undefined
      const num = Number(raw)
      return Number.isFinite(num) ? num : undefined
    }
    case 'boolean': return raw === 'true' ? true : raw === 'false' ? false : undefined
    default: return raw
  }
}

function extractArgs(entry: CompiledEntry, message: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const { re, rule } of entry.extractors) {
    re.lastIndex = 0
    const match = re.exec(message)
    if (!match) continue
    const value = coerceExtracted(match[1] ?? match[0], rule.type)
    if (value === undefined) continue
    const clamped = clampNumber(value, rule.min, rule.max)
    if (clamped !== undefined) out[rule.arg] = clamped
  }
  return out
}

/** Captured template slots, not legacy substring extractors, are the sole source of dynamic args. */
function templateArgs(entry: CompiledEntry, compiled: NonNullable<CompiledRule['template']>, message: string): Record<string, unknown> | null {
  const match = compiled.re.exec(message)
  if (!match?.groups) return null
  const out: Record<string, unknown> = {}
  for (let index = 0; index < compiled.slots.length; index++) {
    const name = compiled.slots[index]
    const raw = match.groups[`slot${index + 1}`]?.trim()
    if (!raw) return null
    const extractor = entry.extractors.find(({ rule }) => rule.arg === name)?.rule
    // A template must explicitly spell out measurement units; no slot may absorb one.
    if (UNIT.test(raw)) return null
    const slotRule = entry.patterns.find(({ template }) => template === compiled)?.rule
    const validator = slotRule?.slot_validators?.[name]
    if (validator) {
      const re = compileRegex(`^(?:${validator})$`, undefined, true)
      if (!re || !re.test(raw)) return null
    }
    if (extractor?.type === 'string' && /\s*[。！？!?；;，,]$/.test(raw)) return null
    const value = coerceExtracted(raw, extractor?.type)
    if (value === undefined) return null
    const clamped = clampNumber(value, extractor?.min, extractor?.max)
    if (clamped === undefined || (name in out && out[name] !== clamped)) return null
    out[name] = clamped
  }
  return out
}

export type PatternMatcherDeps = { minConfidence?: number; allowedTools?: ReadonlySet<string> }

export function buildPatternMatcher(config: PatternsFile | null | undefined, deps: PatternMatcherDeps = {}): (message: string) => PatternHit | null {
  const caseSensitive = config?.global?.case_sensitive === true
  const threshold = deps.minConfidence ?? config?.global?.min_confidence_for_match ?? DEFAULT_MIN_CONFIDENCE
  const compiled = compilePatternEntries(config, caseSensitive)
  return function matchPattern(message: string): PatternHit | null {
    const trimmed = message?.trim()
    if (!trimmed) return null
    const normalized = normalize(trimmed, caseSensitive)
    for (const entry of compiled) {
      if (deps.allowedTools && !deps.allowedTools.has(entry.key)) continue
      if (entry.negative.some((re) => { re.lastIndex = 0; return re.test(trimmed) })) continue
      let best = 0
      const matchedPatterns: string[] = []
      let bestDefaultArgs: Record<string, unknown> | undefined
      let bestArgs: Record<string, unknown> = {}
      for (const { rule, template, examples } of entry.patterns) {
        const args = template ? templateArgs(entry, template, trimmed) : extractArgs(entry, trimmed)
        const hit = template ? args !== null : examples ? examples.has(normalized) : keywordMatches(normalized, rule, caseSensitive)
        if (!hit) continue
        const confidence = typeof rule.weight === 'number' ? rule.weight : 1
        matchedPatterns.push(`${rule.type}:${rule.expression ?? (rule.keywords ?? []).join(',')}`)
        if (confidence > best) {
          best = confidence
          bestDefaultArgs = rule.default_args
          bestArgs = args ?? {}
        } else if (confidence === best) {
          if (rule.default_args) bestDefaultArgs = { ...(bestDefaultArgs ?? {}), ...rule.default_args }
          // The first equally ranked matching rule owns extraction. Mixing different
          // rules' independent extractors can inject args unrelated to the chosen intent.
        }
      }
      if (!matchedPatterns.length || best < threshold) continue
      return {
        tool: entry.key,
        args: { ...(entry.entry.default_args ?? {}), ...(bestDefaultArgs ?? {}), ...bestArgs },
        confidence: best,
        render: entry.entry.render,
        matchedPatterns,
        extractedArgs: bestArgs,
      }
    }
    return null
  }
}
