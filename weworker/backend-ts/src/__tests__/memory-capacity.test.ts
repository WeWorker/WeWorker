import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  enforceMemoryBudget,
  estimateMemoryTokens,
  memoryBucketUsage,
  memorySimilarity,
  memoryValue,
  resolveMemoryBudgetKey,
  selectMemoriesToConsolidate,
  summarizeMemoryBudgetUsage,
  type BudgetedMemory,
} from '../memory/memory-capacity.js'
import { MemoryStore } from '../memory/memory-store.js'
import {
  DEFAULT_MEMORY_BUDGETS,
  DEFAULT_SCHEDULED_TASK_HISTORY_LIMIT,
  MAX_MEMORY_BUDGET,
  normalizeMemoryBudgets,
  normalizeScheduledTaskHistoryLimit,
} from '../config.js'

const NOW = new Date('2026-01-31T00:00:00.000Z')

const stores: MemoryStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

function createStore(database = new DatabaseSync(':memory:')): MemoryStore {
  const store = new MemoryStore(database)
  stores.push(store)
  return store
}

/** 直接写库以便固定时间戳；容量管理不读 FTS，因此不写入 memory_fts。 */
function seedMemory(
  database: DatabaseSync,
  input: {
    id: string
    type: string
    key: string
    content: string
    confidence: number
    updatedAt: string
  },
): void {
  database.prepare(`
    INSERT INTO memories (
      id, type, key, content, facts_json,
      user_scope, project_scope, site_scope, extension_scope,
      status, confidence, source_event_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '{}', 'local', NULL, NULL, NULL, 'active', ?, ?, ?, ?)
  `).run(
    input.id,
    input.type,
    input.key,
    input.content,
    input.confidence,
    `event-${input.id}`,
    input.updatedAt,
    input.updatedAt,
  )
}

function budgeted(input: Partial<BudgetedMemory> & { id: string }): BudgetedMemory {
  return {
    type: 'user_usage',
    key: 'k',
    content: 'c',
    confidence: 1,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...input,
  }
}

describe('estimateMemoryTokens', () => {
  it('returns 0 for empty text and scores CJK 1 token per char', () => {
    expect(estimateMemoryTokens('')).toBe(0)
    expect(estimateMemoryTokens('你好世界')).toBe(4)
  })

  it('scores non-CJK text at 3.5 chars per token and never returns 0 for non-empty text', () => {
    expect(estimateMemoryTokens('abcdefg')).toBe(2)
    expect(estimateMemoryTokens('a')).toBe(1)
    expect(estimateMemoryTokens('中文abc')).toBe(3)
  })
})

describe('memoryValue', () => {
  it('equals confidence for a freshly updated memory and halves after 30 days', () => {
    expect(memoryValue({ confidence: 1, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }, NOW)).toBe(1)
    const thirtyDaysAgo = new Date(NOW.getTime() - 30 * 86_400_000).toISOString()
    expect(memoryValue({ confidence: 1, createdAt: thirtyDaysAgo, updatedAt: thirtyDaysAgo }, NOW)).toBeCloseTo(0.5, 6)
  })

  it('falls back to createdAt, treats future timestamps as age 0 and clamps confidence', () => {
    const thirtyDaysAgo = new Date(NOW.getTime() - 30 * 86_400_000).toISOString()
    expect(memoryValue({ confidence: 0.8, createdAt: thirtyDaysAgo, updatedAt: '' }, NOW)).toBeCloseTo(0.4, 6)
    const tomorrow = new Date(NOW.getTime() + 86_400_000).toISOString()
    expect(memoryValue({ confidence: 2, createdAt: tomorrow, updatedAt: tomorrow }, NOW)).toBe(1)
  })
})

