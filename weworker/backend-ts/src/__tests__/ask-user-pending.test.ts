import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPendingAskUser, hasPendingAskUser, requestUserChoice, resolvePendingAskUser, setPendingAskUser, USER_CHOICE_TIMEOUT_MS } from '../ask-user-pending.js'

const workId = 'public-permission-fixture'
afterEach(() => {
  while (hasPendingAskUser(workId)) {
    resolvePendingAskUser(workId, '拒绝', getPendingAskUser(workId)!.toolCallId)
  }
  vi.useRealTimers()
})

describe('pending user confirmations', () => {
  it('queues concurrent confirmations without losing an earlier operation', () => {
    const first = vi.fn()
    const second = vi.fn()
    setPendingAskUser(workId, { toolCallId: 'permission-first', question: 'First operation', options: [], resolve: first })
    setPendingAskUser(workId, { toolCallId: 'permission-second', question: 'Second operation', options: [], resolve: second })
    expect(getPendingAskUser(workId)?.toolCallId).toBe('permission-first')
    expect(resolvePendingAskUser(workId, '允许本次', 'permission-first')).toBe(true)
    expect(first).toHaveBeenCalledWith('允许本次')
    expect(second).not.toHaveBeenCalled()
    expect(getPendingAskUser(workId)?.toolCallId).toBe('permission-second')
  })

  it('does not apply stale or unidentified approval to the current operation', () => {
    const resolve = vi.fn()
    setPendingAskUser(workId, { toolCallId: 'permission-current', question: 'Current operation', options: [], resolve })
    expect(resolvePendingAskUser(workId, '允许本次', 'permission-old')).toBe(false)
    expect(resolvePendingAskUser(workId, '允许本次')).toBe(false)
    expect(resolve).not.toHaveBeenCalled()
    expect(resolvePendingAskUser(workId, '允许本次', 'permission-current')).toBe(true)
    expect(resolve).toHaveBeenCalledOnce()
  })

  it('does not let an answered operation timeout cancel a later confirmation', async () => {
    vi.useFakeTimers()
    const first = requestUserChoice({ workId, toolCallId: 'permission-first', question: 'First', options: [], onChoice: () => {} })
    resolvePendingAskUser(workId, '允许本次', 'permission-first')
    await expect(first).resolves.toBe('允许本次')
    await vi.advanceTimersByTimeAsync(1000)
    const second = requestUserChoice({ workId, toolCallId: 'permission-second', question: 'Second', options: [], onChoice: () => {} })
    await vi.advanceTimersByTimeAsync(USER_CHOICE_TIMEOUT_MS - 1000)
    expect(getPendingAskUser(workId)?.toolCallId).toBe('permission-second')
    resolvePendingAskUser(workId, '允许本次', 'permission-second')
    await expect(second).resolves.toBe('允许本次')
  })

  it('cancels a queued operation without answering or replacing the visible question', async () => {
    const displayed: string[] = []
    const onChoice = (event: { id: string }) => { displayed.push(event.id) }
    const first = requestUserChoice({ workId, toolCallId: 'permission-first', question: 'First', options: [], onChoice })
    const abort = new AbortController()
    const second = requestUserChoice({ workId, toolCallId: 'permission-second', question: 'Second', options: [], onChoice, signal: abort.signal })
    abort.abort()
    await expect(second).resolves.toBe('用户取消了本次操作')
    expect(getPendingAskUser(workId)?.toolCallId).toBe('permission-first')
    resolvePendingAskUser(workId, '允许本次', 'permission-first')
    await expect(first).resolves.toBe('允许本次')
    expect(displayed).toEqual(['permission-first'])
    expect(hasPendingAskUser(workId)).toBe(false)
  })
})
