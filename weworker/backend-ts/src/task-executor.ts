/**
 * Task Executor — 执行单个定时任务的 AI 对话流程。
 * 复用现有 streamChat + runChannelChat 模式，非交互式执行。
 */
import { getSettings } from './config.js'
import { streamChat } from './agent.js'
import { userFileBlock, userImageBlock } from './user-media.js'
import { resolveStyleId } from './style-settings.js'
import * as store from './works-store.js'
import type { ScheduledTask, ContentBlock } from './works-store.js'
import { parseAllAdapters } from './adapter-parser.js'
import { getSiteEnabled } from './config.js'
import { createLogger } from './logger.js'
import { processMemoryEvent } from './memory/memory-lifecycle.js'
import { buildMemoryEventContext, type MemoryAdapterIdentity } from './memory/memory-event-context.js'
import { planTaskMemoryEvent } from './memory/memory-event-planner.js'
import { getMemoryStore } from './memory/memory-store.js'
import { enforceConfiguredMemoryBudget } from './memory/memory-capacity.js'
import type { MemoryEventTrigger, MemoryScope, MemoryType, MemoryUpdateCandidate } from './memory/memory-types.js'
import { redactSensitive } from './http-security.js'
import { createTurnTimingLedger } from './turn-timing.js'
import { getAgent } from './dedicated-agents/agent-store.js'
import { buildAgentChatOptions } from './dedicated-agents/agent-runtime.js'

const memoryLog = createLogger('memory')

export interface ExecutionResult {
  workId: string
  executionId: string
  status: 'completed' | 'failed'
  summary?: string
  error?: string
}

interface NotificationPayload {
  taskId: string
  taskTitle: string
  status: 'completed' | 'failed'
  summary?: string
  fullText?: string
  error?: string
  executionId: string
  workId: string
}

/**
 * 安全调用通知器。notifier.ts 将在 task 5.1 中创建，
 * 在此之前动态导入会失败，静默忽略。
 */
async function safeNotify(payload: NotificationPayload, channels: string[]): Promise<void> {
  try {
    const mod = await import(/* webpackIgnore: true */ './notifier.js')
    await mod.notify(payload, channels)
  } catch {
    // Notifier module not yet available — silently skip
  }
}

function queueTaskMemoryProcessing(input: {
  executionId: string
  trigger: MemoryEventTrigger
  scope: MemoryScope
  expectedMemoryType?: MemoryType
  candidate: MemoryUpdateCandidate
}): void {
  let store: ReturnType<typeof getMemoryStore>
  try {
    store = getMemoryStore()
  } catch (error) {
    memoryLog.warn('task memory store unavailable', { executionId: input.executionId, error: redactSensitive(error instanceof Error ? error.message : String(error)) })
    return
  }
  void processMemoryEvent({
    eventId: `task:${input.executionId}:${input.trigger}`,
    scope: input.scope,
    expectedMemoryType: input.expectedMemoryType,
    store,
    candidate: input.candidate,
  }).then((result) => {
    if (result.status === 'failed') {
      memoryLog.warn('task memory processing failed', { executionId: input.executionId, error: redactSensitive(result.error) })
      return
    }
    // 与对话路径一致：写入成功后按当前配置的预算执行容量管理。
    enforceConfiguredMemoryBudget(store, input.expectedMemoryType, getSettings().memory_budgets, (payload) => {
      memoryLog.info('task memory budget enforced', { executionId: input.executionId, ...payload })
    })
  }).catch((error) => {
    memoryLog.warn('task memory processing crashed', { executionId: input.executionId, error: redactSensitive(error instanceof Error ? error.message : String(error)) })
  })
}

/**
 * 执行一个定时任务：创建 work、记录执行、调用 AI Agent、更新状态。
 */
