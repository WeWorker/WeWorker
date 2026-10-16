/**
 * 通用 markdown 渲染器（详见 docs/intelligent_routing_design.md §2「渲染」列）。
 *
 * 长尾工具（配置里没有专属 schema）走此路径：基于 `webcli-result-project` 的投影能力
 * （默认剥 raw），把 `runWebcliCall` 的输出串渲染成客户端可读 markdown。
 *
 * 渲染优先级：
 *   1) 配置里声明了 `render.schemaId` 且该 schema 适用 → 声明式渲染（declarative-renderer）；
 *   2) 数组型结果 → markdown 表；单对象 → kv 列表；其它 → 投影摘要。
 *
 * 渲染绝不抛错：任何异常都退化为「原样返回原始串」，最坏情况是用户看到一段 JSON。
 */

import { detectMainArray, projectResult } from '../webcli-result-project.js'
import { hasTitleHeading, renderFromSchema, type RenderSchemaContext } from './declarative-renderer.js'
import type { RouterRenderSchema } from '../router-config/types.js'
import { createLogger } from '../logger.js'

const log = createLogger('api-query-router')
const TABLE_MAX_COLS = 8
const TABLE_MAX_ROWS = 30
const CELL_MAX_CHARS = 80

/** 回读落盘内容后，渲染结果仍超过这个长度就退回指针文案（表本身已限 30 行 × 8 列）。 */
export const SPILL_INLINE_MAX_CHARS = 12000

export type GenericRenderDeps = {
  /** 按 schemaId 取声明式 schema；缺省表示没有配置层可用 */
  lookupSchema?: (schemaId: string) => RouterRenderSchema | undefined
  now?: Date
  /**
   * 把 `large_output` 指针还原成落盘内容（见 `webcli-result-cache.rehydratePointer`）。
   * 只有路由 fast-path 需要：那条路径零 LLM，指针没有第二个人去回读。缺省＝不做回读，
   * 落盘结果照旧只渲染成指针文案。
   */
  rehydrate?: (pointerText: string) => string | null
}

function escapeCell(value: unknown): string {
  let text: string
  if (value == null || value === '') text = ''
  else if (typeof value === 'object') {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  } else text = String(value)
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, CELL_MAX_CHARS)
}

function renderTable(rows: readonly unknown[]): string {
  if (!rows.length) return '（无数据）'
  const cols: string[] = []
  for (const row of rows) {
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      for (const key of Object.keys(row as Record<string, unknown>)) {
        if (!cols.includes(key)) cols.push(key)
      }
    }
  }
  if (!cols.length) {
    return rows.map((row, index) => `${index + 1}. ${escapeCell(row)}`).join('\n')
  }
  const cap = cols.slice(0, TABLE_MAX_COLS)
  const shown = rows.slice(0, TABLE_MAX_ROWS)
  const lines = [
    `| ${cap.join(' | ')} |`,
    `| ${cap.map(() => '---').join(' | ')} |`,
    ...shown.map((row) =>
      `| ${cap.map((col) => escapeCell((row as Record<string, unknown>)?.[col])).join(' | ')} |`,
    ),
  ]
  if (rows.length > TABLE_MAX_ROWS) {
    lines.push('', `*（仅显示前 ${TABLE_MAX_ROWS} 条，共 ${rows.length} 条）*`)
  }
  return lines.join('\n')
}

function renderKv(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj).filter(([, value]) => value != null && value !== '')
  if (!entries.length) return '（无数据）'
  return entries.map(([key, value]) => `- **${key}**: ${escapeCell(value)}`).join('\n')
}

/** 列表查询命中但为空（count:0 / items:[]）→ 给一句友好提示，而非把元数据当 JSON 甩出。 */
function renderEmptyResult(): string {
  return '未查询到相关数据。'
}

