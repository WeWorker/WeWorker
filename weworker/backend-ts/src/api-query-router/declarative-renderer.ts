/**
 * 声明式渲染器（详见 docs/intelligent_routing_design.md §3.2「渲染能力边界」）。
 *
 * 配置即渲染：`renderers.json` 的 schema 描述「取哪个数组、显示哪几列、每列怎么格式化、
 * 最多几行」。支持 `text` / `number` / `date` / `status` / `link` 五类列、分节、行数截断
 * 与「仅显示前 N 条」尾注；**不支持**任意脚本、跨行计算、条件分支渲染——需要这些的工具
 * 应走通用渲染或落回 LLM，不允许在渲染层写代码。
 *
 * 本模块是纯函数：输入（schema, 原始返回值, 当前时间），输出 markdown 或 null（不适用）。
 * 返回 null 时调用方回退到通用渲染，绝不因为「schema 不匹配」抛错或输出半成品。
 */

import type { RouterRenderColumn, RouterRenderSchema } from '../router-config/types.js'

const DEFAULT_MAX_ROWS = 50
const CELL_MAX_CHARS = 80
/** 超过这个长度的 href 归入「埋点 URL」处理，见 `compactHref`。 */
const LINK_HREF_MAX_CHARS = 200

export type RenderSchemaContext = {
  /** 用于相对日期与时间格式化的「今天」；注入以便测试固定时钟 */
  now: Date
}

/** 从对象按 `a.b[0].c` 形式的路径取值；任一段缺失返回 undefined。 */
export function getFieldValue(source: unknown, path: string): unknown {
  if (!path) return undefined
  let cursor: unknown = source
  for (const rawSegment of path.split('.')) {
    if (cursor == null) return undefined
    const arrayMatch = /^(.*?)\[(\d+)\]$/.exec(rawSegment)
    const key = arrayMatch ? arrayMatch[1] : rawSegment
    if (key) {
      if (typeof cursor !== 'object' || Array.isArray(cursor)) return undefined
      cursor = (cursor as Record<string, unknown>)[key]
    }
    if (arrayMatch) {
      if (!Array.isArray(cursor)) return undefined
      cursor = cursor[Number(arrayMatch[2])]
    }
  }
  return cursor
}

/** 主数组定位：显式 dataSource 优先；否则按「裸数组 / 首个对象数组字段」探测。 */
export function locateRows(source: unknown, dataSource?: string): unknown[] | null {
  if (dataSource) {
    const value = getFieldValue(source, dataSource)
    return Array.isArray(value) ? value : null
  }
  if (Array.isArray(source)) return source
  if (!source || typeof source !== 'object') return null
  for (const value of Object.values(source as Record<string, unknown>)) {
    if (Array.isArray(value)) return value
  }
  return null
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** `YYYY-MM-DD` / ISO 串 / 毫秒时间戳统一成 `YYYY-MM-DD[ HH:mm]`；无法识别时原样返回。 */
export function formatDate(value: unknown, withTime: boolean): string {
  if (value == null || value === '') return ''
  if (value instanceof Date) {
    const base = `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`
    return withTime ? `${base} ${pad2(value.getHours())}:${pad2(value.getMinutes())}` : base
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return formatDate(new Date(value), withTime)
  }
  const text = String(value)
  const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s](\d{1,2}):(\d{2}))?/.exec(text)
  if (!match) return text
  const base = `${match[1]}-${pad2(Number(match[2]))}-${pad2(Number(match[3]))}`
  if (!withTime || match[4] === undefined) return base
  return `${base} ${pad2(Number(match[4]))}:${match[5]}`
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

/**
 * 链接列的 href 收敛：超长 URL 基本都是埋点参数（例：今日头条热榜的 `log_pb` 单条 775 字符，
 * 20 行表格因此从 ~2.7k 字符涨到 18k，直接顶穿内联上限、退回落盘指针，比不渲染还差）。
 * 去掉 query/hash 后剩下的规范链接照样能点开，表格也回到可读宽度。
 *
 * 只有路径本身带定位信息（不只是域名根）时才敢删 query——那种「id 全在 query 里」的超长 URL
 * 删了就是坏链接，宁可原样保留，把体积交给内联上限兜底。
 */