export async function executeTask(task: ScheduledTask): Promise<ExecutionResult> {
  const taskProject = store.getOrCreateScheduledTaskProject()
  const taskWorkspace = store.ensureScheduledTaskWorkspace(task.id)
  const agent = task.agent_id ? getAgent(task.agent_id) : null
  // Skip tasks with empty prompt — nothing to execute
  if (!task.prompt_template?.trim()) {
    const work = store.createWork(`[定时] ${task.title} · 跳过`, taskProject.id, taskWorkspace)
    const execution = store.createTaskExecution(task.id, work.id)
    store.updateTaskExecution(execution.id, {
      status: 'failed',
      error_message: '任务提示词为空，跳过执行',
      completed_at: new Date().toISOString(),
    })
    await safeNotify({
      taskId: task.id,
      taskTitle: task.title,
      status: 'failed',
      error: '任务提示词为空，跳过执行',
      executionId: execution.id,
      workId: work.id,
    }, task.notify_channels)
    return { workId: work.id, executionId: execution.id, status: 'failed', error: '任务提示词为空' }
  }

  // 1. Create a new work for this execution (with scheduled task identifier)
  const previousExecution = store.listTaskExecutions(task.id)[0]
  const now = new Date()
  const timeStr = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  // 1. Dedicated-Agent tasks reuse their own durable task conversation. This
  // lets the model reason over previous checks and decide whether to notify.
  if (task.agent_id && (!agent || !agent.enabled)) {
    const work = store.createWork(`[定时] ${task.title} · 已停用`, taskProject.id, taskWorkspace)
    const execution = store.createTaskExecution(task.id, work.id)
    store.updateTaskExecution(execution.id, { status: 'failed', error_message: '专属 Agent 不存在或已停用', completed_at: new Date().toISOString() })
    await safeNotify({
      taskId: task.id,
      taskTitle: task.title,
      status: 'failed',
      error: '专属 Agent 不存在或已停用',
      executionId: execution.id,
      workId: work.id,
    }, task.notify_channels)
    return { workId: work.id, executionId: execution.id, status: 'failed', error: '专属 Agent 不存在或已停用' }
  }
  const work = agent && task.context_work_id
    ? (store.getWork(task.context_work_id) ?? store.createWork(`【定时】${task.title}`, agent.project_id ?? taskProject.id))
    : store.createWork(`[定时] ${task.title} · ${timeStr}`, taskProject.id, taskWorkspace)

  // 2. Create execution record (pending)
  const execution = store.createTaskExecution(task.id, work.id)
  const assistantContent: ContentBlock[] = []
  let memoryAdapters: MemoryAdapterIdentity[] = []
  let taskMemoryContext = buildMemoryEventContext({
    baseScope: { user: 'local' },
    userMessage: task.prompt_template,
    adapters: [],
    toolCalls: [],
  })
  let memoryCandidate: MemoryUpdateCandidate | undefined

  // 3. Append the prompt template as user message
  store.appendMessage(work.id, 'user', [{ type: 'text', text: agent
    ? `【定时任务执行】\n${task.prompt_template}\n\n请自行判断本轮是否值得通知。只有确有必要时才调用 send_agent_message；不调用就不会发送任何消息。`
    : task.prompt_template }])

  // 4. Update execution to running
  store.updateTaskExecution(execution.id, { status: 'running' })

  try {
    // 5. Get work with messages and settings
    const workWithMessages = store.getWorkWithMessages(work.id)!
    const settings = getSettings()

    // 6. Build enabled adapter IDs (same pattern as server.ts chat endpoint)
    const allAdapters = parseAllAdapters()
    const enabledAdapterIds = new Set(
      [...allAdapters.entries()].filter(([id, a]) => getSiteEnabled(id, a.defaultEnabled, a.managed?.enabled)).map(([id]) => id),
    )
    memoryAdapters = [...allAdapters.values()].map((adapter) => ({
      id: adapter.id,
      name: adapter.name,
      match: adapter.match,
    }))
    taskMemoryContext = buildMemoryEventContext({
      baseScope: { user: 'local' },
      userMessage: task.prompt_template,
      adapters: memoryAdapters,
      toolCalls: [],
    })

    // 7. Call streamChat and iterate to completion (non-streaming, like runChannelChat)
    let currentText = ''
    // Per-turn timing (mirrors server.ts /chat so scheduled results also show durations).
    // llm 与 exec 互不重叠：llm + exec === total，缺 tool_call_result 的工具不会计进 llm。
    const chatStartTime = Date.now()
    const turnTiming = createTurnTimingLedger({ startedAt: chatStartTime })
    let stepIndex = 0
    const seenToolIds = new Set<string>()

    const styleId = resolveStyleId(workWithMessages, settings)

    for await (const event of streamChat(workWithMessages.messages, settings, undefined, {
      streaming: false,
      enabledAdapterIds,
      workId: workWithMessages.id,
      styleId,
      memoryScope: taskMemoryContext.scope,
      ...(agent ? {
        ...buildAgentChatOptions({ agent, siteName: agent.site_id, taskId: task.id, knownSiteIds: [...allAdapters.keys()] }),
        memoryEnabled: false,
      } : {}),
      memoryExpectedType: 'task_execution',
      memoryTriggerHint: previousExecution?.status === 'failed' ? 'task_recovered' : 'task_completed',
      previousTaskFailed: previousExecution?.status === 'failed',
      // The task's own work shows its images and files on the desktop.
      userMedia: {
        image: (image) => {
          if (currentText) { assistantContent.push({ type: 'text', text: currentText }); currentText = '' }
          assistantContent.push(userImageBlock(image))
        },
        file: (file) => {
          if (currentText) { assistantContent.push({ type: 'text', text: currentText }); currentText = '' }
          assistantContent.push(userFileBlock(file))
        },
      },
    })) {
      if (event.type === 'skill_context' && event.skillContext) {
        assistantContent.push(event.skillContext)
      } else if (event.type === 'text_delta' && event.content) {
        currentText += event.content
      } else if (event.type === 'memory_candidate' && event.candidate) {
        memoryCandidate = event.candidate
      } else if (event.type === 'tool_call_start' && event.id) {
        if (currentText) {
          assistantContent.push({ type: 'text', text: currentText })
          currentText = ''
        }
        const isNew = !seenToolIds.has(event.id)
        let thinkMs: number | undefined
        if (isNew) {
          seenToolIds.add(event.id)
          stepIndex++
          thinkMs = turnTiming.toolStarted(event.id)
        }
        assistantContent.push({
          type: 'tool_use',
          id: event.id,
          name: event.name ?? '',
          args: event.args,
          status: 'running',
          ...(thinkMs !== undefined ? { thinkMs } : {}),
        })
      } else if (event.type === 'tool_call_result' && event.id) {
        const toolDuration = turnTiming.toolSettled(event.id) ?? 0
        const idx = assistantContent.findIndex(
          b => b.type === 'tool_use' && (b as { id: string }).id === event.id,
        )
        if (idx >= 0) {
          assistantContent[idx] = {
            ...(assistantContent[idx] as object),
            result: event.result,
            status: event.isError ? 'failed' : 'done',
            execMs: toolDuration,
          } as ContentBlock
        }
      } else if (event.type === 'tool_call_image' && event.id) {
        // 只回图片的工具没有 tool_call_result：同样结算，避免其耗时漏进 llm。
        const imageToolDuration = turnTiming.toolObserved(event.id)
        const idx = assistantContent.findIndex(
          b => b.type === 'tool_use' && (b as { id: string }).id === event.id,
        )
        if (idx >= 0) {
          const currentStatus = (assistantContent[idx] as Extract<ContentBlock, { type: 'tool_use' }>).status
          assistantContent[idx] = {
            ...(assistantContent[idx] as object),
            image: event.data,
            status: currentStatus === 'failed' ? 'failed' : 'done',
            ...(imageToolDuration !== undefined ? { execMs: imageToolDuration } : {}),
          } as ContentBlock
        }
      } else if (event.type === 'error') {
        throw new Error(event.content ?? 'AI Agent error')
      }
    }

    // Finalize remaining text
    if (currentText) {
      assistantContent.push({ type: 'text', text: currentText })
    }

    // Account for trailing LLM text generation (and settle any tool that never
    // reported a result, so its time stays in execMs).
    const timing = turnTiming.finish()

    // 8. Persist assistant message
    if (assistantContent.length > 0) {
      assistantContent.push({ type: 'timing', totalMs: timing.totalMs, llmMs: timing.llmMs, execMs: timing.execMs, steps: stepIndex })
      store.appendMessage(work.id, 'assistant', assistantContent)
    }

    // 9. Extract summary from accumulated text
    const fullText = assistantContent
      .filter(b => b.type === 'text')
      .map(b => (b as { text: string }).text)
      .join('')
    const summary = fullText.slice(0, 200) || undefined
    const taskMemoryPlan = planTaskMemoryEvent({
      executionId: execution.id,
      trigger: previousExecution?.status === 'failed' ? 'task_recovered' : 'task_completed',
      baseScope: { user: 'local' },
      taskPrompt: task.prompt_template,
      adapters: memoryAdapters,
      toolCalls: assistantContent
        .filter((block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
        .map((block) => ({ name: block.name, args: block.args, status: block.status })),
    })
    // 10. Mark execution as completed
    store.updateTaskExecution(execution.id, {
      status: 'completed',
      completed_at: new Date().toISOString(),
    })

    if (memoryCandidate) {
      queueTaskMemoryProcessing({
        executionId: execution.id,
        trigger: taskMemoryPlan.event.trigger,
        scope: taskMemoryPlan.event.scope,
        expectedMemoryType: taskMemoryPlan.event.expectedMemoryType,
        candidate: memoryCandidate,
      })
    }

    // 11. Send notification (notifier will be created in task 5.1)
    await safeNotify(
      {
        taskId: task.id,
        taskTitle: task.title,
        status: 'completed',
        summary,
        fullText: fullText || undefined,
        executionId: execution.id,
        workId: work.id,
      },
      task.notify_channels,
    )

    return {
      workId: work.id,
      executionId: execution.id,
      status: 'completed',
      summary,
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    const failedMemoryPlan = planTaskMemoryEvent({
      executionId: execution.id,
      trigger: 'task_failed',
      baseScope: { user: 'local' },
      taskPrompt: task.prompt_template,
      adapters: memoryAdapters,
      toolCalls: assistantContent
        .filter((block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
        .map((block) => ({ name: block.name, args: block.args, status: block.status })),
    })
    // Mark execution as failed
    store.updateTaskExecution(execution.id, {
      status: 'failed',
      error_message: errorMessage,
      completed_at: new Date().toISOString(),
    })

    try {
      if (memoryCandidate) {
        queueTaskMemoryProcessing({
          executionId: execution.id,
          trigger: 'task_failed',
          scope: failedMemoryPlan.event.scope,
          expectedMemoryType: failedMemoryPlan.event.expectedMemoryType,
          candidate: memoryCandidate,
        })
      }
    } catch {
      // A missing model configuration must not change the task failure result.
    }

    // Send failure notification
    await safeNotify(
      {
        taskId: task.id,
        taskTitle: task.title,
        status: 'failed',
        error: errorMessage,
        executionId: execution.id,
        workId: work.id,
      },
      task.notify_channels,
    )

    return {
      workId: work.id,
      executionId: execution.id,
      status: 'failed',
      error: errorMessage,
    }
  }
}
