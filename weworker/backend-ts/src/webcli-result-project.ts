/**
 * Pure projection helpers for cached webcli large outputs.
 *
 * 背景：itsm.example.com.ls 这类列表/详情工具的返回里，每条记录都带 `raw`
 * 原始 blob、顶层还带一份 `raw: payload`，整份结果动辄数十万字符，强行内联给
 * 大模型会触发超限截断 + 模型自己用 jq/python 解析落盘文件的连锁失败。
 *
 * 解决：大结果整份落盘（见 webcli-result-cache.ts），大模型只拿到精简指针；
 * 需要细节时由 webcli_result 工具调用本模块按需投影（分页/挑字段/查关键字，
 * 默认剥离 `raw`）。本模块纯函数、无 IO，便于单测。
 */

export const DEFAULT_COMPACT_SUMMARY_CAP = 8000
const VALUE_TRUNCATE = 120

export type ProjectionMode = 'summary' | 'keys' | 'page' | 'pick' | 'item'

export interface ProjectOptions {
  mode: ProjectionMode
  fields?: string
  keyword?: string
  index?: number
  page?: number
  pageSize?: number
  includeRaw?: boolean
  cap?: number
}

/** 已知的重键，summary/page/item 默认剥离以换取可读性与体积。 */
const HEAVY_KEYS = new Set(['raw'])

/** 深拷贝并剥离 `raw` 键。includeRaw=true 时保留。 */
export function stripRaw<T>(value: T, includeRaw = false): T {
  return walk(value)

  function walk(v: any): any {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out: Record<string, any> = {}
      for (const [k, val] of Object.entries(v)) {
        if (!includeRaw && HEAVY_KEYS.has(k)) continue
        out[k] = walk(val)
      }
      return out
    }
    return v
  }
}

/** 探测工具结果的“主数组”：items | tickets | data(数组) | 第一个顶层数组。 */
export function detectMainArray(obj: any): { key: string; array: any[] } | null {
  if (!obj || typeof obj !== 'object') return null
  for (const key of ['items', 'tickets']) {
    if (Array.isArray(obj[key])) return { key, array: obj[key] }
  }
  if (Array.isArray(obj.data)) return { key: 'data', array: obj.data }
  for (const [key, val] of Object.entries(obj)) {
    if (Array.isArray(val)) return { key, array: val }
  }
  return null
}

function truncate(s: unknown, n = VALUE_TRUNCATE): string {
  const str = s == null ? '' : String(s)
  return str.length <= n ? str : str.slice(0, n) + '…'
}

function renderValue(v: any): string {
  if (v == null || v === '') return ''
  if (typeof v === 'string') return truncate(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    return truncate(JSON.stringify(v))
  } catch {
    return '…'
  }
}

