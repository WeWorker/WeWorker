import cron from 'node-cron'
import { CronExpressionParser } from 'cron-parser'
import * as store from './works-store.js'
// task-executor.ts will be created in task 3.3
import { executeTask } from './task-executor.js'
import { createLogger } from './logger.js'

const log = createLogger('scheduler')

const WEEKDAY_NAMES: Record<string, string> = {
  '0': '日',
  '1': '一',
  '2': '二',
  '3': '三',
  '4': '四',
  '5': '五',
  '6': '六',
  '7': '日',
}

function weekdaySummary(weekday: string): string | null {
  if (weekday === '1-5' || weekday === '1,2,3,4,5') return '工作日'
  if (weekday === '*') return '每天'
  const days = weekday.split(',')
  if (!days.every((day) => /^\d$/.test(day) && WEEKDAY_NAMES[day])) return null
  if (days.length === 1) return `每周${WEEKDAY_NAMES[days[0]]}`
  return `每周${days.map((day) => WEEKDAY_NAMES[day]).join('、')}`
}

/**
 * 将常见 cron 表达式转换为中文摘要。
 * 支持：每小时、每 N 分钟、每天指定时间、每周指定日期时间。
 * 不匹配的模式返回原始表达式。
 */
export function cronToSummary(expression: string): string {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) return expression

  const [minute, hour, day, month, weekday] = parts

  // 每 N 分钟: */N * * * *
  const everyNMin = minute.match(/^\*\/(\d+)$/)
  if (everyNMin && hour === '*' && day === '*' && month === '*') {
    const days = weekdaySummary(weekday)
    if (days) return `${days === '每天' ? '' : `${days} `}每 ${everyNMin[1]} 分钟`
  }

  // 每小时: 0 * * * *
  if (minute === '0' && hour === '*' && day === '*' && month === '*') {
    const days = weekdaySummary(weekday)
    if (days) return `${days === '每天' ? '' : `${days} `}每小时`
  }

  if (/^\d+$/.test(minute) && hour === '*' && day === '*' && month === '*') {
    const days = weekdaySummary(weekday)
    if (days) return `${days === '每天' ? '' : `${days} `}每小时的第${minute}分`
  }

  // 需要固定的 minute 和 hour 数字
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return expression
  if (day !== '*' || month !== '*') return expression

  const hh = hour.padStart(2, '0')
  const mm = minute.padStart(2, '0')

  const days = weekdaySummary(weekday)
  if (days === '每天') return `每天 ${hh}:${mm}`
  return days ? `${days} ${hh}:${mm}` : expression
}

class Scheduler {
  private jobs: Map<string, ReturnType<typeof cron.schedule>> = new Map()
  private running = new Set<string>()

  /**
   * 注册一个定时任务到调度器。
   * cron 触发时检查任务是否启用，若启用则调用 TaskExecutor 执行。
   */
  register(taskId: string, cronExpression: string): void {
    this.unregister(taskId)

    const job = cron.schedule(cronExpression, async () => {
      const task = store.getScheduledTask(taskId)
      if (!task || !task.enabled || this.running.has(taskId)) return
      this.running.add(taskId)
      try {
        await executeTask(task)
      } catch (err) {
        log.error(`Failed to execute task ${taskId}:`, err)
      } finally {
        this.running.delete(taskId)
      }
    })

    this.jobs.set(taskId, job)
  }

  /**
   * 从调度器注销一个定时任务，停止并移除 cron job。
   */
  unregister(taskId: string): void {
    const job = this.jobs.get(taskId)
    if (job) {
      job.stop()
      this.jobs.delete(taskId)
    }
  }

  /**
   * 验证 cron 表达式是否合法。
   */
  static validateCron(expression: string): { valid: boolean; error?: string } {
    try {
      CronExpressionParser.parse(expression)
      return { valid: true }
    } catch (err) {
      return { valid: false, error: (err as Error).message }
    }
  }

  /**
   * 获取 cron 表达式的下次执行时间。
   */
  static getNextRun(expression: string): Date | null {
    try {
      const interval = CronExpressionParser.parse(expression)
      return interval.next().toDate()
    } catch {
      return null
    }
  }

  /**
   * 启动调度器：从 WorksStore 加载所有 enabled 任务并注册。
   */
  start(): void {
    const tasks = store.getEnabledScheduledTasks()
    for (const task of tasks) {
      this.register(task.id, task.cron_expression)
    }
  }

  /**
   * 停止所有已注册的 cron job。
   */
  stopAll(): void {
    for (const [, job] of this.jobs) {
      job.stop()
    }
    this.jobs.clear()
  }

  /**
   * 检查某个 taskId 是否已注册在调度器中（用于测试和状态检查）。
   */
  hasJob(taskId: string): boolean {
    return this.jobs.has(taskId)
  }
}

export const scheduler = new Scheduler()
export { Scheduler }
