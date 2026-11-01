import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MEMORY_BUDGET_ERROR,
  MEMORY_BUDGET_MAX,
  SCHEDULED_TASK_HISTORY_LIMIT_DEFAULT,
  SCHEDULED_TASK_HISTORY_LIMIT_ERROR,
  MEMORY_FILTER_ALL,
  MEMORY_TYPES,
  MEMORY_TYPE_LABELS,
  buildMemoryBudgetDrafts,
  buildMemoryBudgetPayload,
  formatMemoryBudgetInput,
  formatMemoryConfidence,
  formatMemoryUpdatedAt,
  formatMemoryUsageLine,
  isMemoryType,
  memoryTypeLabel,
  memoryTypeOptions,
  parseMemoryBudgetInput,
  parseScheduledTaskHistoryLimit,
  validateMemoryBudgetInput,
  validateScheduledTaskHistoryLimit,
} from '../utils/memory-settings.js'

const SETTINGS_FIXTURE = {
  budgets: { user_usage: 800, task_execution: 1600, other: 1200, extension: 800 },
  defaults: { user_usage: 800, task_execution: 1600, other: 1200, extension: 800 },
  usage: {
    user_usage: { tokens: 120, count: 2 },
    task_execution: { tokens: 0, count: 0 },
    other: { tokens: 0, count: 0 },
    extension: { tokens: 0, count: 0 },
  },
}

test('记忆类型显示名与顺序固定', () => {
  assert.deepEqual(MEMORY_TYPES, ['user_usage', 'task_execution', 'other', 'extension'])
  assert.deepEqual(MEMORY_TYPES.map(memoryTypeLabel), ['用户偏好', '任务经验', '其他长期记忆', '扩展经验'])
  assert.equal(MEMORY_TYPE_LABELS.user_usage, '用户偏好')
  assert.equal(MEMORY_TYPE_LABELS.task_execution, '任务经验')
  assert.equal(MEMORY_TYPE_LABELS.other, '其他长期记忆')
  assert.equal(MEMORY_TYPE_LABELS.extension, '扩展经验')
  assert.equal(isMemoryType('user_usage'), true)
  assert.equal(isMemoryType('extension:orders'), false)
  // 后端内部子类型归到扩展经验，未知类型回落原字符串。
  assert.equal(memoryTypeLabel('extension:orders'), '扩展经验')
  assert.equal(memoryTypeLabel('unknown_type'), 'unknown_type')
  assert.equal(memoryTypeLabel(''), '')
})

test('筛选下拉选项顺序为「全部 + 四个类型」', () => {
  assert.deepEqual(memoryTypeOptions(), [
    { value: 'user_usage', label: '用户偏好' },
    { value: 'task_execution', label: '任务经验' },
    { value: 'other', label: '其他长期记忆' },
    { value: 'extension', label: '扩展经验' },
  ])
  assert.deepEqual(memoryTypeOptions({ includeAll: true }).map((option) => option.value), [
    MEMORY_FILTER_ALL, 'user_usage', 'task_execution', 'other', 'extension',
  ])
  assert.equal(memoryTypeOptions({ includeAll: true })[0].label, '全部')
})

test('预算输入校验覆盖合法、0、负数、小数、超上限、非数字、空串', () => {
  assert.deepEqual(validateMemoryBudgetInput('800'), { ok: true, value: 800 })
  assert.deepEqual(validateMemoryBudgetInput(800), { ok: true, value: 800 })
  assert.deepEqual(validateMemoryBudgetInput(' 0 '), { ok: true, value: 0 })
  assert.deepEqual(validateMemoryBudgetInput(String(MEMORY_BUDGET_MAX)), { ok: true, value: MEMORY_BUDGET_MAX })

  for (const invalid of ['-1', '12.5', String(MEMORY_BUDGET_MAX + 1), 'abc', '', '   ', null, undefined, '1e3', '+5', 'NaN', {}]) {
    assert.deepEqual(validateMemoryBudgetInput(invalid), { ok: false, error: MEMORY_BUDGET_ERROR })
    assert.equal(parseMemoryBudgetInput(invalid), null)
  }
})

test('定时任务对话上限默认为 50，并只接受 1-500 的整数', () => {
  assert.equal(SCHEDULED_TASK_HISTORY_LIMIT_DEFAULT, 50)
  assert.deepEqual(validateScheduledTaskHistoryLimit('50'), { ok: true, value: 50 })
  assert.deepEqual(validateScheduledTaskHistoryLimit(' 1 '), { ok: true, value: 1 })
  assert.equal(parseScheduledTaskHistoryLimit('500'), 500)
  for (const value of ['0', '501', '-1', '1.5', '', 'abc']) {
    assert.equal(parseScheduledTaskHistoryLimit(value), null)
    assert.deepEqual(validateScheduledTaskHistoryLimit(value), { ok: false, error: SCHEDULED_TASK_HISTORY_LIMIT_ERROR })
  }
})

test('预算值转输入框字符串', () => {
  assert.equal(formatMemoryBudgetInput(0), '0')
  assert.equal(formatMemoryBudgetInput(800), '800')
  assert.equal(formatMemoryBudgetInput('1600'), '1600')
  assert.equal(formatMemoryBudgetInput(12.5), '')
  assert.equal(formatMemoryBudgetInput(null), '')
  assert.equal(formatMemoryBudgetInput('abc'), '')
})

