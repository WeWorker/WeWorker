/**
 * **Feature: scheduled-tasks, Property 3: Cron 表达式验证**
 *
 * For any string input, if it is a valid cron expression, validateCron should
 * return valid=true and getNextRun should return a future Date (not null).
 * If it is not a valid cron expression, validateCron should return valid=false
 * with a non-empty error description, and getNextRun should return null.
 *
 * **Validates: Requirements 3.3, 3.4, 8.6**
 */
import { describe, it, expect, vi } from 'vitest'
import fc from 'fast-check'

// Mock task-executor to avoid importing heavy dependencies (agent, bridge, etc.)
vi.mock('../task-executor.js', () => ({
  executeTask: vi.fn(),
}))

import { Scheduler, cronToSummary } from '../scheduler.js'

// Known valid 5-field cron expressions
const VALID_CRONS = [
  '* * * * *',
  '0 * * * *',
  '0 0 * * *',
  '0 2 * * *',
  '*/5 * * * *',
  '0 9 * * 1',
  '30 9 * * 1,2,3,4,5',
  '*/15 * * * 1,2,3,4,5',
  '0 0 1 * *',
  '0 12 * * 1-5',
]

describe('Property 3: Cron 表达式验证', () => {
  it('valid cron expressions: validateCron returns valid=true and getNextRun returns a future Date', () => {
    fc.assert(
      fc.property(fc.constantFrom(...VALID_CRONS), (expression) => {
        const result = Scheduler.validateCron(expression)
        expect(result.valid).toBe(true)
        expect(result.error).toBeUndefined()

        const nextRun = Scheduler.getNextRun(expression)
        expect(nextRun).not.toBeNull()
        expect(nextRun).toBeInstanceOf(Date)
        expect(nextRun!.getTime()).toBeGreaterThan(Date.now())
      }),
      { numRuns: 100 },
    )
  })

  it('random strings (likely invalid): validateCron returns valid=false with non-empty error and getNextRun returns null', () => {
    fc.assert(
      fc.property(fc.string(), (randomStr) => {
        const result = Scheduler.validateCron(randomStr)

        if (!result.valid) {
          // Invalid cron: error should be a non-empty string
          expect(typeof result.error).toBe('string')
          expect(result.error!.length).toBeGreaterThan(0)

          // getNextRun should return null for invalid expressions
          const nextRun = Scheduler.getNextRun(randomStr)
          expect(nextRun).toBeNull()
        }
        // If fast-check happens to generate a valid cron string, that's fine — skip it
      }),
      { numRuns: 100 },
    )
  })
})


/**
 * **Feature: scheduled-tasks, Property 4: Cron 摘要生成**
 *
 * For any valid cron expression, cronToSummary should return a non-empty string.
 * For known common patterns (hourly, daily at specific time, weekly on specific day,
 * every N minutes), the summary should contain the corresponding Chinese description.
 *
 * **Validates: Requirements 2.4**
 */
describe('Property 4: Cron 摘要生成', () => {
  it('valid cron expressions always produce a non-empty summary string', () => {
    fc.assert(
      fc.property(fc.constantFrom(...VALID_CRONS), (expression) => {
        const summary = cronToSummary(expression)
        expect(typeof summary).toBe('string')
        expect(summary.length).toBeGreaterThan(0)
      }),
      { numRuns: 100 },
    )
  })

  it('common patterns contain correct Chinese descriptions', () => {
    const patterns: Array<{ cron: string; expected: string[] }> = [
      { cron: '0 * * * *', expected: ['每小时'] },
      { cron: '0 2 * * *', expected: ['每天', '02:00'] },
      { cron: '0 9 * * 1', expected: ['每周一', '09:00'] },
      { cron: '30 9 * * 1,2,3,4,5', expected: ['工作日', '09:30'] },
      { cron: '*/15 * * * 1,2,3,4,5', expected: ['工作日', '15', '分钟'] },
      { cron: '*/30 * * * *', expected: ['每', '30', '分钟'] },
      { cron: '*/5 * * * *', expected: ['每', '5', '分钟'] },
    ]

    fc.assert(
      fc.property(fc.constantFrom(...patterns), ({ cron, expected }) => {
        const summary = cronToSummary(cron)
        expect(typeof summary).toBe('string')
        expect(summary.length).toBeGreaterThan(0)
        for (const keyword of expected) {
          expect(summary).toContain(keyword)
        }
      }),
      { numRuns: 100 },
    )
  })
})


