import { backendFetch } from './http.js'
import { createChatWarmupScheduler } from '../utils/chat-warmup.js'

/**
 * Start the Backend chat session ahead of the first message.
 * `workId` null targets the welcome screen, whose work is created on send.
 * `styleId` keeps the pre-warmed session's style fingerprint aligned with the
 * style the work will actually use.
 */
export async function warmupChat(workId, { thinkingEffort, styleId } = {}) {
  const res = await backendFetch(workId ? `/works/${workId}/warmup` : '/chat/warmup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(workId ? { thinkingEffort } : { thinkingEffort, zcfRole: styleId }),
  })
  return res.ok ? res.json().catch(() => null) : null
}

export const requestChatWarmup = createChatWarmupScheduler({ send: warmupChat })

export async function stopChat(workId) {
  const res = await backendFetch(`/works/${workId}/chat/stop`, { method: 'POST' })
  const result = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(result.detail || '停止失败，排队消息已保留')
  return result
}

export async function steerChat(workId, { id, text, files }) {
  const res = await backendFetch(`/works/${workId}/chat/steer`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: text, attachments: files, requestId: id }),
  })
  const result = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(result.detail || '补充指令发送失败，消息已保留')
  return result
}

let contextCompactionLifecycleHandler = null

export function setContextCompactionLifecycleHandler(handler) {
  contextCompactionLifecycleHandler = typeof handler === 'function' ? handler : null
}

function notifyContextCompactionLifecycle(workId, status) {
  contextCompactionLifecycleHandler?.(workId, status)
}

function normalizeBackendError(message, maxChatAttachments = 60) {
  if (String(message || '').includes('too many attachments')) {
    return `一次最多发送 ${maxChatAttachments} 个附件`
  }
  return message
}

export function isContextOverflowError(message) {
  const text = String(message || '').toLowerCase()
  return /context.{0,40}(exceed|too (long|large)|overflow)|maximum context (length|window)|too many (input )?tokens|prompt.{0,16}too long|input.{0,24}token.{0,24}(exceed|limit)|上下文.{0,16}(过长|超出|超过|超限)|输入.{0,16}(过长|超出.{0,8}限制)/.test(text)
}

export function shouldAutoCompactAfterTurn(contextSnapshot, retryCompaction = false, compactedDuringRequest = false) {
  const contextLimit = Number(contextSnapshot?.context_limit)
  if (retryCompaction || compactedDuringRequest || !Number.isFinite(contextLimit) || contextLimit <= 0) return false

  const actualTokens = Number(contextSnapshot?.actual_input_tokens)
  return Number.isFinite(actualTokens) && actualTokens / contextLimit >= 0.9
}