describe('memorySimilarity', () => {
  it('scores identical text as 1 and unrelated text as 0', () => {
    expect(memorySimilarity('用户默认使用中文回复', '用户默认使用中文回复')).toBe(1)
    expect(memorySimilarity('用户默认使用中文回复', '发票提交顺序')).toBe(0)
  })

  it('normalizes whitespace and case before comparing', () => {
    expect(memorySimilarity('User Name', 'username')).toBe(1)
  })

  it('returns 0 when either side has no token', () => {
    expect(memorySimilarity('', '')).toBe(0)
    expect(memorySimilarity('中文事实', '')).toBe(0)
  })
})

describe('selectMemoriesToConsolidate', () => {
  it('keeps the highest-value record and supersedes near duplicates', () => {
    const groups = selectMemoriesToConsolidate([
      budgeted({ id: 'low', key: 'lang', content: '用户默认使用中文回复', confidence: 0.4 }),
      budgeted({ id: 'high', key: 'lang', content: '用户默认使用中文回复。', confidence: 0.9 }),
    ], { now: NOW })

    expect(groups).toEqual([{ keep: 'high', supersede: ['low'] }])
  })

  it('ignores groups below the similarity threshold and groups without duplicates', () => {
    expect(selectMemoriesToConsolidate([
      budgeted({ id: 'a', key: 'lang', content: '用户默认使用中文回复', confidence: 0.9 }),
      budgeted({ id: 'b', key: 'billing', content: '发票提交顺序', confidence: 0.9 }),
    ], { now: NOW })).toEqual([])
  })
})