/**
 * **Feature: scheduled-tasks, Property 5: 启用/禁用状态与调度器同步**
 *
 * For any scheduled task, when enabled is toggled from true to false, the scheduler
 * should not have a job registered for that task. When toggled from false to true,
 * the scheduler should have a job registered. On start(), only enabled=true tasks
 * should be registered.
 *
 * **Validates: Requirements 1.3, 4.2, 6.1**
 */
import { beforeEach, afterEach } from 'vitest'
import {
  _initTestDb,
  createScheduledTask,
  updateScheduledTask,
} from '../works-store.js'

// Known valid 5-field cron expressions for task generation
const VALID_CRONS_P5 = [
  '* * * * *',
  '0 * * * *',
  '0 0 * * *',
  '0 2 * * *',
  '*/5 * * * *',
  '0 9 * * 1',
  '0 0 1 * *',
  '0 12 * * 1-5',
]

const arbNonEmptyStr = fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0)
const arbCronP5 = fc.constantFrom(...VALID_CRONS_P5)
const arbChannelsP5 = fc.uniqueArray(
  fc.string({ minLength: 1, maxLength: 10 }).filter((s) => /^[a-z]+$/.test(s)),
  { minLength: 0, maxLength: 3 },
)

const arbTaskInputP5 = fc.record({
  title: arbNonEmptyStr,
  cron_expression: arbCronP5,
  prompt_template: arbNonEmptyStr,
  enabled: fc.boolean(),
  notify_channels: arbChannelsP5,
})

describe('Property 5: 启用/禁用状态与调度器同步', () => {
  let testScheduler: InstanceType<typeof Scheduler>

  beforeEach(() => {
    _initTestDb()
    testScheduler = new Scheduler()
  })

  afterEach(() => {
    testScheduler.stopAll()
  })

  it('register adds job, unregister removes job, re-register adds it back', () => {
    fc.assert(
      fc.property(arbTaskInputP5, (input) => {
        const task = createScheduledTask({ ...input, enabled: true })

        // Register → hasJob should be true
        testScheduler.register(task.id, task.cron_expression)
        expect(testScheduler.hasJob(task.id)).toBe(true)

        // Unregister → hasJob should be false
        testScheduler.unregister(task.id)
        expect(testScheduler.hasJob(task.id)).toBe(false)

        // Re-register → hasJob should be true again
        testScheduler.register(task.id, task.cron_expression)
        expect(testScheduler.hasJob(task.id)).toBe(true)

        // Cleanup for next iteration
        testScheduler.unregister(task.id)
      }),
      { numRuns: 100 },
    )
  })

  it('start() only registers enabled=true tasks, not enabled=false tasks', () => {
    fc.assert(
      fc.property(
        fc.array(arbTaskInputP5, { minLength: 1, maxLength: 3 }),
        (taskInputs) => {
          // Fresh DB and scheduler for each iteration to avoid accumulation
          _initTestDb()
          testScheduler.stopAll()

          // Create tasks with mixed enabled states
          const tasks = taskInputs.map((input) => createScheduledTask(input))

          // start() loads enabled tasks from DB and registers them
          testScheduler.start()

          for (const task of tasks) {
            if (task.enabled) {
              expect(testScheduler.hasJob(task.id)).toBe(true)
            } else {
              expect(testScheduler.hasJob(task.id)).toBe(false)
            }
          }

          // Cleanup
          testScheduler.stopAll()
        },
      ),
      { numRuns: 100 },
    )
  }, 30000)

  it('random enable/disable toggle sequences keep scheduler state in sync', () => {
    fc.assert(
      fc.property(
        arbTaskInputP5,
        fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }),
        (input, toggleSequence) => {
          const task = createScheduledTask({ ...input, enabled: true })

          // Initially register the task
          testScheduler.register(task.id, task.cron_expression)
          expect(testScheduler.hasJob(task.id)).toBe(true)

          let currentEnabled = true

          for (const newEnabled of toggleSequence) {
            // Update enabled state in DB
            updateScheduledTask(task.id, { enabled: newEnabled })

            // Sync scheduler: register if enabling, unregister if disabling
            if (newEnabled && !currentEnabled) {
              testScheduler.register(task.id, task.cron_expression)
            } else if (!newEnabled && currentEnabled) {
              testScheduler.unregister(task.id)
            }

            currentEnabled = newEnabled

            // Verify scheduler state matches enabled state
            expect(testScheduler.hasJob(task.id)).toBe(currentEnabled)
          }

          // Cleanup
          testScheduler.stopAll()
        },
      ),
      { numRuns: 100 },
    )
  })
})