test('由 GET /memory/settings 生成输入草稿（缺档兜底）', () => {
  assert.deepEqual(buildMemoryBudgetDrafts(SETTINGS_FIXTURE), {
    user_usage: '800', task_execution: '1600', other: '1200', extension: '800',
  })
  // budgets 缺档回落到 defaults，两者都缺则回落 0。
  assert.deepEqual(buildMemoryBudgetDrafts({ budgets: {}, defaults: { other: 1200 } }), {
    user_usage: '0', task_execution: '0', other: '1200', extension: '0',
  })
  assert.deepEqual(buildMemoryBudgetDrafts(null), {
    user_usage: '0', task_execution: '0', other: '0', extension: '0',
  })
  // 恢复默认：只读 defaults。
  assert.deepEqual(buildMemoryBudgetDrafts(SETTINGS_FIXTURE, { useDefaults: true }), {
    user_usage: '800', task_execution: '1600', other: '1200', extension: '800',
  })
  assert.deepEqual(
    buildMemoryBudgetDrafts({ budgets: { user_usage: 1 }, defaults: { user_usage: 800, other: 1200 } }, { useDefaults: true }),
    { user_usage: '800', task_execution: '0', other: '1200', extension: '0' },
  )
})

test('用量文案按「当前 120 / 800 token，2 条」生成并兜底缺档', () => {
  assert.equal(formatMemoryUsageLine({ tokens: 120, count: 2 }, 800), '当前 120 / 800 token，2 条')
  assert.equal(formatMemoryUsageLine({ tokens: 120, count: 2 }, '800'), '当前 120 / 800 token，2 条')
  assert.equal(formatMemoryUsageLine({ tokens: 0, count: 0 }, 1600), '当前 0 / 1600 token，0 条')
  // usage 缺档、字段缺失、非法值都按 0 兜底。
  assert.equal(formatMemoryUsageLine(undefined, 1200), '当前 0 / 1200 token，0 条')
  assert.equal(formatMemoryUsageLine({}, 1200), '当前 0 / 1200 token，0 条')
  assert.equal(formatMemoryUsageLine({ tokens: -5, count: -1 }, 1200), '当前 0 / 1200 token，0 条')
  assert.equal(formatMemoryUsageLine({ tokens: '30', count: '1' }, 800), '当前 30 / 800 token，1 条')
  // 预算无法解析时只展示已用量。
  assert.equal(formatMemoryUsageLine({ tokens: 120, count: 2 }, ''), '当前 120 token，2 条')
  assert.equal(formatMemoryUsageLine({ tokens: 120, count: 2 }, 'abc'), '当前 120 token，2 条')
  // 面板按四个类型逐个取 usage 时的整体表现。
  assert.deepEqual(
    MEMORY_TYPES.map((type) => formatMemoryUsageLine(SETTINGS_FIXTURE.usage[type], SETTINGS_FIXTURE.budgets[type])),
    ['当前 120 / 800 token，2 条', '当前 0 / 1600 token，0 条', '当前 0 / 1200 token，0 条', '当前 0 / 800 token，0 条'],
  )
})

test('非法输入整理成提交 payload：有错不发请求，合法项才进 memory_budgets', () => {
  const allValid = buildMemoryBudgetPayload({ user_usage: '900', task_execution: 1600, other: '1200', extension: '0' })
  assert.deepEqual(allValid, {
    ok: true,
    memory_budgets: { user_usage: 900, task_execution: 1600, other: 1200, extension: 0 },
    errors: [],
    invalidTypes: [],
  })

  const withInvalid = buildMemoryBudgetPayload({ user_usage: '900', task_execution: '-1', other: '1200', extension: 'abc' })
  assert.equal(withInvalid.ok, false)
  assert.deepEqual(withInvalid.memory_budgets, { user_usage: 900, other: 1200 })
  assert.deepEqual(withInvalid.invalidTypes, ['task_execution', 'extension'])
  assert.deepEqual(withInvalid.errors.map((item) => item.label), ['任务经验', '扩展经验'])
  assert.equal(withInvalid.errors[0].error, MEMORY_BUDGET_ERROR)

  // 允许只提交部分键（契约：缺省保持不变）。
  assert.deepEqual(buildMemoryBudgetPayload({ other: '800' }).memory_budgets, { other: 800 })
  assert.deepEqual(buildMemoryBudgetPayload({}), { ok: true, memory_budgets: {}, errors: [], invalidTypes: [] })
  assert.deepEqual(buildMemoryBudgetPayload(null), { ok: true, memory_budgets: {}, errors: [], invalidTypes: [] })
  // 空串属于非法输入，不应进入 payload。
  const blank = buildMemoryBudgetPayload({ user_usage: '', task_execution: ' ', other: '0', extension: '1' })
  assert.equal(blank.ok, false)
  assert.deepEqual(blank.invalidTypes, ['user_usage', 'task_execution'])
})

test('置信度与更新时间展示兜底', () => {
  assert.equal(formatMemoryConfidence(0.6), '0.60')
  assert.equal(formatMemoryConfidence(1), '1.00')
  assert.equal(formatMemoryConfidence(0), '0.00')
  assert.equal(formatMemoryConfidence(12), '12')
  assert.equal(formatMemoryConfidence('0.6'), '0.60')
  assert.equal(formatMemoryConfidence(null), '')
  assert.equal(formatMemoryConfidence('abc'), '')

  assert.equal(formatMemoryUpdatedAt(''), '')
  assert.equal(formatMemoryUpdatedAt(null), '')
  assert.equal(formatMemoryUpdatedAt('not-a-date'), '')
  assert.match(formatMemoryUpdatedAt('2026-10-17T08:30:00.000Z'), /\d{4}/)
})
