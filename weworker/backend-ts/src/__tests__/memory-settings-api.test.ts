import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

function createMemorySettingsRoutes() {
  const source = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
  const start = source.indexOf('/** /memory/records 单次返回上限。 */')
  const end = source.indexOf("app.get('/memory/records'", start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)

  let settings = {
    memory_budgets: { user_usage: 800, task_execution: 1600, other: 1200, extension: 800 },
    scheduled_task_history_limit: 50,
  }
  const project = { id: 'fixture-project', name: '定时任务' }
  const response = { status: vi.fn().mockReturnThis(), json: vi.fn() }
  const routes = new Map<string, (request: { body?: unknown }, result: typeof response) => void>()
  const pruneScheduledTaskWorks = vi.fn().mockReturnValue(['fixture-old-work'])
  const broadcastSSE = vi.fn()
  const context = vm.createContext({
    app: {
      get: (route: string, handler: typeof routes extends Map<string, infer H> ? H : never) => routes.set(`GET ${route}`, handler),
      post: (route: string, handler: typeof routes extends Map<string, infer H> ? H : never) => routes.set(`POST ${route}`, handler),
    },
    getSettings: () => settings,
    updateSettings: (patch: typeof settings) => { settings = { ...settings, ...patch } },
    DEFAULT_MEMORY_BUDGETS: settings.memory_budgets,
    DEFAULT_SCHEDULED_TASK_HISTORY_LIMIT: 50,
    normalizeMemoryBudgets: (value: typeof settings.memory_budgets) => value,
    normalizeScheduledTaskHistoryLimit: (value: unknown) => {
      const parsed = Number(value)
      return Number.isInteger(parsed) && parsed >= 1 && parsed <= 500 ? parsed : 50
    },
    getMemoryStore: () => ({}),
    summarizeMemoryBudgetUsage: () => ({ user_usage: {}, task_execution: {}, other: {}, extension: {} }),
    enforceConfiguredMemoryBudget: () => {},
    store: {
      getProjectByName: () => project,
      pruneScheduledTaskWorks,
    },
    broadcastSSE,
  })
  vm.runInContext(ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context)

  return {
    invoke: (method: 'GET' | 'POST', body?: unknown) => routes.get(`${method} /memory/settings`)!({ body }, response),
    response,
    getSettings: () => settings,
    pruneScheduledTaskWorks,
    broadcastSSE,
  }
}

describe('memory settings API task-history retention', () => {
  it('saves the configured cap and immediately prunes old scheduled-task conversations', () => {
    const api = createMemorySettingsRoutes()
    api.invoke('POST', {
      memory_budgets: { user_usage: 900 },
      scheduled_task_history_limit: 12,
    })

    expect(api.getSettings().scheduled_task_history_limit).toBe(12)
    expect(api.pruneScheduledTaskWorks).toHaveBeenCalledWith('fixture-project', 12)
    expect(api.broadcastSSE).toHaveBeenCalledWith({ type: 'works_changed', workId: 'fixture-old-work' })
    expect(api.response.json).toHaveBeenCalledWith(expect.objectContaining({ scheduled_task_history_limit: 12 }))
  })

  it('preserves the existing cap for older clients that only send memory budgets', () => {
    const api = createMemorySettingsRoutes()
    api.invoke('POST', { memory_budgets: { user_usage: 900 } })

    expect(api.getSettings().scheduled_task_history_limit).toBe(50)
    expect(api.pruneScheduledTaskWorks).toHaveBeenCalledWith('fixture-project', 50)
  })
})
