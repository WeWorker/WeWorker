import { describe, expect, it } from 'vitest'
import {
  admitMemoryCandidate,
  extractLedgerWebcliHits,
} from '../memory/memory-admission.js'
import type { MemoryUpdateCandidate } from '../memory/memory-types.js'

const adapters = [
  { id: 'billing.example.com', name: '费用管理示例', match: ['billing.example.com'] },
  { id: 'support.example.com', name: '支持工单示例', match: ['support.example.com'] },
  { id: 'xiaohongshu.com', name: '小红书', match: ['xiaohongshu.com'] },
]

describe('memory admission (candidate-first)', () => {
  it('extracts webcli tools from PowerShell ledger without storing command semantics beyond tool id', () => {
    const hits = extractLedgerWebcliHits([{
      name: 'PowerShell',
      args: { command: 'webcli call support.example.com.my_todo --output-format=json' },
      status: 'done',
    }, {
      name: 'PowerShell',
      args: { command: 'webcli call support.example.com.detail --mode=req' },
      status: 'done',
    }])
    expect(hits).toEqual([
      { tool: 'support.example.com.my_todo', adapterId: 'support.example.com', ok: true },
      { tool: 'support.example.com.detail', adapterId: 'support.example.com', ok: true },
    ])
  })

  it('admits declarative task_execution as provisional without NL matching', () => {
    const candidate: MemoryUpdateCandidate = {
      action: 'create',
      memory_type: 'task_execution',
      key: 'reimburse',
      content: '先费用归属再发票',
      facts: { declarative: true },
      scope: { site: 'billing.example.com' },
      confidence: 0.55,
    }
    const result = admitMemoryCandidate({
      candidate,
      baseScope: { user: 'local' },
      adapters,
      toolCalls: [],
      turnSucceeded: true,
      // Message would NOT match "费用管理示例" without space — must still admit.
    })
    expect(result).toMatchObject({
      ok: true,
      verification: 'provisional',
      scope: { user: 'local', site: 'billing.example.com' },
    })
  })

  it('rejects high-confidence task_execution with no tools (fake verified)', () => {
    const result = admitMemoryCandidate({
      candidate: {
        action: 'create',
        memory_type: 'task_execution',
        key: 'guess',
        content: '推测流程',
        facts: { task_assessment: { completed: true } },
        scope: { site: 'billing.example.com' },
        confidence: 0.95,
      },
      baseScope: { user: 'local' },
      adapters,
      toolCalls: [],
      turnSucceeded: true,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('execution_evidence_insufficient')
  })

  it('admits an executed memory candidate without optional task assessment', () => {
    const result = admitMemoryCandidate({
      candidate: {
        action: 'create',
        memory_type: 'task_execution',
        key: 'missing_assessment',
        content: '执行型经验。',
      },
      baseScope: { user: 'local' },
      adapters,
      toolCalls: [{
        name: 'PowerShell',
        args: { command: 'Write-Output done' },
        status: 'done',
      }],
      turnSucceeded: true,
    })
    expect(result).toMatchObject({ ok: true, verification: 'ledger' })
  })

  it.each([
    ['environmental', true],
    ['procedural', false],
    ['capability', false],
    ['mixed', false],
    ['unknown', false],
  ] as const)('admits an AI-selected %s failure classification', (failureKind, retryable) => {
    const result = admitMemoryCandidate({
      candidate: {
        action: 'create',
        memory_type: 'task_execution',
        key: `failed_${failureKind}`,
        content: '这次失败会改变下一次执行决策。',
        facts: {
          task_assessment: { completed: false, failure_kind: failureKind, retryable },
        },
      },
      baseScope: { user: 'local' },
      adapters,
      toolCalls: [{
        name: 'PowerShell',
        args: { command: 'webcli call support.example.com.list_tickets' },
        status: 'failed',
      }],
      turnSucceeded: true,
    })

    expect(result).toMatchObject({ ok: true, verification: 'ledger' })
  })

  it('does not require a failure classification in optional task assessment', () => {
    const result = admitMemoryCandidate({
      candidate: {
        action: 'create',
        memory_type: 'task_execution',
        key: 'unclassified_failure',
        content: '任务未完成。',
        facts: { task_assessment: { completed: false } },
      },
      baseScope: { user: 'local' },
      adapters,
      toolCalls: [{ name: 'PowerShell', args: { command: 'Write-Output failed' }, status: 'failed' }],
      turnSucceeded: true,
    })

    expect(result).toMatchObject({ ok: true, verification: 'ledger' })
  })

  it('rejects a recovered assessment that is not completed', () => {
    const result = admitMemoryCandidate({
      candidate: {
        action: 'create',
        memory_type: 'task_execution',
        key: 'invalid_recovery',
        content: '任务仍未完成。',
        facts: { task_assessment: { completed: false, recovered: true, failure_kind: 'procedural' } },
      },
      baseScope: { user: 'local' },
      adapters,
      toolCalls: [],
      turnSucceeded: true,
    })

    expect(result).toMatchObject({ ok: false, reason: 'execution_evidence_insufficient' })
  })

  it('does not let a transport-level turn failure override AI completion assessment', () => {
    const result = admitMemoryCandidate({
      candidate: {
        action: 'create',
        memory_type: 'task_execution',
        key: 'completed_before_stream_error',
        content: '完成站点查询后记录可复用入口。',
        facts: { task_assessment: { completed: true } },
        scope: { site: 'support.example.com' },
      },
      baseScope: { user: 'local' },
      adapters,
      toolCalls: [{
        name: 'PowerShell',
        args: { command: 'webcli call support.example.com.list_tickets' },
        status: 'done',
      }],
      turnSucceeded: false,
    })

    expect(result).toMatchObject({ ok: true, verification: 'ledger' })
  })

  it('admits a semantically completed task execution with one successful webcli step', () => {
    const result = admitMemoryCandidate({
      candidate: {
        action: 'create',
        memory_type: 'task_execution',
        key: 'itsm_single_step',
        content: '查看 支持工单示例 待办列表。',
        facts: {
          task_assessment: { completed: true },
          subtasks: [{ summary: '查看待办', completed: true, reusable: true }],
          execution_refs: [{ kind: 'webcli', tool: 'support.example.com.my_todo', required: 'success' }],
        },
        scope: { site: 'support.example.com' },
        confidence: 0.9,
      },
      baseScope: { user: 'local' },
      adapters,
      toolCalls: [{
        name: 'PowerShell',
        args: { command: 'webcli call support.example.com.my_todo' },
        status: 'done',
      }],
      turnSucceeded: true,
    })
    expect(result).toMatchObject({ ok: true, verification: 'ledger' })
  })

  it('ignores an unrelated failed exploratory call after a completed task execution', () => {
    const result = admitMemoryCandidate({
      candidate: {
        action: 'create',
        memory_type: 'task_execution',
        key: 'jd_recent_orders',
        content: '打开京东后检查登录状态，再进入订单列表查看最近消费。',
        facts: {
          task_assessment: { completed: true },
          subtasks: [
            { summary: '检查登录状态', completed: true, reusable: true },
            { summary: '查看订单列表', completed: true, reusable: true },
          ],
          execution_refs: [
            { kind: 'webcli', tool: 'jd.com.check_login_status', required: 'success' },
            { kind: 'webcli', tool: 'jd.com.view_orders', required: 'success' },
          ],
        },
        scope: { site: 'jd.com' },
        confidence: 0.9,
      },
      baseScope: { user: 'local' },
      adapters: [{ id: 'jd.com', name: '京东', match: ['jd.com'] }],
      toolCalls: [{
        name: 'PowerShell',
        args: { command: 'webcli call open_browser --url=https://www.jd.com' },
        status: 'failed',
      }, {
        name: 'PowerShell',
        args: { command: 'webcli call jd.com.check_login_status' },
        status: 'done',
      }, {
        name: 'PowerShell',
        args: { command: 'webcli call jd.com.view_orders' },
        status: 'done',
      }],
      turnSucceeded: true,
    })
    expect(result).toMatchObject({ ok: true, verification: 'ledger' })
  })

  it('rejects execution references that do not match the task ledger', () => {
    const result = admitMemoryCandidate({
      candidate: {
        action: 'create',
        memory_type: 'task_execution',
        key: 'wrong_reference',
        content: '完成站点操作。',
        facts: {
          task_assessment: { completed: true },
          execution_refs: [{ kind: 'webcli', tool: 'support.example.com.detail', required: 'success' }],
        },
        scope: { site: 'support.example.com' },
      },
      baseScope: { user: 'local' },
      adapters,
      toolCalls: [{
        name: 'PowerShell',
        args: { command: 'webcli call support.example.com.my_todo' },
        status: 'done',
      }],
      turnSucceeded: true,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('execution_evidence_insufficient')
  })

  it('rejects a task execution when AI summarizes the overall task as incomplete', () => {
    const result = admitMemoryCandidate({
      candidate: {
        action: 'create',
        memory_type: 'task_execution',
        key: 'incomplete_flow',
        content: '进入网站后继续后续操作。',
        facts: {
          task_assessment: { completed: false },
          subtasks: [
            { summary: '打开网站', completed: true, reusable: true },
            { summary: '完成业务操作', completed: false, reusable: true },
          ],
        },
        scope: { site: 'support.example.com' },
        confidence: 0.9,
      },
      baseScope: { user: 'local' },
      adapters,
      toolCalls: [{
        name: 'PowerShell',
        args: { command: 'webcli call support.example.com.my_todo' },
        status: 'done',
      }],
      turnSucceeded: true,
    })
    expect(result).toMatchObject({ ok: true, verification: 'ledger' })
  })

  it('rejects disabled site even with declarative task flag', () => {
    const result = admitMemoryCandidate({
      candidate: {
        action: 'create',
        memory_type: 'task_execution',
        key: 'xhs',
        content: '搜索笔记',
        facts: { declarative: true },
        scope: { site: 'xiaohongshu.com' },
        confidence: 0.5,
      },
      baseScope: { user: 'local' },
      adapters,
      enabledAdapterIds: new Set(['billing.example.com', 'support.example.com']),
      toolCalls: [],
      turnSucceeded: true,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('disabled_site')
  })

  it('allows a local task execution without inventing a site', () => {
    const result = admitMemoryCandidate({
      candidate: {
        action: 'create',
        memory_type: 'task_execution',
        key: 'no_site',
        content: '流程',
        facts: { task_assessment: { completed: true } },
        confidence: 0.5,
      },
      baseScope: { user: 'local' },
      adapters,
      toolCalls: [{ name: 'PowerShell', args: { command: 'Write-Output done' }, status: 'done' }],
      turnSucceeded: true,
    })
    expect(result.ok).toBe(true)
  })
})
