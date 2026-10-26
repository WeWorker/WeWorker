import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { assembleContext } from '../context/context-assembler.js'
import { createLongTermMemoryContext, recallLongTermMemory } from '../context/long-term-context.js'
import { createRuntimeContext } from '../context/runtime-context.js'
import { createWorkContext } from '../context/work-context.js'
import { processMemoryEvent } from '../memory/memory-lifecycle.js'
import { MemoryStore } from '../memory/memory-store.js'
import type { MemoryScope, MemoryUpdateCandidate } from '../memory/memory-types.js'

function createStore(): MemoryStore {
  return new MemoryStore(new DatabaseSync(':memory:'))
}

async function simulateUserTurn(input: {
  store: MemoryStore
  eventId: string
  scope: MemoryScope
  candidate: MemoryUpdateCandidate
}) {
  return processMemoryEvent({
    eventId: input.eventId,
    scope: input.scope,
    store: input.store,
    candidate: input.candidate,
  })
}

function systemPromptForNewConversation(store: MemoryStore, userMessage: string, scope: MemoryScope): string {
  const longTerm = recallLongTermMemory({ query: userMessage, scope, store })
  return assembleContext({
    runtime: createRuntimeContext({ systemPrompt: '你是 WeWorker。', identityPrompt: '' }),
    work: createWorkContext({ conversation: `User: ${userMessage}` }),
    longTerm: createLongTermMemoryContext({ recalledMemory: longTerm.recalled }),
    sdkSystemPrompt: '你是 WeWorker。',
    sdkPrompt: `User: ${userMessage}`,
  }).sdk.system_prompt
}

describe('真实用户输入记忆场景', () => {
  it('场景一：用户明确设置习惯，下一次新会话自动使用该习惯', async () => {
    const store = createStore()
    const scope = { user: 'scenario-user' }

    const result = await simulateUserTurn({
      store,
      eventId: 'scenario-preference-1',
      scope,
      candidate: {
        action: 'create',
        memory_type: 'user_usage',
        key: 'response_style',
        content: '用户默认使用中文，回复尽量简洁。',
        facts: { language: 'zh-CN', concise: true },
        scope,
        confidence: 0.98,
      },
    })

    const nextConversationPrompt = systemPromptForNewConversation(store, '帮我看看今天有哪些待处理事项。', scope)

    expect(result.status).toBe('saved')
    expect(nextConversationPrompt).toContain('用户默认使用中文，回复尽量简洁。')
  })

  it('场景二：用户明确说明任务固定操作，下一次同网站任务可以复用', async () => {
    const store = createStore()
    const scope = { user: 'scenario-user', site: 'billing.example.com' }

    const result = await simulateUserTurn({
      store,
      eventId: 'scenario-site-1',
      scope,
      candidate: {
        action: 'create',
        memory_type: 'task_execution',
        key: 'expense_submit_order',
        content: '费用管理示例提交团建报销时，先选择费用归属，再上传发票，提交前询问用户确认。',
        facts: { site: 'billing.example.com', requiresConfirmation: true },
        scope,
        confidence: 0.96,
      },
    })

    const nextConversationPrompt = systemPromptForNewConversation(store, '帮我提交这张团建发票。', scope)

    expect(result.status).toBe('saved')
    expect(nextConversationPrompt).toContain('先选择费用归属，再上传发票')
    expect(nextConversationPrompt).toContain('提交前询问用户确认')
  })

  it('场景三：任务失败后记录失败经验，恢复成功后更新为恢复经验', async () => {
    const store = createStore()
    const scope = { user: 'scenario-user', site: 'support.example.com' }
    const failed = await simulateUserTurn({
      store,
      eventId: 'scenario-failure-1',
      scope,
      candidate: {
        action: 'create',
        memory_type: 'task_execution',
        key: 'itsm_ticket_query_login',
        content: '查询 支持工单示例 待办工单前需要先确认页面已登录。',
        facts: { reason: '页面未登录' },
        scope,
        confidence: 0.9,
      },
    })
    const failure = store.search({ query: '待办工单 登录', scope })[0]

    const recovered = await simulateUserTurn({
      store,
      eventId: 'scenario-recovery-1',
      scope,
      candidate: {
        action: 'update',
        memory_type: 'task_execution',
        key: 'itsm_ticket_query_login',
        content: '查询 支持工单示例 待办工单前先确认页面已登录，登录后即可继续查询。',
        facts: { recovered: true },
        related_memory_ids: failure ? [failure.id] : [],
        scope,
        confidence: 0.97,
      },
    })

    const nextConversationPrompt = systemPromptForNewConversation(store, '请继续整理 支持工单示例 待办工单。', scope)

    expect(failed.status).toBe('saved')
    expect(recovered.status).toBe('saved')
    expect(store.get(failure!.id)?.content).toContain('登录后即可继续查询')
    expect(nextConversationPrompt).toContain('登录后即可继续查询')
  })

  it('场景四：用户改变习惯时替换旧记忆，不同时注入旧规则', async () => {
    const store = createStore()
    const scope = { user: 'scenario-user' }
    const first = await simulateUserTurn({
      store,
      eventId: 'scenario-update-1',
      scope,
      candidate: {
        action: 'create',
        memory_type: 'user_usage',
        key: 'response_language',
        content: '用户默认使用中文回复。',
        scope,
      },
    })
    const old = store.search({ query: '中文回复', scope })[0]
    const second = await simulateUserTurn({
      store,
      eventId: 'scenario-update-2',
      scope,
      candidate: {
        action: 'supersede',
        memory_type: 'user_usage',
        key: 'response_language',
        content: '用户默认使用英文回复。',
        related_memory_ids: old ? [old.id] : [],
        scope,
      },
    })

    const nextConversationPrompt = systemPromptForNewConversation(store, '请介绍一下这个项目。', scope)

    expect(first.status).toBe('saved')
    expect(second.status).toBe('saved')
    expect(store.get(old!.id)?.status).toBe('superseded')
    expect(nextConversationPrompt).toContain('用户默认使用英文回复。')
    expect(nextConversationPrompt).not.toContain('用户默认使用中文回复。')
  })

  it('场景五：一次性请求不保存，另一个用户也不能读取当前用户记忆', async () => {
    const store = createStore()
    const ownerScope = { user: 'scenario-user-a' }
    const otherScope = { user: 'scenario-user-b' }
    const ordinaryMessage = '请帮我查一下今天的发票。'

    await simulateUserTurn({
      store,
      eventId: 'scenario-isolation-1',
      scope: ownerScope,
      candidate: {
        action: 'create',
        memory_type: 'user_usage',
        key: 'confirmation',
        content: '用户提交前需要确认。',
        scope: ownerScope,
      },
    })

    const otherUserPrompt = systemPromptForNewConversation(store, '帮我提交这份申请。', otherScope)

    expect(ordinaryMessage).toBe('请帮我查一下今天的发票。')
    expect(otherUserPrompt).not.toContain('用户提交前需要确认。')
  })
})
