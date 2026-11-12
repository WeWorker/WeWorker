import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

vi.mock('../task-executor.js', () => ({ executeTask: vi.fn() }))
vi.mock('node-cron', () => ({ default: { schedule: vi.fn(() => ({ stop: vi.fn() })) } }))
import cron from 'node-cron'
import { executeTask } from '../task-executor.js'
import { Scheduler } from '../scheduler.js'
import { _initTestDb, createScheduledTask, getScheduledTask } from '../works-store.js'

beforeEach(() => { _initTestDb(); vi.clearAllMocks(); vi.mocked(executeTask).mockReset() })
const createTask = (enabled = false, prompt = 'Summarize public example data') => createScheduledTask({
  title: 'Example task', cron_expression: '0 9 * * 1,2', prompt_template: prompt,
  enabled, notify_channels: [],
})
const settle = () => new Promise(resolve => setImmediate(resolve))

describe('manual scheduled-task execution', () => {
  it('runs a disabled task without changing its schedule or enabled state and rejects duplicate starts', async () => {
    const task = createTask()
    const scheduler = new Scheduler()
    let finish!: () => void
    vi.mocked(executeTask).mockImplementation(() => new Promise(resolve => { finish = () => resolve({} as never) }))
    expect(scheduler.runNow(task.id)).toBe('started')
    expect(scheduler.isRunning(task.id)).toBe(true)
    expect(scheduler.runNow(task.id)).toBe('running')
    expect(executeTask).toHaveBeenCalledTimes(1)
    expect(getScheduledTask(task.id)).toEqual(task)
    expect(cron.schedule).not.toHaveBeenCalled()
    finish(); await settle()
    expect(scheduler.isRunning(task.id)).toBe(false)
    expect(scheduler.runNow(task.id)).toBe('started')
    finish(); await settle()
  })

  it('shares the lock with cron in both directions', async () => {
    const task = createTask(true)
    const scheduler = new Scheduler()
    let finish!: () => void
    vi.mocked(executeTask).mockImplementation(() => new Promise(resolve => { finish = () => resolve({} as never) }))
    scheduler.register(task.id, task.cron_expression)
    const tick = vi.mocked(cron.schedule).mock.calls[0][1] as () => Promise<void>
    scheduler.runNow(task.id)
    await tick()
    expect(executeTask).toHaveBeenCalledTimes(1)
    finish(); await settle()
    const scheduled = tick()
    expect(scheduler.runNow(task.id)).toBe('running')
    finish(); await scheduled
    expect(scheduler.isRunning(task.id)).toBe(false)
    expect(executeTask).toHaveBeenCalledTimes(2)
    scheduler.stopAll()
  })

  it('releases its lock after an execution error', async () => {
    const task = createTask()
    const scheduler = new Scheduler()
    vi.mocked(executeTask).mockRejectedValue(new Error('Fixture failure'))
    expect(scheduler.runNow(task.id)).toBe('started')
    await settle()
    expect(scheduler.isRunning(task.id)).toBe(false)
    expect(scheduler.runNow(task.id)).toBe('started')
    await settle()
  })

  it('rejects missing tasks and blank prompts without starting an executor', () => {
    const scheduler = new Scheduler()
    expect(scheduler.runNow('missing')).toBe('not_found')
    expect(scheduler.runNow(createTask(false, '  ').id)).toBe('empty_prompt')
    expect(executeTask).not.toHaveBeenCalled()
  })

  it.each([
    ['started', 202], ['not_found', 404], ['running', 409], ['empty_prompt', 400],
  ])('POST run maps %s to HTTP %s without awaiting task completion', (result, status) => {
    const source = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
    const start = source.indexOf("app.post('/scheduled-tasks/:id/run'")
    const end = source.indexOf("app.patch('/scheduled-tasks/:id'", start)
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start)
    let handler!: (req: unknown, res: unknown) => void
    const runNow = vi.fn(() => result)
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }
    vm.runInNewContext(ts.transpileModule(source.slice(start, end), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText, { scheduler: { runNow }, app: { post: (_path: string, callback: typeof handler) => { handler = callback } } })
    handler({ params: { id: 'fixture-task' } }, res)
    expect(runNow).toHaveBeenCalledWith('fixture-task')
    expect(res.status).toHaveBeenCalledWith(status)
    expect(res.json).toHaveBeenCalledOnce()
  })
})
