/**
 * Quick-create support for dedicated agents (WeWorker Bot).
 *
 * The built-in bot templates run in the renderer; the only backend addition
 * they need is a task-creation endpoint, so a finished flow can register its
 * scheduled tasks right after pairing (the pairing message itself makes the
 * owner's chat an observed notification target).
 *
 * Mirrors the create_agent_scheduled_task MCP tool: targets must come from
 * chats the bot has actually observed, and each task gets its own durable
 * context work.
 */
import type express from 'express'
import * as works from '../works-store.js'
import { scheduler, Scheduler } from '../scheduler.js'
import { agentChannelKey } from './agent-channel.js'
import { addAgentWork, DedicatedAgentError, getAgent } from './agent-store.js'

function requireValue(value: unknown, label: string, maxLength: number): string {
  const text = String(value ?? '').trim()
  if (!text) throw new DedicatedAgentError(`${label}不能为空`)
  if (text.length > maxLength) throw new DedicatedAgentError(`${label}过长`)
  return text
}

/** Resolve requested targets against the chats this agent's bot has observed. */
function resolveTargets(agentId: string, requested: Array<{ id?: unknown; chat_type?: unknown }>): works.AgentNotificationTarget[] {
  const observed = works.listChannelNotifyTargets(agentChannelKey(agentId))
  return [...new Set(requested.map((target) => String(target?.id ?? '')))].map((id) => {
    const chatType = Number(requested.find((target) => String(target?.id ?? '') === id)?.chat_type)
    const entry = observed.find((candidate) => candidate.user_id === id && Number(candidate.extra.chat_type) === chatType)
    if (!entry) throw new DedicatedAgentError('通知目标必须来自该WeWorker Bot 已观察到的企业微信会话')
    return {
      id: entry.user_id,
      chat_type: Number(entry.extra.chat_type) as 1 | 2,
      observed_user_id: entry.extra.user_id || '',
      observed_at: entry.updated_at,
    }
  })
}

export function registerQuickCreateRoutes(app: express.Express): void {
  /**
   * Create a scheduled task owned by an agent. Used by the quick-create flow
   * after pairing; the desktop owner drives it, so no in-conversation
   * confirmation is needed. WeCom bots must name at least one observed chat.
   */
  app.post('/dedicated-agents/:id/tasks', (req, res) => {
    try {
      const agent = getAgent(req.params.id)
      if (!agent) throw new DedicatedAgentError('WeWorker Bot 不存在', 404)
      if (!agent.enabled) throw new DedicatedAgentError('WeWorker Bot 已停用')
      const title = requireValue((req.body as Record<string, unknown>)?.title, '任务标题', 80)
      const prompt = requireValue((req.body as Record<string, unknown>)?.prompt_template, '任务提示词', 4000)
      const cron = requireValue((req.body as Record<string, unknown>)?.cron_expression, 'Cron 表达式', 100)
      const validation = Scheduler.validateCron(cron)
      if (!validation.valid) throw new DedicatedAgentError(`无效的 cron 表达式: ${validation.error}`)
      const requestedTargets = Array.isArray((req.body as Record<string, unknown>)?.targets)
        ? (req.body as { targets: Array<{ id?: unknown; chat_type?: unknown }> }).targets
        : []
      const targets = resolveTargets(agent.id, requestedTargets)
      // WeCom tasks notify through send_agent_message, which needs an explicit
      // observed target; WeChat bots cannot push, so an empty list is fine.
      if ((agent.channel ?? 'wecom') !== 'weixin' && targets.length === 0) {
        throw new DedicatedAgentError('请至少选择一个该WeWorker Bot 已观察到的企业微信会话')
      }
      const contextWork = works.createWork(`【定时】${title}`, agent.project_id ?? null)
      addAgentWork(agent.id, contextWork.id)
      const task = works.createScheduledTask({
        title,
        cron_expression: cron,
        prompt_template: prompt,
        enabled: true,
        notify_channels: [],
        agent_id: agent.id,
        owner_user_id: agent.owner_user_id,
        notification_targets: targets,
        context_work_id: contextWork.id,
      })
      scheduler.register(task.id, task.cron_expression)
      res.json({ task, next_run: Scheduler.getNextRun(task.cron_expression)?.toISOString() ?? null })
    } catch (error) {
      if (error instanceof DedicatedAgentError) {
        res.status(error.statusCode).json({ detail: error.message })
        return
      }
      res.status(500).json({ detail: error instanceof Error ? error.message : String(error) })
    }
  })
}
