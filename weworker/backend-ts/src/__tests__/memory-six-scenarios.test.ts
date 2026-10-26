import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { recallLongTermMemory } from '../context/long-term-context.js'
import { planCompletedChatMemoryEvents, planTaskMemoryEvent, resolveChatMemoryCandidate } from '../memory/memory-event-planner.js'
import { processMemoryEvent } from '../memory/memory-lifecycle.js'
import { MemoryStore } from '../memory/memory-store.js'
import type { MemoryScope, MemoryUpdateCandidate } from '../memory/memory-types.js'

const adapters = [
  { id: 'billing.example.com', name: '费用管理示例', match: ['billing.example.com'] },
  { id: 'support.example.com', name: '支持工单示例', match: ['support.example.com'] },
]
const stores: MemoryStore[] = []

function createStore(): MemoryStore {
  const store = new MemoryStore(new DatabaseSync(':memory:'))
  stores.push(store)
  return store
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

async function applyPlannedEvent(input: {
  store: MemoryStore
  event: ReturnType<typeof planCompletedChatMemoryEvents>['events'][number]
  candidate: MemoryUpdateCandidate
}) {
  return processMemoryEvent({
    eventId: input.event.eventId,
    scope: input.event.scope,
    expectedMemoryType: input.event.expectedMemoryType,
    store: input.store,
    candidate: input.candidate,
  })
}

function recalled(store: MemoryStore, query: string, scope: MemoryScope): string {
  return recallLongTermMemory({ query, scope, store }).recalled
}

describe('长期记忆 3 类经验 x 2 种发现方式', () => {
  it('场景一：显式关键词创建用户经验，并按用户隔离召回', async () => {
    const store = createStore()
    const message = '记住，以后默认使用中文回复，回答尽量简洁。'
    const candidate: MemoryUpdateCandidate = {
      action: 'create',
      memory_type: 'user_usage',
      key: 'response_style',
      content: '用户默认使用中文并希望回复简洁。',
    }
    const plan = planCompletedChatMemoryEvents({
      baseEventId: 'user-explicit',
      baseScope: { user: 'user-a' },
      userMessage: message,
      adapters,
      toolCalls: [],
      turnSucceeded: true,
      candidate,
    })

    expect(plan.events).toHaveLength(1)
    expect(plan.events[0].trigger).toBe('agent_decision')
    const result = await applyPlannedEvent({
      store,
      event: plan.events[0],
      candidate,
    })

    expect(result.status).toBe('saved')
    expect(recalled(store, '帮我分析这个申请', { user: 'user-a' })).toContain('用户默认使用中文')
    expect(recalled(store, '帮我分析这个申请', { user: 'user-b' })).not.toContain('用户默认使用中文')
  })

  it('场景二：隐含稳定偏好进入 AI 分析，一次性要求可以被忽略', async () => {
    const store = createStore()
    const message = '给我结果时，结论放前面，必要步骤放后面。'
    const candidate: MemoryUpdateCandidate = {
      action: 'create',
      memory_type: 'user_usage',
      key: 'response_order',
      content: '用户希望先看结论，再看必要步骤。',
    }
    const plan = planCompletedChatMemoryEvents({
      baseEventId: 'user-implicit',
      baseScope: { user: 'user-a' },
      userMessage: message,
      adapters,
      toolCalls: [],
      turnSucceeded: true,
      candidate,
    })

    expect(plan.events).toMatchObject([{
      trigger: 'agent_decision',
      expectedMemoryType: 'user_usage',
    }])
    const saved = await applyPlannedEvent({
      store,
      event: plan.events[0],
      candidate,
    })
    const ignoredPlan = planCompletedChatMemoryEvents({
      baseEventId: 'user-implicit-ignore',
      baseScope: { user: 'user-a' },
      userMessage: '本次回答详细一点，结论放在最后。',
      adapters,
      toolCalls: [],
      turnSucceeded: true,
    })
    expect(saved.status).toBe('saved')
    expect(ignoredPlan.events).toHaveLength(0)
    expect(recalled(store, '帮我分析这个申请', { user: 'user-a' })).toContain('先看结论')
  })

  it('场景三：显式网站流程使用网站作用域，跨网站不召回', async () => {
    const store = createStore()
    const message = '记住，在费用管理示例提交团建报销时，先选择费用归属，再上传发票，最后提交前问我确认。'
    const candidate: MemoryUpdateCandidate = {
      action: 'create',
      memory_type: 'task_execution',
      key: 'expense_submit_order',
      content: '团建报销先选择费用归属，再上传发票，提交前询问确认。',
      facts: { declarative: true },
      scope: { user: 'user-a', site: 'billing.example.com' },
      confidence: 0.55,
    }
    const plan = planCompletedChatMemoryEvents({
      baseEventId: 'site-explicit',
      baseScope: { user: 'user-a' },
      userMessage: message,
      adapters,
      toolCalls: [],
      turnSucceeded: true,
      candidate,
    })

    expect(plan.events).toHaveLength(1)
    expect(plan.events[0].scope.site).toBe('billing.example.com')
    expect(plan.events[0].factsPatch?.verification).toBe('provisional')
    const result = await applyPlannedEvent({
      store,
      event: plan.events[0],
      candidate: {
        ...candidate,
        facts: { ...candidate.facts, ...plan.events[0].factsPatch },
        confidence: 0.55,
      },
    })

    expect(result.status).toBe('saved')
    expect(recalled(store, '继续处理团建报销', plan.events[0].scope)).toContain('先选择费用归属')
    expect(recalled(store, '继续处理团建报销', { user: 'user-a', site: 'support.example.com' })).not.toContain('先选择费用归属')
  })

  it('场景四：任务失败也可记录分类经验，但不会伪造成成功经验', async () => {
    const store = createStore()
    const message = '帮我提交团建报销。'
    const candidate: MemoryUpdateCandidate = {
      action: 'create',
      memory_type: 'task_execution',
      key: 'expense_tool_flow',
      content: '团建报销使用费控提交工具完成。',
      facts: { task_assessment: { completed: true } },
      scope: { user: 'user-a', site: 'billing.example.com' },
    }
    const plan = planCompletedChatMemoryEvents({
      baseEventId: 'site-implicit',
      baseScope: { user: 'user-a' },
      userMessage: message,
      adapters,
      toolCalls: [{
        name: 'PowerShell',
        args: { command: 'webcli call billing.example.com.submit_expense --invoice=SECRET-123' },
        status: 'done',
      }, {
        name: 'PowerShell',
        args: { command: 'webcli call billing.example.com.confirm_expense' },
        status: 'done',
      }],
      turnSucceeded: true,
      candidate,
    })

    expect(plan.events).toMatchObject([{
      trigger: 'task_completed',
      expectedMemoryType: 'task_execution',
      scope: { user: 'user-a', site: 'billing.example.com' },
    }])
    const result = await applyPlannedEvent({
      store,
      event: plan.events[0],
      candidate,
    })
    const failedCandidate: MemoryUpdateCandidate = {
      action: 'create',
      memory_type: 'task_execution',
      key: 'expense_tool_failure',
      content: '费控提交工具失败时，先检查扩展连接和页面状态，再决定是否重试。',
      facts: { task_assessment: { completed: false, failure_kind: 'environmental', retryable: true } },
      scope: { user: 'user-a', site: 'billing.example.com' },
    }
    const failedPlan = planCompletedChatMemoryEvents({
      baseEventId: 'site-failed',
      baseScope: { user: 'user-a' },
      userMessage: message,
      adapters,
      toolCalls: [{ name: 'PowerShell', args: { command: 'webcli call billing.example.com.submit_expense' }, status: 'failed' }],
      turnSucceeded: true,
      candidate: failedCandidate,
    })

    expect(result.status).toBe('saved')
    expect(failedPlan.events).toMatchObject([{
      trigger: 'task_failed',
      expectedMemoryType: 'task_execution',
    }])
    const failedResult = await applyPlannedEvent({
      store,
      event: failedPlan.events[0],
      candidate: failedCandidate,
    })

    expect(failedResult.status).toBe('saved')
    expect(store.search({ query: 'SECRET PRIVATE', scope: plan.scope })).toHaveLength(0)
  })

  it('场景五：显式任务结果经验由 AI 归类，临时结果可忽略', async () => {
    const store = createStore()
    const message = '记住，这类汇总成功时要先按月份分组，再核对合计金额。'
    const candidate: MemoryUpdateCandidate = {
      action: 'create',
      memory_type: 'task_execution',
      key: 'invoice_summary_success',
      content: '发票汇总先按月份分组，再核对合计金额。',
      facts: { declarative: true },
      confidence: 0.55,
    }
    const plan = planCompletedChatMemoryEvents({
      baseEventId: 'task-explicit',
      baseScope: { user: 'user-a' },
      userMessage: message,
      adapters,
      toolCalls: [],
      turnSucceeded: true,
      candidate,
    })
    const saved = await applyPlannedEvent({
      store,
      event: plan.events[0],
      candidate: {
        ...candidate,
        facts: { ...candidate.facts, ...plan.events[0].factsPatch },
      },
    })
    const oneOff = planCompletedChatMemoryEvents({
      baseEventId: 'task-explicit-ignore',
      baseScope: { user: 'user-a' },
      userMessage: '记住，今天这次查询返回了 17 条记录。',
      adapters,
      toolCalls: [],
      turnSucceeded: true,
    })
    expect(saved.status).toBe('saved')
    expect(oneOff.events).toHaveLength(0)
    expect(recalled(store, '发票汇总 月份 合计', { user: 'user-a' })).toContain('按月份分组')
    expect(store.search({ query: '17 条', scope: { user: 'user-a' } })).toHaveLength(0)
  })

  it('场景六：定时任务状态事件携带网站作用域', async () => {
    const store = createStore()
    const plan = planTaskMemoryEvent({
      executionId: 'execution-1',
      trigger: 'task_failed',
      baseScope: { user: 'user-a' },
      taskPrompt: '查询 支持工单示例 的待办工单并汇总给我。',
      adapters,
      toolCalls: [{
        name: 'PowerShell',
        args: { command: 'webcli call support.example.com.list_tickets --token=SECRET' },
        status: 'failed',
      }],
    })

    expect(plan.event).toMatchObject({
      eventId: 'task:execution-1:task_failed',
      trigger: 'task_failed',
      expectedMemoryType: 'task_execution',
      scope: { user: 'user-a', site: 'support.example.com' },
    })
    const result = await processMemoryEvent({
      eventId: plan.event.eventId,
      scope: plan.event.scope,
      expectedMemoryType: plan.event.expectedMemoryType,
      store,
      candidate: {
        action: 'create',
        memory_type: 'task_execution',
        key: 'itsm_login_check',
        content: '查询 支持工单示例 待办工单前先确认页面已登录。',
        scope: plan.scope,
      },
    })

    expect(result.status).toBe('saved')
    expect(recalled(store, '查询 支持工单示例 待办工单', plan.scope)).toContain('先确认页面已登录')
    expect(recalled(store, '查询 支持工单示例 待办工单', { user: 'user-a', site: 'billing.example.com' })).not.toContain('先确认页面已登录')
    expect(store.search({ query: 'SECRET PRIVATE', scope: plan.scope })).toHaveLength(0)
  })

  it('任务事件使用 AI 的总体状态，而不是工具失败数量', () => {
    const completedAfterRetry = planCompletedChatMemoryEvents({
      baseEventId: 'completed-after-retry',
      baseScope: { user: 'user-a' },
      userMessage: '查询 支持工单示例 待办。',
      adapters,
      toolCalls: [{
        name: 'PowerShell',
        args: { command: 'webcli call support.example.com.open' },
        status: 'failed',
      }, {
        name: 'PowerShell',
        args: { command: 'webcli call support.example.com.list_tickets' },
        status: 'done',
      }],
      turnSucceeded: true,
      candidate: {
        action: 'create',
        memory_type: 'task_execution',
        key: 'itsm_query_retry',
        content: '查询 支持工单示例 待办时，首次入口失败后改用可用入口继续完成查询。',
       facts: { task_assessment: { completed: true } },
      },
    })

    const failed = planCompletedChatMemoryEvents({
      baseEventId: 'failed-by-summary',
      baseScope: { user: 'user-a' },
      userMessage: '提交报销。',
      adapters,
      toolCalls: [{
        name: 'PowerShell',
        args: { command: 'webcli call billing.example.com.submit_expense' },
        status: 'done',
      }],
      turnSucceeded: true,
      candidate: {
        action: 'create',
        memory_type: 'task_execution',
        key: 'expense_partial',
        content: '报销提交未完成，需补充后续操作。',
         facts: { task_assessment: { completed: false, failure_kind: 'procedural' } },
      },
    })

    const recovered = planCompletedChatMemoryEvents({
      baseEventId: 'recovered-by-summary',
      baseScope: { user: 'user-a' },
      userMessage: '继续查询 支持工单示例 待办。',
      adapters,
      toolCalls: [{
        name: 'PowerShell',
        args: { command: 'webcli call support.example.com.list_tickets' },
        status: 'done',
      }],
      turnSucceeded: true,
      candidate: {
        action: 'create',
        memory_type: 'task_execution',
        key: 'itsm_recovered',
        content: '修正入口后成功恢复 支持工单示例待办查询。',
        facts: { task_assessment: { completed: true, recovered: true, failure_kind: 'procedural' } },
      },
    })

    expect(completedAfterRetry.events[0]?.trigger).toBe('task_completed')
    expect(failed.events[0]?.trigger).toBe('task_failed')
    expect(recovered.events[0]?.trigger).toBe('task_recovered')
  })

  it('模型省略任务状态时由 Backend 根据成功执行补为完成', () => {
    const plan = planCompletedChatMemoryEvents({
      baseEventId: 'backend-completed-default',
      baseScope: { user: 'user-a' },
      userMessage: '校验日期格式。',
      adapters,
      toolCalls: [{
        name: 'PowerShell',
        args: { command: 'Get-Date -Format o' },
        status: 'done',
      }],
      turnSucceeded: true,
      candidate: {
        action: 'create',
        memory_type: 'task_execution',
        key: 'task_execution',
        content: '日期格式校验先输出目标格式，再比较日期部分。',
      },
    })

    expect(plan.events).toMatchObject([{
      trigger: 'task_completed',
      factsPatch: {
        task_assessment: { completed: true },
      },
    }])
  })

  it('模型省略失败分类时由 Backend 根据失败执行补为 unknown', () => {
    const plan = planCompletedChatMemoryEvents({
      baseEventId: 'failed-workflow',
      baseScope: { user: 'user-a' },
      userMessage: '帮我提交报销。',
      adapters,
      toolCalls: [{
        name: 'PowerShell',
        args: { command: 'webcli call billing.example.com.submit_expense' },
        status: 'failed',
      }],
      turnSucceeded: true,
      candidate: {
        action: 'create',
        memory_type: 'task_execution',
        key: 'failed_expense_flow',
        content: '报销使用提交流程。',
      },
    })
    expect(plan.events).toMatchObject([{
      trigger: 'task_failed',
      factsPatch: {
        task_assessment: { completed: false, failure_kind: 'unknown' },
      },
    }])
  })

  it('任务失败后恢复会更新旧经验，并保留网站作用域', async () => {
    const store = createStore()
    const failedPlan = planTaskMemoryEvent({
      executionId: 'execution-failed',
      trigger: 'task_failed',
      baseScope: { user: 'user-a' },
      taskPrompt: '查询 支持工单示例 待办工单。',
      adapters,
      toolCalls: [{ name: 'PowerShell', args: { command: 'webcli call support.example.com.list_tickets' }, status: 'failed' }],
    })
    const failed = await processMemoryEvent({
      eventId: failedPlan.event.eventId,
      scope: failedPlan.event.scope,
      expectedMemoryType: failedPlan.event.expectedMemoryType,
      store,
      candidate: {
        action: 'create',
        memory_type: 'task_execution',
        key: 'itsm_login',
        content: '查询 支持工单示例 待办工单前需要确认登录状态。',
        scope: failedPlan.scope,
      },
    })
    const oldMemory = store.search({ query: '支持工单示例 登录', scope: failedPlan.scope })[0]
    const recoveredPlan = planTaskMemoryEvent({
      executionId: 'execution-recovered',
      trigger: 'task_recovered',
      baseScope: { user: 'user-a' },
      taskPrompt: '查询 支持工单示例 待办工单。',
      adapters,
      toolCalls: [{ name: 'PowerShell', args: { command: 'webcli call support.example.com.list_tickets' }, status: 'done' }],
    })
    const recovered = await processMemoryEvent({
      eventId: recoveredPlan.event.eventId,
      scope: recoveredPlan.event.scope,
      expectedMemoryType: recoveredPlan.event.expectedMemoryType,
      store,
      candidate: {
        action: 'update',
        memory_type: 'task_execution',
        key: 'itsm_login',
        content: '查询 支持工单示例 待办工单前确认登录；登录后可继续原查询。',
        related_memory_ids: [oldMemory.id],
        scope: recoveredPlan.scope,
      },
    })

    expect(failed.status).toBe('saved')
    expect(recovered.status).toBe('saved')
    expect(recoveredPlan.scope.site).toBe('support.example.com')
    expect(store.get(oldMemory.id)?.content).toContain('登录后可继续原查询')
  })

  it('模型省略隐藏块时不合成 fallback 候选', () => {
    const resolved = resolveChatMemoryCandidate({
      parseOutcome: 'missing',
    })
    expect(resolved.source).toBe('none')
    expect(resolved.candidate).toBeUndefined()

    const withShell = resolveChatMemoryCandidate({
      parseOutcome: 'missing',
    })
    expect(withShell.source).toBe('none')

    const ignored = resolveChatMemoryCandidate({
      parseOutcome: 'present_ignore',
    })
    expect(ignored.source).toBe('none')
    expect(ignored.candidate).toBeUndefined()

    const explicitIgnore = resolveChatMemoryCandidate({
      candidate: {
        action: 'ignore',
        memory_type: 'task_execution',
        key: 'x',
        content: 'x',
      },
    })
    expect(explicitIgnore.source).toBe('none')

    const model = resolveChatMemoryCandidate({
      candidate: {
        action: 'create',
        memory_type: 'task_execution',
        key: 'verify_ok',
        content: '可用 Write-Output 做快速验证。',
      },
      parseOutcome: 'present_ok',
    })
    expect(model.source).toBe('model')
    expect(model.candidate?.key).toBe('verify_ok')
  })
})