describe('enforceMemoryBudget', () => {
  it('does nothing when the bucket is within budget', () => {
    const database = new DatabaseSync(':memory:')
    const store = createStore(database)
    seedMemory(database, { id: 'm1', type: 'user_usage', key: 'k1', content: '稳定偏好一', confidence: 0.9, updatedAt: NOW.toISOString() })

    const result = enforceMemoryBudget(store, 'user_usage', 1_000, { now: NOW })

    expect(result.before).toBeGreaterThan(0)
    expect(result.after).toBe(result.before)
    expect(result.consolidated).toEqual([])
    expect(result.evicted).toEqual([])
    expect(store.get('m1')?.status).toBe('active')
  })

  it('consolidates near duplicates before evicting anything', () => {
    const database = new DatabaseSync(':memory:')
    const store = createStore(database)
    const content = '用户默认使用中文回复'
    seedMemory(database, { id: 'keep', type: 'user_usage', key: 'lang', content, confidence: 0.9, updatedAt: NOW.toISOString() })
    seedMemory(database, { id: 'dup', type: 'user_usage', key: 'lang', content: `${content}。`, confidence: 0.4, updatedAt: NOW.toISOString() })
    const budget = estimateMemoryTokens(`lang${content}`)

    const result = enforceMemoryBudget(store, 'user_usage', budget, { now: NOW })

    expect(result.consolidated).toEqual(['dup'])
    expect(result.evicted).toEqual([])
    expect(result.after).toBe(budget)
    expect(store.get('keep')?.status).toBe('active')
    expect(store.get('dup')?.status).toBe('superseded')
  })

  it('evicts lowest-value memories in ascending value order until the budget is met', () => {
    const database = new DatabaseSync(':memory:')
    const store = createStore(database)
    const day = 86_400_000
    // 同一长度内容 ⇒ 每条 token 相同，便于精确断言。
    const stamps: Array<[string, number, number, string]> = [
      ['newest', 0.9, 0, '稳定约定甲'],
      ['older', 0.7, 10, '稳定约定乙'],
      ['oldest', 0.5, 20, '稳定约定丙'],
      ['weakest', 0.2, 30, '稳定约定丁'],
    ]
    for (const [id, confidence, ageDays, content] of stamps) {
      seedMemory(database, {
        id,
        type: 'task_execution',
        key: 'k1',
        content,
        confidence,
        updatedAt: new Date(NOW.getTime() - ageDays * day).toISOString(),
      })
    }
    const perRecord = estimateMemoryTokens('k1稳定约定甲')
    expect(perRecord).toBe(6)
    expect(memoryBucketUsage(store, 'task_execution')).toEqual({ tokens: 24, count: 4 })

    const result = enforceMemoryBudget(store, 'task_execution', 12, { now: NOW })

    expect(result.before).toBe(24)
    expect(result.after).toBe(12)
    expect(result.evicted).toEqual(['weakest', 'oldest'])
    expect(store.get('weakest')?.status).toBe('superseded')
    expect(store.get('oldest')?.status).toBe('superseded')
    expect(store.get('older')?.status).toBe('active')
    expect(store.get('newest')?.status).toBe('active')
  })

  it('never empties a bucket: budget 0 keeps exactly one memory', () => {
    const database = new DatabaseSync(':memory:')
    const store = createStore(database)
    const contents: Record<string, string> = { a: '稳定约定甲', b: '稳定约定乙', c: '稳定约定丙' }
    for (const id of ['a', 'b', 'c']) {
      seedMemory(database, {
        id,
        type: 'other',
        key: 'k1',
        content: contents[id],
        confidence: id === 'a' ? 0.9 : 0.4,
        updatedAt: NOW.toISOString(),
      })
    }

    const result = enforceMemoryBudget(store, 'other', 0, { now: NOW })

    expect(result.consolidated).toEqual([])
    expect(result.evicted).toHaveLength(2)
    expect(store.listActiveAll().filter((memory) => memory.type === 'other')).toHaveLength(1)
    expect(store.get('a')?.status).toBe('active')
  })

  it('archives every extension:* record into the extension bucket and leaves other buckets alone', () => {
    const database = new DatabaseSync(':memory:')
    const store = createStore(database)
    seedMemory(database, { id: 'ext-a', type: 'extension:alpha', key: 'k1', content: '扩展经验一', confidence: 0.9, updatedAt: NOW.toISOString() })
    seedMemory(database, { id: 'ext-b', type: 'extension:beta', key: 'k1', content: '扩展经验二', confidence: 0.5, updatedAt: NOW.toISOString() })
    seedMemory(database, { id: 'pref', type: 'user_usage', key: 'k1', content: '稳定偏好一', confidence: 0.9, updatedAt: NOW.toISOString() })

    expect(memoryBucketUsage(store, 'extension')).toEqual({
      tokens: estimateMemoryTokens('k1扩展经验一') + estimateMemoryTokens('k1扩展经验二'),
      count: 2,
    })

    const result = enforceMemoryBudget(store, 'extension', 0, { now: NOW })

    expect(result.consolidated).toEqual([])
    expect(result.evicted).toEqual(['ext-b'])
    expect(store.get('ext-a')?.status).toBe('active')
    expect(store.get('pref')?.status).toBe('active')
  })

  it('summarizes usage for all four buckets', () => {
    const database = new DatabaseSync(':memory:')
    const store = createStore(database)
    seedMemory(database, { id: 'pref', type: 'user_usage', key: 'k1', content: '稳定偏好一', confidence: 0.9, updatedAt: NOW.toISOString() })
    seedMemory(database, { id: 'ext', type: 'extension:alpha', key: 'k1', content: '扩展经验一', confidence: 0.9, updatedAt: NOW.toISOString() })

    expect(summarizeMemoryBudgetUsage(store)).toEqual({
      user_usage: { tokens: estimateMemoryTokens('k1稳定偏好一'), count: 1 },
      task_execution: { tokens: 0, count: 0 },
      other: { tokens: 0, count: 0 },
      extension: { tokens: estimateMemoryTokens('k1扩展经验一'), count: 1 },
    })
  })
})

describe('resolveMemoryBudgetKey', () => {
  it('maps concrete memory types to budget buckets', () => {
    expect(resolveMemoryBudgetKey('user_usage')).toBe('user_usage')
    expect(resolveMemoryBudgetKey('task_execution')).toBe('task_execution')
    expect(resolveMemoryBudgetKey('other')).toBe('other')
    expect(resolveMemoryBudgetKey('extension:alpha')).toBe('extension')
    expect(resolveMemoryBudgetKey('unsupported_type')).toBeUndefined()
    expect(resolveMemoryBudgetKey(undefined)).toBeUndefined()
  })
})