function renderObjectCompact(obj: any): string {
  return Object.entries(obj)
    .filter(([k]) => !HEAVY_KEYS.has(k))
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}: ${renderValue(v)}`)
    .join(' | ')
}

function capString(s: string, cap?: number): string {
  if (typeof cap !== 'number' || cap <= 0 || s.length <= cap) return s
  return s.slice(0, cap) + '\n…(已截断，完整数据用 webcli_result 投影读取)'
}

function getByPath(obj: any, fieldPath: string): any {
  return fieldPath
    .split('.')
    .reduce<any>((acc, key) => (acc == null ? acc : acc[key]), obj)
}

/** 落盘时内联进 large_output 指针的可读摘要。 */
export function buildCompactSummary(input: any, cap = DEFAULT_COMPACT_SUMMARY_CAP): string {
  const obj = input
  const lines: string[] = []

  const meta: string[] = []
  for (const k of ['mode', 'count', 'total', 'endpoint']) {
    if (obj && obj[k] != null && obj[k] !== '') meta.push(`${k}=${obj[k]}`)
  }
  if (meta.length) lines.push(meta.join('  '))

  // 详情视图：结果自带 curated sections，直接渲染、剥 raw。
  if (obj && Array.isArray(obj.sections)) {
    for (const section of obj.sections) {
      if (!section) continue
      if (section.title) lines.push(`\n【${section.title}】`)
      const cols: string[] = Array.isArray(section.columns) ? section.columns.map(String) : []
      const rows: any[] = Array.isArray(section.rows) ? section.rows : []
      for (const row of rows) {
        if (row && typeof row === 'object' && !Array.isArray(row)) {
          const parts = cols.length
            ? cols.filter((c) => row[c] != null && row[c] !== '').map((c) => `${c}=${renderValue(row[c])}`)
            : Object.entries(row)
                .filter(([, v]) => v != null && v !== '')
                .map(([k, v]) => `${k}=${renderValue(v)}`)
          if (parts.length) lines.push('  ' + parts.join('  '))
        } else {
          lines.push('  ' + renderValue(row))
        }
      }
    }
    return capString(lines.join('\n'), cap)
  }

  // 列表视图：主数组逐项渲染、剥 raw。
  const main = detectMainArray(obj)
  if (main) {
    lines.push(`(${main.array.length} 条，字段: ${main.key})`)
    main.array.forEach((it, i) => {
      if (it && typeof it === 'object') {
        lines.push(`${i + 1}. ${renderObjectCompact(stripRaw(it))}`)
      } else {
        lines.push(`${i + 1}. ${renderValue(it)}`)
      }
    })
    return capString(lines.join('\n'), cap)
  }

  // 兜底：标量或普通对象。
  if (obj && typeof obj === 'object') {
    return capString(renderObjectCompact(stripRaw(obj)), cap)
  }
  return capString(renderValue(obj), cap)
}

export function projectResult(input: any, opts: ProjectOptions): string {
  switch (opts.mode) {
    case 'keys':
      return renderKeys(input)
    case 'page':
      return renderPage(input, opts)
    case 'pick':
      return renderPick(input, opts)
    case 'item':
      return renderItem(input, opts)
    case 'summary':
    default:
      return buildCompactSummary(input, opts.cap)
  }
}

function renderKeys(obj: any): string {
  if (!obj || typeof obj !== 'object') return JSON.stringify(obj)
  const lines: string[] = ['顶层键:']
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) {
      const first = v[0]
      const firstKeys = first && typeof first === 'object' ? Object.keys(first).join(',') : '(基本类型)'
      lines.push(`  ${k}: array[${v.length}] { ${firstKeys} }`)
    } else if (v && typeof v === 'object') {
      lines.push(`  ${k}: object { ${Object.keys(v).join(',')} }`)
    } else {
      lines.push(`  ${k}: ${typeof v} = ${renderValue(v)}`)
    }
  }
  return lines.join('\n')
}

function matchesKeyword(item: any, keyword: string): boolean {
  if (!keyword) return true
  try {
    const hay = JSON.stringify(stripRaw(item)).toLowerCase()
    return hay.includes(keyword.toLowerCase())
  } catch {
    return false
  }
}

function renderPage(obj: any, opts: ProjectOptions): string {
  const main = detectMainArray(obj)
  if (!main) return '(未找到可分页数组；改用 mode=summary 或 keys)'
  const pageSize = Math.max(1, opts.pageSize ?? 20)
  const page = Math.max(1, opts.page ?? 1)
  let rows = main.array
  if (opts.keyword) rows = rows.filter((it) => matchesKeyword(it, opts.keyword!))
  const total = rows.length
  const start = (page - 1) * pageSize
  const slice = rows.slice(start, start + pageSize)
  const lines: string[] = [
    `${main.key}: 共 ${total} 条${opts.keyword ? ` (关键字="${opts.keyword}")` : ''}，第 ${page} 页 (${slice.length}/${pageSize})`,
  ]
  slice.forEach((it, i) => {
    if (it && typeof it === 'object') lines.push(`${start + i + 1}. ${renderObjectCompact(stripRaw(it))}`)
    else lines.push(`${start + i + 1}. ${renderValue(it)}`)
  })
  const totalPages = Math.ceil(total / pageSize)
  if (totalPages > 1) lines.push(`(共 ${totalPages} 页，下一页 page=${page + 1})`)
  return lines.join('\n')
}

function renderPick(obj: any, opts: ProjectOptions): string {
  if (!opts.fields) return '(pick 需要 fields 参数，逗号分隔字段名)'
  const fields = opts.fields.split(',').map((f) => f.trim()).filter(Boolean)
  const main = detectMainArray(obj)
  if (main) {
    const lines = [`${main.key}(${main.array.length}): ${fields.join(', ')}`]
    main.array.forEach((it, i) => {
      const parts = fields.map((f) => `${f}=${renderValue(getByPath(it, f))}`)
      lines.push(`${i + 1}. ${parts.join('  ')}`)
    })
    return lines.join('\n')
  }
  return fields.map((f) => `${f}=${renderValue(getByPath(obj, f))}`).join('\n')
}

function renderItem(obj: any, opts: ProjectOptions): string {
  const main = detectMainArray(obj)
  if (!main) return '(未找到数组；改用 mode=summary)'
  const idx = opts.index ?? 0
  const item = main.array[idx]
  if (item === undefined) return `(index=${idx} 超出范围，共 ${main.array.length} 条)`
  try {
    return JSON.stringify(stripRaw(item, opts.includeRaw ?? false), null, 2)
  } catch {
    return renderObjectCompact(stripRaw(item, opts.includeRaw ?? false))
  }
}
