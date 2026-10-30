// 「设置 - 记忆」的纯逻辑：类型显示名与顺序、预算输入校验、用量文案、提交 payload 构造。
// 这里只放纯函数（不引用 React / zustand / DOM），便于在裸 node --test 环境下直接单测。
//
// 后端契约（已定稿）：
//   GET  /memory/settings -> { budgets, defaults, usage }
//   POST /memory/settings  body { memory_budgets: { user_usage?, task_execution?, other?, extension? } }
//   GET  /memory/records?type=user_usage|task_execution|other|extension
//   DELETE /memory/records/:id

/** 记忆类型顺序（同时用于预算输入顺序与筛选下拉顺序）。 */
export const MEMORY_TYPES = ['user_usage', 'task_execution', 'other', 'extension']

/** 记忆类型显示名。 */
export const MEMORY_TYPE_LABELS = {
  user_usage: '用户偏好',
  task_execution: '任务经验',
  other: '其他长期记忆',
  extension: '扩展经验',
}

/** 预算单位说明（估算 token）。 */
export const MEMORY_BUDGET_UNIT = '估算 token'
/** 预算取值范围。 */
export const MEMORY_BUDGET_MIN = 0
export const MEMORY_BUDGET_MAX = 20000
/** 预算非法时的统一提示。 */
export const MEMORY_BUDGET_ERROR = '请输入 0-20000 之间的整数'
export const SCHEDULED_TASK_HISTORY_LIMIT_MIN = 1
export const SCHEDULED_TASK_HISTORY_LIMIT_MAX = 500
export const SCHEDULED_TASK_HISTORY_LIMIT_DEFAULT = 50
export const SCHEDULED_TASK_HISTORY_LIMIT_ERROR = '请输入 1-500 之间的整数'

/** 记忆列表筛选「全部」选项的 value。 */
export const MEMORY_FILTER_ALL = 'all'

function toText(input) {
  return String(input ?? '')
}

/** 是否为契约内的记忆类型（预算与筛选使用的四个字面量）。 */
export function isMemoryType(type) {
  return MEMORY_TYPES.includes(type)
}

/**
 * 类型显示名。
 * `extension:xxx` 这类后端内部子类型也归到「扩展经验」，未知类型回落到原始字符串。
 */
export function memoryTypeLabel(type) {
  const raw = toText(type)
  if (!raw) return ''
  if (Object.prototype.hasOwnProperty.call(MEMORY_TYPE_LABELS, raw)) return MEMORY_TYPE_LABELS[raw]
  if (raw.startsWith('extension:')) return MEMORY_TYPE_LABELS.extension
  return raw
}

/**
 * 构造下拉选项。
 * includeAll 为 true 时在首位插入 { value: 'all', label: '全部' }。
 */
export function memoryTypeOptions({ includeAll = false, allLabel = '全部' } = {}) {
  const options = MEMORY_TYPES.map((type) => ({ value: type, label: MEMORY_TYPE_LABELS[type] }))
  return includeAll ? [{ value: MEMORY_FILTER_ALL, label: allLabel }, ...options] : options
}

/**
 * 解析预算输入：仅接受纯整数文本（允许前后空白），范围 0-20000。
 * 空串、小数、负数、非数字、超上限一律返回 null。
 */
export function parseMemoryBudgetInput(raw) {
  const text = toText(raw).trim()
  if (!/^\d+$/.test(text)) return null
  const value = Number(text)
  if (!Number.isSafeInteger(value)) return null
  if (value < MEMORY_BUDGET_MIN || value > MEMORY_BUDGET_MAX) return null
  return value
}

/** 校验预算输入，返回 { ok, value } 或 { ok: false, error }。 */
export function validateMemoryBudgetInput(raw) {
  const value = parseMemoryBudgetInput(raw)
  if (value === null) return { ok: false, error: MEMORY_BUDGET_ERROR }
  return { ok: true, value }
}