export function compactHref(url: string): string {
  if (url.length <= LINK_HREF_MAX_CHARS) return url
  const cut = url.search(/[?#]/)
  if (cut < 0) return url
  const base = url.slice(0, cut)
  const path = base.replace(/^https?:\/\/[^/]*/i, '').replace(/\/+$/, '')
  return path.length >= 4 ? base : url
}

/**
 * 正文是不是已经用标题打过头了。渲染链路里「渲染配置的标题」「schema 标题」「节标题」三层
 * 常常是同一个词，重复输出会让用户看到两行一模一样的标题。节标题带 `（N 条）` 后缀，因此
 * 比对时把「完全相等」和「标题 + 括号/空格后缀」都算命中。
 */
export function hasTitleHeading(body: string, title: string | undefined): boolean {
  if (!title) return false
  const firstLine = body.split('\n', 1)[0]
  return (
    firstLine === `### ${title}` ||
    firstLine.startsWith(`### ${title}（`) ||
    firstLine.startsWith(`### ${title} `)
  )
}

/** 单元格取值：列类型决定展示形态；链接列输出 markdown 链接。 */
export function renderCell(column: RouterRenderColumn, row: unknown): string {
  const raw = getFieldValue(row, column.key)
  switch (column.type) {
    case 'date':
      return escapeCell(formatDate(raw, false))
    case 'number': {
      if (raw == null || raw === '') return ''
      const num = Number(raw)
      return Number.isFinite(num) ? String(num) : escapeCell(raw)
    }
    case 'status': {
      if (raw == null || raw === '') return ''
      const text = escapeCell(raw)
      return `\`${text}\``
    }
    case 'link': {
      if (raw == null || raw === '') return ''
      const url = String(raw)
      if (!/^https?:\/\//i.test(url)) return escapeCell(url)
      const href = compactHref(url)
      const label = escapeCell(getFieldValue(row, `${column.key}_label`) ?? href)
      return `[${label}](${href})`
    }
    case 'text':
    default:
      return escapeCell(raw)
  }
}

type ResolvedColumns = {
  headers: string[]
  cells: (row: unknown) => string[]
}

function resolveColumns(schema: RouterRenderSchema, rows: readonly unknown[]): ResolvedColumns | null {
  const declared = schema.columns ?? []
  if (declared.length) {
    return {
      headers: declared.map((column) => column.title ?? column.key),
      cells: (row) => declared.map((column) => renderCell(column, row)),
    }
  }
  // 未声明列：按首行对象字段自动成列（上限 8 列，保持与通用渲染一致的可读宽度）。
  const first = rows.find((row) => row && typeof row === 'object' && !Array.isArray(row))
  if (!first) return null
  const keys = Object.keys(first as Record<string, unknown>).slice(0, 8)
  if (!keys.length) return null
  const columns: RouterRenderColumn[] = keys.map((key) => ({ type: 'text', key }))
  return {
    headers: keys,
    cells: (row) => columns.map((column) => renderCell(column, row)),
  }
}

function renderTable(rows: readonly unknown[], schema: RouterRenderSchema): string | null {
  const columns = resolveColumns(schema, rows)
  if (!columns) {
    return rows.map((row, index) => `${index + 1}. ${escapeCell(row)}`).join('\n')
  }
  const maxRows = Number.isFinite(schema.maxRows) ? Math.max(0, Number(schema.maxRows)) : DEFAULT_MAX_ROWS
  const shown = rows.slice(0, maxRows)
  const lines = [
    `| ${columns.headers.join(' | ')} |`,
    `| ${columns.headers.map(() => '---').join(' | ')} |`,
    ...shown.map((row) => `| ${columns.cells(row).join(' | ')} |`),
  ]
  if (rows.length > shown.length) {
    lines.push('', `*（仅显示前 ${shown.length} 条，共 ${rows.length} 条）*`)
  }
  return lines.join('\n')
}

function renderSection(
  section: RouterRenderSchema,
  source: unknown,
  ctx: RenderSchemaContext,
): string | null {
  const rows = locateRows(source, section.dataSource)
  if (!rows) return null
  const body = rows.length ? renderTable(rows, section) : (section.emptyMessage ?? '未查询到相关数据。')
  if (!body) return null
  const heading = section.title ? `### ${section.title}${rows.length ? `（${rows.length} 条）` : ''}\n\n` : ''
  return `${heading}${body}`
}

/**
 * 按 schema 渲染。返回 null 表示「该 schema 不适用于这份返回值」——调用方须回退通用渲染。
 * 永不抛错：任何内部异常都退化为 null。
 */
export function renderFromSchema(
  schema: RouterRenderSchema | undefined,
  source: unknown,
  ctx: RenderSchemaContext,
): string | null {
  if (!schema) return null
  try {
    if (source == null) return null

    const parts: string[] = []
    if (Array.isArray(schema.sections) && schema.sections.length) {
      for (const section of schema.sections) {
        const rendered = renderSection(section, source, ctx)
        if (rendered) parts.push(rendered)
      }
      if (!parts.length) return null
    } else {
      const single = renderSection(schema, source, ctx)
      if (!single) return null
      parts.push(single)
    }

    // 单节 schema 的节标题就是 schema 标题（节还要带条数后缀），照搬会导致用户看到两行一样的标题。
    const body = parts.join('\n\n')
    const head = schema.title ? `### ${schema.title}\n\n` : ''
    return hasTitleHeading(body, schema.title) ? body : `${head}${body}`
  } catch {
    return null
  }
}