export async function compactConversation(workId) {
  notifyContextCompactionLifecycle(workId, 'compacting')
  try {
    const res = await backendFetch(`/works/${workId}/compact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      throw new Error(err.detail || '对话压缩失败')
    }
    const result = await res.json()
    notifyContextCompactionLifecycle(workId, result?.status === 'skipped' ? 'skipped' : 'completed')
    return result
  } catch (error) {
    notifyContextCompactionLifecycle(workId, 'failed')
    throw error
  }
}

export async function streamChat(workId, message, onEvent, signal, attachments = [], maxChatAttachments = 60, modelMessage = message, retryCompaction = false, thinkingEffort = 'off', permissionMode = 'ask') {
  console.log(`[frontend] streamChat called, workId=${workId}, signal.aborted=${signal?.aborted}`)
  let res
  try {
    res = await backendFetch(`/works/${workId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, modelMessage, attachments, retryCompaction, thinkingEffort, permissionMode }),
      signal,
    })
  } catch (error) {
    if (!retryCompaction && isContextOverflowError(error?.message)) {
      onEvent({ type: 'context_compaction_start', compaction: { status: 'started' } })
      try {
        const result = await compactConversation(workId)
        for (const event of result?.events || []) {
          if (event.type !== 'context_compaction_start') onEvent(event)
        }
        if (result?.status === 'skipped') {
          onEvent({ type: 'error', content: '上下文已超限，但当前没有可压缩的历史对话' })
          return
        }
        return streamChat(workId, message, onEvent, signal, attachments, maxChatAttachments, modelMessage, true, thinkingEffort, permissionMode)
      } catch (compactionError) {
        onEvent({
          type: 'context_compaction_end',
          compaction: { status: 'failed', error: compactionError instanceof Error ? compactionError.message : String(compactionError) },
        })
        throw compactionError
      }
    }
    throw error
  }

  console.log(`[frontend] fetch response received, status=${res.status}`)

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    const detail = err.detail || 'Request failed'
    if (!retryCompaction && isContextOverflowError(detail)) {
      onEvent({ type: 'context_compaction_start', compaction: { status: 'started' } })
      try {
        const result = await compactConversation(workId)
        for (const event of result?.events || []) {
          if (event.type !== 'context_compaction_start') onEvent(event)
        }
        if (result?.status === 'skipped') {
          onEvent({ type: 'error', content: '上下文已超限，但当前没有可压缩的历史对话' })
          return
        }
        return streamChat(workId, message, onEvent, signal, attachments, maxChatAttachments, modelMessage, true, thinkingEffort, permissionMode)
      } catch (compactionError) {
        onEvent({
          type: 'context_compaction_end',
          compaction: { status: 'failed', error: compactionError instanceof Error ? compactionError.message : String(compactionError) },
        })
        throw compactionError
      }
    }
    throw new Error(normalizeBackendError(detail, maxChatAttachments))
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let overflowDetected = false
  let contextSnapshot = null
  let compactedDuringRequest = false
  let turnEnded = false
  let streamCompleted = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        console.log('[frontend] reader done')
        break
      }
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop()
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') {
          streamCompleted = true
          buffer = ''
          break
        }
        try {
          const event = JSON.parse(data)
          if (event.type === 'turn_end') turnEnded = true
          if (event.type === 'context_snapshot') contextSnapshot = event.context || null
          if (event.type === 'context_compaction_end' && event.compaction?.status === 'completed') {
            compactedDuringRequest = true
          }
          if (event.type === 'error' && isContextOverflowError(event.content)) {
            overflowDetected = true
            if (!retryCompaction) continue
          }
          onEvent(event)
        } catch {}
      }
      if (streamCompleted) break
    }
  } catch (e) {
    console.log(`[frontend] streamChat error: ${e.name} — ${e.message}`)
    throw e
  }
  if (!turnEnded && !streamCompleted) throw new Error('回复连接中断，队列已暂停，请检查当前回复后继续')

  const shouldAutoCompact = shouldAutoCompactAfterTurn(contextSnapshot, retryCompaction, compactedDuringRequest)
  if (!retryCompaction && (overflowDetected || shouldAutoCompact)) {
    onEvent({ type: 'context_compaction_start', compaction: { status: 'started' } })
    try {
      const result = await compactConversation(workId)
      for (const event of result?.events || []) {
        if (event.type !== 'context_compaction_start') onEvent(event)
      }
      if (result?.status === 'skipped') {
        if (overflowDetected) onEvent({ type: 'error', content: '上下文已超限，但当前没有可压缩的历史对话' })
        return
      }
      if (overflowDetected) {
        return streamChat(workId, message, onEvent, signal, attachments, maxChatAttachments, modelMessage, true, thinkingEffort, permissionMode)
      }
    } catch (error) {
      onEvent({
        type: 'context_compaction_end',
        compaction: { status: 'failed', error: error instanceof Error ? error.message : String(error) },
      })
      if (overflowDetected) {
        onEvent({ type: 'error', content: '上下文已超限，自动压缩失败，无法继续请求' })
      }
    }
  }
}

export async function getSites() {
  const res = await backendFetch('/sites')
  return res.json()
}

export async function submitUserChoice(workId, answer) {
  const res = await backendFetch(`/works/${workId}/user-choice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer }),
  })
  return res.json()
}
