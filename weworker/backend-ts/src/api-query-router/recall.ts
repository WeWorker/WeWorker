/**
 * 词法召回与 adapter 关键词门（详见 docs/intelligent_routing_design.md §2 第 10/12 行）。
 *
 * 分工：
 * - `mentionsAdapter` 是**硬门②**：宽泛层（override / 提示词配置 / LLM 分类）命中后，
 *   若消息里连目标 adapter 的名字都没出现，说明它只是一句没有指向任何站点的口语 → 落回 LLM。
 * - `recall` 是**召回门**：对全部可直调工具语料做重叠打分，返回 top-K。它只管高召回，
 *   精度交给 LLM 分类；零相似直接返回 `[]`，调用方据此不付 LLM 成本。
 *
 * 精度根基：漏判免费（落回 LLM = 今天行为）、误判致命。recall 从不做命中决策。
 */

import type { CatalogTool } from './tool-catalog.js'

/** 词法召回最低重叠率：低于此值不进候选（避免对零相关消息白调 LLM）。 */
export const RECALL_MIN = 0.08
/** 词法召回返回的 top-K 候选数（缩小 LLM 分类 prompt）。 */
export const RECALL_K = 8

const PARAM_DESC_MAX = 60
const PARAMS_PER_TOOL_MAX = 8

/** recall() 返回的候选项：工具名 + 词法得分 + 描述 + 必填参 + 参数表（供 LLM 抽参）。 */
export type RouteParam = {
  name: string
  type?: string
  desc?: string
  enum?: string[]
}

export type RouteCandidate = {
  tool: string
  score: number
  description: string
  required: string[]
  params: RouteParam[]
}

/**
 * 从工具全名派生 adapter 名称关键词：去掉最后一段（动作名）后按 `.` 拆段，滤掉 <4 字符的
 * 通用段（com / net / uat / www…）。`example.com.list-repos` → [example]；
 * `docs.example.org.list-items` → [docs, example]。
 */
export function adapterKeywordsOf(toolName: string): string[] {
  return String(toolName ?? '')
    .split('.')
    .slice(0, -1)
    .filter((segment) => segment.length >= 4 && !GENERIC_SEGMENTS.has(segment.toLowerCase()))
}

/** 公共后缀与常见环境段：它们出现在几乎所有域名里，作为「站点名」没有区分度。 */
const GENERIC_SEGMENTS: ReadonlySet<string> = new Set(['www', 'com', 'www2', 'net', 'org', 'local'])

/**
 * 硬门②：消息（`\b` 词界、大小写不敏感）是否含目标工具的 adapter 名称关键词。
 *
 * 无法派生关键词（超短名 / 纯公共后缀）时**不设卡**——精度仍由各层 matcher 把关，
 * 这里宁可放过也不要凭一个无区分度的词误拦。
 */
export function mentionsAdapter(message: string, toolName: string): boolean {
  const keywords = adapterKeywordsOf(toolName)
  if (!keywords.length) return true
  const lower = String(message ?? '').toLowerCase()
  return keywords.some((keyword) => {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`\\b${escaped}\\b`).test(lower)
  })
}

/** 分词：拉丁词（>1 字符）+ CJK 二元组 + CJK 单字（无需分词器的粗粒度占位）。 */
export function tokenize(text: string): Set<string> {
  const s = String(text ?? '').toLowerCase()
  const tokens = new Set<string>()
  for (const word of s.match(/[a-z0-9_]+/g) ?? []) if (word.length > 1) tokens.add(word)
  const cjk = s.replace(/[^一-鿿]/g, '')
  for (let i = 0; i < cjk.length - 1; i++) tokens.add(cjk.slice(i, i + 2))
  for (const ch of cjk) tokens.add(ch)
  return tokens
}

/** 重叠率：交集 / 较小集合大小（偏向「消息词多被工具语料覆盖」）。 */
export function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let inter = 0
  for (const token of small) if (large.has(token)) inter++
  return inter / small.size
}

type JsonSchemaLike = {
  properties?: Record<string, { type?: string; description?: unknown; enum?: unknown[] }>
  required?: string[]
}

/** 取 schema 的必填参名列表（防御性）。 */
export function requiredOf(schema: Record<string, unknown> | undefined): string[] {
  const required = (schema as JsonSchemaLike | undefined)?.required
  return Array.isArray(required) ? required.filter((name): name is string => typeof name === 'string') : []
}

/**
 * 取 schema 的参数精简表（名/类型/描述/枚举），供 LLM 分类层按字段抽参。
 * 只收有指引（desc 或 enum）的参数——无指引的字段对 LLM 抽参无意义且占体积。
 */
export function paramsOf(schema: Record<string, unknown> | undefined): RouteParam[] {
  const properties = (schema as JsonSchemaLike | undefined)?.properties
  if (!properties || typeof properties !== 'object') return []
  const out: RouteParam[] = []
  for (const [name, raw] of Object.entries(properties)) {
    if (!raw || typeof raw !== 'object') continue
    const desc = typeof raw.description === 'string' ? raw.description.slice(0, PARAM_DESC_MAX) : undefined
    const enumList = Array.isArray(raw.enum) ? raw.enum.map(String) : undefined
    if (!desc && !enumList) continue
    out.push({ name, type: typeof raw.type === 'string' ? raw.type : undefined, desc, enum: enumList })
    if (out.length >= PARAMS_PER_TOOL_MAX) break
  }
  return out
}

type Doc = {
  tool: CatalogTool
  tokens: Set<string>
  required: string[]
  params: RouteParam[]
}

/** 工具语料索引：名称 + 描述 + 别名。catalog 变化时由调用方重建。 */
export function buildRecallIndex(directTools: readonly CatalogTool[]): Doc[] {
  return directTools
    .filter((tool) => tool && tool.name)
    .map((tool) => ({
      tool,
      tokens: tokenize(`${tool.name} ${tool.description} ${tool.aliases.join(' ')}`),
      required: requiredOf(tool.parameters),
      params: paramsOf(tool.parameters),
    }))
}

/**
 * 词法召回：top-K 候选（含描述/必填参，供 LLM 分类层使用）；零相似返回 `[]`。
 * 相同得分时按工具名稳定排序，保证同一输入的可复现性。
 */
export function recall(message: string, index: readonly Doc[], k = RECALL_K): RouteCandidate[] {
  const trimmed = message?.trim()
  if (!trimmed) return []
  const messageTokens = tokenize(trimmed)
  if (!messageTokens.size) return []
  return index
    .map((doc) => ({
      tool: doc.tool.name,
      score: overlap(messageTokens, doc.tokens),
      description: doc.tool.description,
      required: doc.required,
      params: doc.params,
    }))
    .filter((candidate) => candidate.score >= RECALL_MIN)
    .sort((a, b) => b.score - a.score || a.tool.localeCompare(b.tool))
    .slice(0, k)
}