export function parseScheduledTaskHistoryLimit(raw) {
  const text = toText(raw).trim()
  if (!/^\d+$/.test(text)) return null
  const value = Number(text)
  if (!Number.isSafeInteger(value) || value < SCHEDULED_TASK_HISTORY_LIMIT_MIN || value > SCHEDULED_TASK_HISTORY_LIMIT_MAX) return null
  return value
}

export function validateScheduledTaskHistoryLimit(raw) {
  const value = parseScheduledTaskHistoryLimit(raw)
  return value === null
    ? { ok: false, error: SCHEDULED_TASK_HISTORY_LIMIT_ERROR }
    : { ok: true, value }
}

/** 把后端返回的预算值转成输入框字符串；无法解析时返回空串。 */
export function formatMemoryBudgetInput(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : ''
  }
  const parsed = parseMemoryBudgetInput(value)
  return parsed === null ? '' : String(parsed)
}

/**
 * 由 GET /memory/settings 生成四个输入框的初值/恢复默认值。
 * budgets 优先，缺失回落到 defaults，再回落 0。
 */
export function buildMemoryBudgetDrafts(settings, { useDefaults = false } = {}) {
  const source = (useDefaults ? settings?.defaults : settings?.budgets) || {}
  const fallback = settings?.defaults || {}
  const drafts = {}
  for (const type of MEMORY_TYPES) {
    const raw = Object.prototype.hasOwnProperty.call(source, type) ? source[type] : fallback[type]
    drafts[type] = formatMemoryBudgetInput(raw ?? 0)
  }
  return drafts
}

function toNonNegativeNumber(value) {
  const number = typeof value === 'number' ? value : Number(toText(value).trim())
  if (!Number.isFinite(number) || number < 0) return 0
  return number
}

/**
 * 生成用量文案：「当前 120 / 800 token，2 条」。
 * usage 缺档按 0 兜底；预算无法解析时只展示已用量。
 */
export function formatMemoryUsageLine(usage, budget) {
  const tokens = toNonNegativeNumber(usage?.tokens)
  const count = toNonNegativeNumber(usage?.count)
  const limit = parseMemoryBudgetInput(budget)
  if (limit === null) return `当前 ${tokens} token，${count} 条`
  return `当前 ${tokens} / ${limit} token，${count} 条`
}

/** 置信度展示：0-1 保留两位小数，其他数值原样字符串化，非法返回空串（调用方可据此隐藏）。 */
export function formatMemoryConfidence(value) {
  if (value === null || value === undefined || toText(value).trim() === '') return ''
  const number = typeof value === 'number' ? value : Number(toText(value).trim())
  if (!Number.isFinite(number)) return ''
  if (number >= 0 && number <= 1) return number.toFixed(2)
  return String(number)
}

/** 记忆更新时间本地化；非法时间返回空串。 */
export function formatMemoryUpdatedAt(value) {
  const text = toText(value).trim()
  if (!text) return ''
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/**
 * 把四个草稿整理成提交 payload。
 * 返回 { ok, memory_budgets, errors, invalidTypes }：
 * - errors 非空时调用方不得发请求，就地提示；
 * - memory_budgets 只包含合法项（契约允许只提交部分键）。
 */
export function buildMemoryBudgetPayload(drafts) {
  const source = drafts && typeof drafts === 'object' ? drafts : {}
  const memoryBudgets = {}
  const errors = []
  for (const type of MEMORY_TYPES) {
    if (!Object.prototype.hasOwnProperty.call(source, type)) continue
    const parsed = parseMemoryBudgetInput(source[type])
    if (parsed === null) {
      errors.push({ type, label: memoryTypeLabel(type), error: MEMORY_BUDGET_ERROR })
      continue
    }
    memoryBudgets[type] = parsed
  }
  return {
    ok: errors.length === 0,
    memory_budgets: memoryBudgets,
    errors,
    invalidTypes: errors.map((item) => item.type),
  }
}