describe('normalizeMemoryBudgets', () => {
  it('falls back to defaults for missing or invalid input', () => {
    expect(normalizeMemoryBudgets(undefined)).toEqual(DEFAULT_MEMORY_BUDGETS)
    expect(normalizeMemoryBudgets(null)).toEqual(DEFAULT_MEMORY_BUDGETS)
    expect(normalizeMemoryBudgets('not-an-object')).toEqual(DEFAULT_MEMORY_BUDGETS)
    expect(normalizeMemoryBudgets([])).toEqual(DEFAULT_MEMORY_BUDGETS)
    expect(normalizeMemoryBudgets({ user_usage: -1, task_execution: 'x', other: Number.NaN }))
      .toEqual(DEFAULT_MEMORY_BUDGETS)
  })

  it('falls back to defaults above the cap and keeps 0 as a valid budget', () => {
    expect(normalizeMemoryBudgets({ extension: MAX_MEMORY_BUDGET + 1 }).extension).toBe(DEFAULT_MEMORY_BUDGETS.extension)
    expect(normalizeMemoryBudgets({ extension: MAX_MEMORY_BUDGET }).extension).toBe(MAX_MEMORY_BUDGET)
    expect(normalizeMemoryBudgets({ other: 0 }).other).toBe(0)
  })

  it('accepts partial numeric input and floors decimals', () => {
    expect(normalizeMemoryBudgets({ other: 900 })).toEqual({ ...DEFAULT_MEMORY_BUDGETS, other: 900 })
    expect(normalizeMemoryBudgets({ other: '640' }).other).toBe(640)
    expect(normalizeMemoryBudgets({ other: 12.7 }).other).toBe(12)
  })
})

describe('normalizeScheduledTaskHistoryLimit', () => {
  it('defaults missing or out-of-range values to 50 and clamps valid integers', () => {
    expect(DEFAULT_SCHEDULED_TASK_HISTORY_LIMIT).toBe(50)
    expect(normalizeScheduledTaskHistoryLimit(undefined)).toBe(50)
    expect(normalizeScheduledTaskHistoryLimit(0)).toBe(50)
    expect(normalizeScheduledTaskHistoryLimit(501)).toBe(50)
    expect(normalizeScheduledTaskHistoryLimit('24')).toBe(24)
    expect(normalizeScheduledTaskHistoryLimit(12.8)).toBe(12)
  })
})

describe('memory_budgets settings persistence', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('defaults a legacy settings file without memory_budgets and persists normalized values', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-memory-budget-fixture-'))
    vi.spyOn(os, 'homedir').mockReturnValue(root)
    vi.resetModules()
    const settingsFile = path.join(root, '.weworker', 'settings.json')
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
    fs.writeFileSync(settingsFile, JSON.stringify({ onboarding_completed: true, active_provider: 'anthropic' }))

    const config = await import('../config.js')
    config.resetSettingsStateForTests()
    expect(config.getSettings().memory_budgets).toEqual(config.DEFAULT_MEMORY_BUDGETS)
    expect(config.getSettings().scheduled_task_history_limit).toBe(50)

    expect(config.updateSettings({
      memory_budgets: { ...config.DEFAULT_MEMORY_BUDGETS, other: 640, user_usage: -5 },
      scheduled_task_history_limit: 24,
    }).memory_budgets).toEqual({ ...config.DEFAULT_MEMORY_BUDGETS, other: 640 })

    config.resetSettingsStateForTests()
    expect(config.getSettings().memory_budgets).toEqual({ ...config.DEFAULT_MEMORY_BUDGETS, other: 640 })
    expect(config.getSettings().scheduled_task_history_limit).toBe(24)
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).memory_budgets.other).toBe(640)
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).scheduled_task_history_limit).toBe(24)
    fs.rmSync(root, { recursive: true, force: true })
  })
})