function toMarkdownBody(obj: unknown): string {
  const main = detectMainArray(obj)
  if (main?.array.length && main.array.some((item) => item && typeof item === 'object')) {
    return renderTable(main.array)
  }
  if ((main && main.array.length === 0) || (Array.isArray(obj) && obj.length === 0)) {
    return renderEmptyResult()
  }
  if (obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).length) {
    return renderKv(obj as Record<string, unknown>)
  }
  return projectResult(obj, { mode: 'summary' })
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/**
 * 把 `runWebcliCall` 输出串渲染成 markdown。
 *
 * - 空串 → 明确提示，不要把空内容当成「已完成的回答」；
 * - 非 JSON（纯文本结果）→ 原样返回；
 * - `type: 'large_output'` 指针 → 带 **回读指引**，因为 fast-path 只有这段 md 落库，
 *   它同时是给用户和给后续追问回合模型的唯一上下文；
 * - `error` → `⚠️ 查询失败：…`。
 */
export function renderGeneric(
  raw: string,
  title?: string,
  schemaRef?: { schemaId?: string },
  deps: GenericRenderDeps = {},
): string {
  const body = renderGenericBody(raw, schemaRef, deps)
  // schema 渲染出的正文自带同级标题（通常是同一个词的节标题），别再叠一层。
  if (!title || hasTitleHeading(body, title)) return body
  return `### ${title}\n\n${body}`
}

function renderGenericBody(
  raw: string,
  schemaRef?: { schemaId?: string },
  deps: GenericRenderDeps = {},
): string {
  if (!raw || !raw.trim()) return '⚠️ 查询返回为空。'

  const parsed = tryParseJson(raw)
  if (typeof parsed === 'string') return parsed.trim()

  const record = parsed as Record<string, unknown> | null
  if (record && record.type === 'large_output') {
    // fast-path 回合零 LLM，指针文案是终点而不是中转——先把落盘内容取回来渲染。
    // 取不回来、或渲染出来仍然过大，再退回指针文案（行为与不回读时逐字一致）。
    const hydrated = deps.rehydrate?.(raw)
    if (hydrated) {
      const inlined = renderGenericBody(hydrated, schemaRef, { ...deps, rehydrate: undefined })
      if (inlined.length <= SPILL_INLINE_MAX_CHARS) return inlined
      log.info(`spill inline skipped: rendered ${inlined.length} chars > ${SPILL_INLINE_MAX_CHARS}`)
    }
    // 指针 header 形如 "mode=all  count=127"；有它就不再重复拼 count。
    const header =
      typeof record.header === 'string' && record.header && record.header !== '(已落盘大结果)'
        ? record.header
        : record.count != null
          ? `count=${record.count}`
          : ''
    const meta = header ? `（${header}）` : ''
    return [
      `⚠️ 结果过大已落盘${meta}，文件：${String(record.file ?? '')}`,
      '> 完整数据未内联展示。需要明细时直接追问（如「第 3 条详情」「只看某几列」），我会用 webcli_result 工具读取这份落盘文件按需投影，不会重跑原查询（落盘文件约 30 分钟内有效，过期会自动重查）。',
    ].join('\n')
  }

  if (record && record.error) {
    const message = typeof record.error === 'string' ? record.error : JSON.stringify(record.error)
    return `⚠️ 查询失败：${message}`
  }

  // 声明式 schema 优先；不适用时静默回退通用渲染。
  const schemaId = schemaRef?.schemaId
  if (schemaId) {
    try {
      const schema = deps.lookupSchema?.(schemaId)
      if (schema) {
        const ctx: RenderSchemaContext = { now: deps.now ?? new Date() }
        const rendered = renderFromSchema(schema, parsed, ctx)
        if (rendered) return rendered
      } else {
        log.warn(`render schema not found: ${schemaId}`)
      }
    } catch (error) {
      log.warn(`declarative render failed: ${schemaId}`, error)
    }
  }

  return toMarkdownBody(parsed)
}
