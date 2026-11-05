import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DownloadOutlined, TagOutlined } from '@ant-design/icons'
import { useWorkActivityStore } from '../../store/work-activity.js'
import { useWorksStore } from '../../store/works.js'
import { useScheduledTasksStore } from '../../store/scheduled-tasks.js'
import { useSitesStore } from '../../store/sites.js'
import MessageList from './MessageList.jsx'
import ChatBottomDock from './ChatBottomDock.jsx'
import MessageQueue from './MessageQueue.jsx'
import { EMPTY_MESSAGE_QUEUE, getMessageQueue, useMessageQueueStore } from '../../store/message-queue.js'
import WelcomeScreen from '../welcome/WelcomeScreen.jsx'
import HealthCheckPanel from './HealthCheckPanel.jsx'
import { requestChatWarmup, setContextCompactionLifecycleHandler, steerChat, stopChat, streamChat, submitUserChoice } from '../../api/backend.js'
import { backendFetch } from '../../api/http.js'
import { displayToolName } from '../../utils/tool-name.js'
import { formatDuration } from '../../utils/format-duration.js'
import { useSettingsStore } from '../../store/settings.js'
import { useChatInputFillStore } from '../../store/chat-input-fill.js'
import { useChatDraft } from '../../store/chat-drafts.js'
import { buildResumePrompt, isPlanChangeIntent, isResumeIntent } from '../../utils/chat-generation-stop.js'
import { buildOpenWarmupRequest } from '../../utils/chat-warmup.js'
import { applyAssistantStreamEvent, insertSteeringIntoMessages, updateAssistantMessages } from '../../utils/chat-stream-events.js'
import { applyTerminalEventToMessages } from '../../utils/terminal-chat-output.js'
import { buildTodoWriteContextPrompt, buildTodoWriteState } from '../../utils/todowrite-state.js'
import { cleanUserChoiceText, normalizeUserChoiceOptions } from '../../utils/user-choice.js'
import { readChatPermissionMode } from '../../utils/chat-permission-preferences.js'
import { hideBrowserForNewTurn } from '../../utils/dedicated-browser.js'

/**
 * @param {object} props
 * @param {string} props.workId
 * @param {boolean} [props.embedded] Render inside another page (e.g. 专属 Agent) without
 *   making this work the active main chat.
 * @param {(fill: (text: string) => void) => React.ReactNode} [props.renderEmpty] Empty-state override.
 * @param {() => void} [props.onTurnFinished] Called after each send completes.
 */
export default function ChatView({ workId, embedded = false, renderEmpty, onTurnFinished, historyPrefix, permissionScope, defaultPermissionMode = 'workspace' }) {
  const isHandoffChat = useWorksStore(s => s.handoffWorkIds.has(workId))
  const queue = useMemo(() => getMessageQueue(workId), [workId])
  const queueState = useMessageQueueStore(s => s.queues[workId] ?? EMPTY_MESSAGE_QUEUE)
  const messages = useWorksStore((s) => s.messages[workId] ?? [])
  const contextSnapshot = useWorksStore((s) => s.contextSnapshots[workId] ?? null)
  const contextCompactionStatus = useWorksStore((s) => s.contextCompactionStatuses[workId] ?? null)
  const memoryStatus = useWorksStore((s) => s.memoryStatuses[workId] ?? null)
  const appendMessage = useWorksStore((s) => s.appendMessage)
  const updateLastMessage = useWorksStore((s) => s.updateLastMessage)
  const selectWork = useWorksStore((s) => s.selectWork)
  const healthCheckMeta = useWorksStore((s) => s.healthCheckMeta)
  // Streaming state from store — survives component remount on work switch
  const streaming = useWorksStore((s) => s.streamingWorkIds.has(workId))
  useEffect(() => {
    useWorkActivityStore.getState().view(workId)
    return () => useWorkActivityStore.getState().leave(workId)
  }, [workId])
  const [error, setError] = useState(null)
  const handleSendRef = useRef(null)
  const { inputText, setInputText, attachments, setAttachments } = useChatDraft(`work:${workId}`)
  const fillSeq = useChatInputFillStore((s) => s.seq)
  const fillText = useChatInputFillStore((s) => s.text)
  const handledFillSeqRef = useRef(fillSeq)
  const [messageSelectMode, setMessageSelectMode] = useState(false)
  const [toolbarContextTarget, setToolbarContextTarget] = useState(null)
  const maxChatAttachments = useSettingsStore((s) => s.maxChatAttachments)
  const work = useWorksStore((s) => s.embeddedWorks[workId] ?? s.works.find((item) => item.id === workId))
  const [slowWarning, setSlowWarning] = useState(false)
  const slowTimerRef = useRef(null)
  const gotFirstEventRef = useRef(false)
  const compactionNoticeTimerRef = useRef(null)

  useEffect(() => {
    setToolbarContextTarget(document.getElementById('workspace-toolbar-context'))
  }, [])

  // 打开/切换会话时就开始预热：CLI 冷启动（约 0.5-0.8s）不再落在用户第一条消息上。
  // 同一个 work 由 requestChatWarmup 的 60s 节流去重，后端也会在会话已存在时直接返回。
  useEffect(() => {
    const request = buildOpenWarmupRequest(workId)
    if (request) requestChatWarmup(request.workId, request.payload)
  }, [workId])

  useEffect(() => {
    setContextCompactionLifecycleHandler((targetWorkId, status) => {
      useWorksStore.getState().setContextCompactionStatus(targetWorkId, status)
    })
    return () => setContextCompactionLifecycleHandler(null)
  }, [])

  const handleFillInput = (text) => {
    setInputText(text)
  }

  useEffect(() => {
    if (fillSeq <= 0 || fillSeq <= handledFillSeqRef.current) return
    handledFillSeqRef.current = fillSeq
    if (streaming || embedded) return
    const nextText = String(fillText || '').trim()
    if (!nextText) return
    setInputText(nextText)
    setAttachments([])
  }, [fillSeq, fillText, streaming])

  // Download this conversation's diagnostic log (header + message timeline + the
  // [work:xxxxxxxx] tagged backend/bridge chain logs) as a txt for developers.
  const handleExportLogs = async () => {
    try {
      const res = await backendFetch(`/works/${workId}/logs.txt`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `weworker-work-${workId?.slice(0, 8) || 'unknown'}-logs.txt`
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) {
      console.error('[chat] export logs failed:', e)
      setError('日志导出失败，请稍后重试')
    }
  }

  const handleStop = () => {
    void queue.stop().catch(e => setError(e.message))
  }
  const updateStreamMessage = (event, updater) => {
    useWorksStore.setState(s => ({ messages: { ...s.messages, [workId]: updateAssistantMessages(s.messages[workId] ?? [], event, updater) } }))
  }

  const handleChoice = async (choiceId, answer) => {
    const cleanAnswer = cleanUserChoiceText(answer)
    try {
      await submitUserChoice(workId, cleanAnswer, choiceId)
      useWorkActivityStore.getState().answer(workId, choiceId)
      // Update the choice block status to 'answered'
      updateStreamMessage({ type: 'user_choice_answer', id: choiceId }, (msg) => ({
        ...msg,
        content: msg.content.map((b) =>
          b.type === 'user_choice' && b.id === choiceId
            ? { ...b, status: 'answered', answer: cleanAnswer }
            : b
        ),
      }))
    } catch (e) {
      console.error('[chat] submitUserChoice error:', e)
    }
  }

  const sendTurn = async (text, files = [], thinkingEffort = 'off', permissionMode = readChatPermissionMode({ permissionScope, defaultPermissionMode })) => {
    if ((!text.trim() && !files.length) || useWorksStore.getState().streamingWorkIds.has(workId) || useWorksStore.getState().contextCompactionStatuses[workId] === 'compacting') return { status: 'failed', accepted: false }
    if (files.length > maxChatAttachments) {
      setError(`已选 ${files.length}/${maxChatAttachments} 个文件，请删减后再发送`)
      return { status: 'failed', accepted: false, error: '附件数量超过限制，请编辑后重试' }
    }
    setError(null)
    setSlowWarning(false)
    gotFirstEventRef.current = false
    useWorksStore.getState().clearMemoryStatus(workId)

    const controller = new AbortController()
    useWorkActivityStore.getState().start(workId, controller)
    const currentPlan = buildTodoWriteState(useWorksStore.getState().messages[workId] ?? [], { streaming: false })?.plan ?? null
    const modelText = (() => {
      const plan = currentPlan
      if (!plan) return text
      if (isPlanChangeIntent(text)) return text
      if (isResumeIntent(text)) {
        return buildResumePrompt(plan)
      }
      return buildTodoWriteContextPrompt(text, plan)
    })()

    // Start slow-response timer — warn user if no event received within 30s
    slowTimerRef.current = setTimeout(() => {
      if (!gotFirstEventRef.current) setSlowWarning(true)
    }, 30000)

    // Store abort controller and mark as streaming — survives component remount
    useWorksStore.setState((s) => ({
      streamingWorkIds: new Set([...s.streamingWorkIds, workId]),
      abortControllers: { ...s.abortControllers, [workId]: controller },
    }))

    const optimisticUserId = Date.now() + '-u'
    const optimisticAssistantId = Date.now() + '-a'
    appendMessage(workId, {
      id: optimisticUserId,
      role: 'user',
      content: [
        ...files.map((file) => ({ type: 'file_attachment', name: file.name, path: file.path })),
        ...(text ? [{ type: 'text', text }] : []),
      ],
      created_at: new Date().toISOString(),
    })
    appendMessage(workId, { id: optimisticAssistantId, streamingTurnId: optimisticAssistantId, role: 'assistant', content: [], created_at: new Date().toISOString() })
    // A new turn: WeWorker itself moves the browser back off-screen.
    hideBrowserForNewTurn()

    let accepted = false
    let failed = false
    let steered = false
    try {
      await streamChat(workId, text, (event) => {
        if (event.type === 'error') failed = true
        if (event.type === 'user_choice') useWorkActivityStore.getState().wait(workId, controller, event.id)
        // A choice can also resolve by timeout; only clear its matching request.
        if (event.type === 'tool_call_result') useWorkActivityStore.getState().answer(workId, event.id)
        if (event.type === 'steering_message_saved') {
          steered = true
          insertSteeringMessage(event.message, event.previousAssistant)
          queue.acknowledgeSteering(event.requestId)
          return
        }
        if (!gotFirstEventRef.current) {
          gotFirstEventRef.current = true
          setSlowWarning(false)
          clearTimeout(slowTimerRef.current)
        }
        if (event.type === 'title_update') {
          useWorksStore.getState().updateTitleLocal(event.workId, event.title)
          return
        }
        if (event.type === 'user_message_saved') {
          accepted = true
          useWorksStore.setState((s) => {
            const msgs = s.messages[workId] ?? []
            const withoutPlaceholders = msgs.filter(m => m.id !== optimisticUserId && m.id !== optimisticAssistantId)
            return {
              messages: {
                ...s.messages,
                [workId]: [
                  ...withoutPlaceholders,
                  event.message,
                  { id: optimisticAssistantId, streamingTurnId: optimisticAssistantId, role: 'assistant', content: [], created_at: new Date().toISOString() },
                ],
              },
            }
          })
          return
        }
        // turn_start: only used for logging
        if (event.type === 'turn_start') {
          return
        }
        if (event.type === 'context_snapshot') {
          useWorksStore.getState().setContextSnapshot(workId, event.context)
          return
        }
        if (event.type === 'context_compaction_start' || event.type === 'context_compaction_end') {
          if (compactionNoticeTimerRef.current) {
            window.clearTimeout(compactionNoticeTimerRef.current)
            compactionNoticeTimerRef.current = null
          }
          const status = event.type === 'context_compaction_start'
            ? 'compacting'
            : event.compaction?.status === 'failed'
              ? 'failed'
              : event.compaction?.status === 'skipped' ? 'skipped' : 'completed'
          useWorksStore.getState().setContextCompactionStatus(workId, status)
          if (status !== 'compacting') {
            compactionNoticeTimerRef.current = window.setTimeout(() => {
              useWorksStore.getState().setContextCompactionStatus(workId, null)
              compactionNoticeTimerRef.current = null
            }, 5000)
          }
          return
        }
        if (event.type === 'usage') {
          useWorksStore.getState().setContextUsage(workId, event.usage)
          return
        }
        if (event.type === 'memory_status') {
          useWorksStore.getState().setMemoryStatus(workId, event)
          return
        }
        if (event.type === 'tool_timing_final') {
          updateLastMessage(workId, (msg) => {
            if (!msg || msg.role !== 'assistant') return msg
            return { ...msg, content: (msg.content ?? []).map((block) => block.type === 'tool_use' && block.id === event.id
              ? { ...block, execMs: event.execMs, status: block.status === 'running' ? 'done' : block.status }
              : block) }
          })
          return
        }
        // turn_end: append a timing summary block to the assistant message being streamed
        if (event.type === 'turn_end') {
          updateLastMessage(workId, (msg) => {
            if (!msg || msg.role !== 'assistant') return msg
            if ((msg.content ?? []).some((b) => b.type === 'timing')) return msg
            return {
              ...msg,
              content: [...(msg.content ?? []), { type: 'timing', totalMs: event.totalMs, llmMs: event.llmMs, execMs: event.execMs, remainingModelMs: event.remainingModelMs, steps: event.steps }],
            }
          })
          return
        }
        if (event.type === 'terminal_event') {
          useWorksStore.setState((s) => {
            const msgs = s.messages[workId] ?? []
            const nextMessages = applyTerminalEventToMessages(msgs, event)
            if (nextMessages === msgs) return s
            return {
              messages: {
                ...s.messages,
                [workId]: nextMessages,
              },
            }
          })
          return
        }
        updateStreamMessage(event, (msg) => {
          const content = [...msg.content]

          if (event.type === 'text_delta') {
            const last = content[content.length - 1]
            if (last?.type === 'text') {
              return { ...msg, content: [...content.slice(0, -1), { type: 'text', text: last.text + event.content }] }
            }
            return { ...msg, content: [...content, { type: 'text', text: event.content }] }
          }

          if (event.type === 'replace_assistant_text' || event.type === 'replace_assistant_content') {
            return applyAssistantStreamEvent(msg, event)
          }

          if (event.type === 'user_choice') {
            return {
              ...msg,
              content: [...content, {
                type: 'user_choice',
                id: event.id,
                question: cleanUserChoiceText(event.question),
                options: normalizeUserChoiceOptions(event.options),
                status: 'pending',
              }],
            }
          }

          if (event.type === 'tool_call_start') {
            const cleanName = displayToolName(event.name || '')
            // If a tool block with this id already exists, update its args (streaming mode sends args later)
            const existingIdx = content.findIndex((b) => b.type === 'tool_use' && b.id === event.id)
            if (existingIdx >= 0) {
              return {
                ...msg,
                content: content.map((b) =>
                  b.type === 'tool_use' && b.id === event.id
                    ? { ...b, args: event.args || b.args, name: cleanName || b.name }
                    : b
                ),
              }
            }
            return { ...msg, content: [...content, { type: 'tool_use', id: event.id, name: cleanName, args: event.args, status: 'running', thinkMs: event.thinkMs }] }
          }

          if (event.type === 'tool_call_result') {
            // Refresh scheduled tasks list if a scheduled task tool was called
            const toolBlock = content.find((b) => b.type === 'tool_use' && b.id === event.id)
            if (toolBlock?.name && /scheduled.task/i.test(toolBlock.name)) {
              useScheduledTasksStore.getState().loadTasks()
            }
            const existing = content.find((b) => b.type === 'tool_use' && b.id === event.id)
            if (existing) {
              return {
                ...msg,
                content: content.map((b) =>
                  b.type === 'tool_use' && b.id === event.id
                    ? { ...b, result: event.result ?? '(no result)', status: 'done', execMs: event.execMs ?? b.execMs }
                    : b
                ),
              }
            }
            return { ...msg, content: [...content, { type: 'tool_use', id: event.id, name: '', result: event.result ?? '(no result)', status: 'done', execMs: event.execMs }] }
          }

          // send_file_to_user in a desktop conversation: an attachment the user can open.
          if (event.type === 'user_file' && event.attachment?.path) {
            return { ...msg, content: [...content, { ...event.attachment, type: 'file_attachment' }] }
          }

          if (event.type === 'tool_call_image') {
            const existing = content.find((b) => b.type === 'tool_use' && b.id === event.id)
            if (existing) {
              return {
                ...msg,
                content: content.map((b) =>
                  b.type === 'tool_use' && b.id === event.id
                    ? { ...b, image: event.data, status: 'done', execMs: event.execMs ?? b.execMs }
                    : b
                ),
              }
            }
            return { ...msg, content: [...content, { type: 'tool_use', id: event.id, name: 'capture_screenshot', image: event.data, status: 'done', execMs: event.execMs }] }
          }

          if (event.type === 'error') {
            setError(event.content)
            return { ...msg, content: [...content, { type: 'error', text: event.content }] }
          }

          return msg
        })
      }, controller.signal, files, maxChatAttachments, modelText, false, thinkingEffort, permissionMode)
    } catch (e) {
      failed = true
      if (e.name === 'AbortError') {
        const store = useWorksStore.getState()
        if (store.streamingWorkIds.has(workId)) {
          store.stopGeneration(workId)
        }
      } else {
        setError(e.message)
        updateLastMessage(workId, (msg) => ({
          ...msg,
          content: [...msg.content, { type: 'error', text: e.message }],
        }))
      }
    } finally {
      clearTimeout(slowTimerRef.current)
      setSlowWarning(false)
      if (!accepted) {
        useWorksStore.setState(s => ({ messages: { ...s.messages, [workId]: (s.messages[workId] ?? []).filter(message => message.id !== optimisticUserId && message.id !== optimisticAssistantId) } }))
      }
      // Clean up store-level streaming state
      useWorksStore.setState((s) => {
        if (s.abortControllers[workId] !== controller) return s
        const next = new Set(s.streamingWorkIds)
        next.delete(workId)
        const controllers = { ...s.abortControllers }
        delete controllers[workId]
        return { streamingWorkIds: next, abortControllers: controllers }
      })
      if (steered && accepted && !failed && !controller.signal.aborted) {
        await useWorksStore.getState().refreshWorkMessages(workId)
      }
      useWorkActivityStore.getState().finish(workId, controller, controller.signal.aborted || !accepted ? 'stopped' : failed ? 'failed' : 'completed')
      onTurnFinished?.()
    }
    return { status: controller.signal.aborted ? 'stopped' : failed ? 'failed' : 'completed', accepted }
  }

  const insertSteeringMessage = (message, previousAssistant) => {
    if (!message?.id) return
    useWorksStore.setState(s => {
      const current = s.messages[workId] ?? []
      const next = insertSteeringIntoMessages(current, message, previousAssistant)
      return next === current ? s : { messages: { ...s.messages, [workId]: next } }
    })
  }

  queue.setHandlers({
    isBlocked: () => useWorksStore.getState().streamingWorkIds.has(workId) || useWorksStore.getState().contextCompactionStatuses[workId] === 'compacting',
    send: item => item.command ? handleShellCommand(item.command, item.text) : sendTurn(item.text, item.files, item.thinkingEffort, item.permissionMode),
    steer: async item => {
      if (item.command) throw new Error('命令行消息只能排队执行，请等待当前回复完成')
      await steerChat(workId, item)
      // Only SSE has a total order with text/tool events. A faster POST response
      // must not split the reply before earlier buffered deltas have arrived.
      if (!useWorksStore.getState().streamingWorkIds.has(workId)) {
        await useWorksStore.getState().refreshWorkMessages(workId)
      }
    },
    stop: async () => {
      const controller = useWorksStore.getState().abortControllers[workId]
      if (!controller) throw new Error('命令正在执行，请在终端停止；队列已暂停')
      await stopChat(workId)
      controller.abort()
      useWorksStore.getState().stopGeneration(workId)
    },
  })
  // A handoff already owns a queued first turn: wake before paint instead of
  // showing an editable draft and waiting for the history request.
  useLayoutEffect(() => { if (isHandoffChat) queue.wake() }, [queue, isHandoffChat])
  useEffect(() => { queue.wake() }, [queue, streaming, contextCompactionStatus])
  const handleSend = (text, files = [], thinkingEffort = 'off', permissionMode = readChatPermissionMode({ permissionScope, defaultPermissionMode })) => {
    const id = queue.enqueue({ text, files, thinkingEffort, permissionMode })
    if (id) { setInputText(''); setAttachments([]) }
  }

  const handleShellCommand = async (command, originalText = '') => {
    const trimmed = String(command || '').trim()
    if (!trimmed || useWorksStore.getState().streamingWorkIds.has(workId) || useWorksStore.getState().contextCompactionStatuses[workId] === 'compacting') return { status: 'failed', accepted: false }
    setError(null)
    setSlowWarning(false)
    gotFirstEventRef.current = false

    const startedAt = Date.now()
    const userMessageId = `${startedAt}-u`
    const assistantMessageId = `${startedAt}-shell`
    const toolId = `chat-bang-${startedAt.toString(36)}`
    useWorkActivityStore.getState().start(workId, toolId)

    useWorksStore.setState((s) => ({
      streamingWorkIds: new Set([...s.streamingWorkIds, workId]),
    }))

    appendMessage(workId, {
      id: userMessageId,
      role: 'user',
      content: [{ type: 'text', text: originalText || `!${trimmed}` }],
      created_at: new Date().toISOString(),
    })
    appendMessage(workId, {
      id: assistantMessageId,
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: toolId,
        name: 'weworker_powershell',
        args: { command: trimmed },
        status: 'running',
        chatBang: true,
      }],
      created_at: new Date().toISOString(),
    })

    let shellFailed = false
    try {
      const res = await backendFetch('/terminal/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: trimmed,
          workId,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.detail || 'Shell command failed')
      shellFailed = data.exitCode == null || Number(data.exitCode) !== 0
      const execMs = Date.now() - startedAt
      useWorksStore.setState((s) => {
        const msgs = s.messages[workId] ?? []
        return {
          messages: {
            ...s.messages,
            [workId]: msgs.map((msg) => {
              if (msg.id !== assistantMessageId) return msg
              return {
                ...msg,
                content: (msg.content ?? []).map((block) => (
                  block.type === 'tool_use' && block.id === toolId
                    ? {
                        ...block,
                        status: shellFailed ? 'failed' : 'done',
                        args: { ...(block.args || {}), shell: data.shell || block.args?.shell },
                        result: JSON.stringify({ output: data.output || '', exitCode: data.exitCode ?? null }),
                        execMs,
                      }
                    : block
                )),
              }
            }),
          },
        }
      })
    } catch (e) {
      shellFailed = true
      const message = e.message || 'Shell command failed'
      setError(message)
      useWorksStore.setState((s) => {
        const msgs = s.messages[workId] ?? []
        return {
          messages: {
            ...s.messages,
            [workId]: msgs.map((msg) => {
              if (msg.id !== assistantMessageId) return msg
              return {
                ...msg,
                content: (msg.content ?? []).map((block) => (
                  block.type === 'tool_use' && block.id === toolId
                    ? { ...block, status: 'failed', result: message }
                    : block
                )),
              }
            }),
          },
        }
      })
    } finally {
      useWorksStore.setState((s) => {
        const next = new Set(s.streamingWorkIds)
        next.delete(workId)
        return { streamingWorkIds: next }
      })
    }
    useWorkActivityStore.getState().finish(workId, toolId, shellFailed ? 'failed' : 'completed')
    return { status: shellFailed ? 'failed' : 'completed', accepted: true }
  }
  const enqueueShell = (command, originalText) => {
    queue.enqueue({ command, text: originalText || '!' + command })
    setInputText(''); setAttachments([])
  }

  handleSendRef.current = handleSend
  const handleShellCommandRef = useRef(null)
  handleShellCommandRef.current = enqueueShell

  useEffect(() => {
    const init = async () => {
      setMessageSelectMode(false)
      if (embedded) {
        const pending = queue.snapshot()
        if (pending.running || pending.items.length) return
        await useWorksStore.getState().refreshWorkMessages(workId)
        return
      }
      // A freshly prepared handoff is already selected with empty history.
      // Fetching here could overwrite its optimistic first turn with stale data.
      const queued = queue.snapshot()
      if (useWorksStore.getState().handoffWorkIds.has(workId) && (queued.running || queued.items.length)) return
      await selectWork(workId)
      // Never consume another workflow's global pending text or shell command.
      if (useWorksStore.getState().handoffWorkIds.has(workId)) return
      const pending = useWorksStore.getState().pendingMessage
      const pendingAttachments = useWorksStore.getState().pendingAttachments || []
      const pendingThinkingEffort = useWorksStore.getState().pendingThinkingEffort || 'off'
      const pendingShellCommand = useWorksStore.getState().pendingShellCommand
      if (pending || pendingAttachments.length) {
        const pendingPermissionMode = useWorksStore.getState().pendingPermissionMode || 'workspace'
        useWorksStore.setState({ pendingMessage: null, pendingAttachments: [], pendingThinkingEffort: 'off', pendingPermissionMode: 'workspace' })
        handleSendRef.current(pending || '', pendingAttachments, pendingThinkingEffort, pendingPermissionMode)
        return
      }
      if (pendingShellCommand?.command) {
        useWorksStore.setState({ pendingShellCommand: null })
        handleShellCommandRef.current?.(
          pendingShellCommand.command,
          pendingShellCommand.originalText || `!${pendingShellCommand.command}`,
        )
      }
    }
    init()
  }, [workId])

  useEffect(() => {
    return () => {
      if (slowTimerRef.current) window.clearTimeout(slowTimerRef.current)
      if (compactionNoticeTimerRef.current) window.clearTimeout(compactionNoticeTimerRef.current)
    }
  }, [])

  const shortId = workId?.slice(0, 8) || ''
  // Derive the work total from the same thinking and execution components as each turn.
  const taskTotalMs = messages.reduce(
    (s, m) => s + (m.content ?? []).filter((b) => b.type === 'timing').reduce((a, b) => a + (b.llmMs || 0) + (b.execMs || 0), 0),
    0,
  )
  const sites = useSitesStore((s) => s.sites)

  // Detect health check — from in-memory meta (active session) or from title prefix (restored session)
  const liveHealthCheck = healthCheckMeta && healthCheckMeta.workId === workId ? healthCheckMeta : null
  const isHealthCheck = !!(liveHealthCheck || work?.title?.startsWith('[健康检查]'))

  // Resolve health check metadata — live or from title + sites store
  let hcSiteId = liveHealthCheck?.siteId || ''
  let hcSiteName = liveHealthCheck?.siteName || ''
  let hcToolNames = liveHealthCheck?.toolNames || []
  if (!liveHealthCheck && isHealthCheck && work?.title) {
    const titleSiteName = work.title.replace('[健康检查] ', '')
    const matchedSite = sites.find(s => s.name === titleSiteName)
    if (matchedSite) {
      hcSiteId = matchedSite.id
      hcSiteName = matchedSite.name
      hcToolNames = matchedSite.tools?.map(t => t.name) || []
    }
  }
  // Only show streaming UI (cursor, disabled input) if THIS workId is the one streaming
  const isStreamingHere = streaming
  // Embedded chats (专属 Agent) do not own the main workspace toolbar.
  const toolbarContext = !embedded && !isHealthCheck && messages.length > 0 && toolbarContextTarget
    ? createPortal(
        <div className="chat-heading">
          <span className="chat-heading__title" title={work?.title}>{work?.title || '新对话'}</span>
          <details className="chat-heading__details">
            <summary aria-label="对话详情" title="对话详情">···</summary>
            <div className="chat-heading__metadata">
              <strong>对话详情</strong>
              <span>ID：{shortId}</span>
              <span>累计用时：{formatDuration(taskTotalMs)}</span>
            </div>
          </details>
          <span className="chat-heading__actions">
            <LabelDot workId={workId} label={work?.label} />
            <button
              type="button"
              className="workspace-toolbar__button"
              onClick={() => { void handleExportLogs() }}
              title="本次对话日志下载"
              aria-label="导出本次对话日志"
            >
              <DownloadOutlined />
            </button>
          </span>
        </div>,
        toolbarContextTarget,
      )
    : null

  return (
    <>
    {toolbarContext}
    <div data-chat-work-id={workId} className={`chat-view${isHandoffChat ? '' : ' motion-view-enter'}`} style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative', minWidth: 0 }}>
      {/* Health check banner OR normal info bar */}
      {isHealthCheck ? (
        <div style={{
          padding: '6px 20px', fontSize: 12, fontWeight: 600,
          background: isStreamingHere ? 'rgba(99,102,241,0.1)' : 'rgba(34,197,94,0.1)',
          borderBottom: `1px solid ${isStreamingHere ? 'rgba(99,102,241,0.3)' : 'rgba(34,197,94,0.3)'}`,
          color: isStreamingHere ? 'var(--accent)' : '#22c55e',
          display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
        }}>
          <span>{isStreamingHere ? '🔍' : '✅'}</span>
          <span>{isStreamingHere ? `正在检测 ${hcSiteName} 的工具可用性...` : `${hcSiteName} 检测完成`}</span>
        </div>
      ) : messages.length > 0 ? (
        null
      ) : null}

      {!historyPrefix && messages.length === 0 && !contextCompactionStatus && !queueState.running && !queueState.items.length ? (renderEmpty ? renderEmpty(handleFillInput) : <WelcomeScreen onFillInput={handleFillInput} />) : <MessageList historyPrefix={historyPrefix} messages={messages} streaming={isStreamingHere} compactionStatus={contextCompactionStatus} workId={workId} onChoice={handleChoice} onSelectModeChange={setMessageSelectMode} onShellCommand={handleShellCommand} />}

      {/* Health check panel — between messages and input */}
      {isHealthCheck && messages.length > 0 && (
        <HealthCheckPanel
          toolNames={hcToolNames}
          messages={messages}
          streaming={isStreamingHere}
          workId={workId}
          siteId={hcSiteId}
        />
      )}

      {slowWarning && (
        <div style={{ padding: '8px 20px', color: '#f59e0b', fontSize: 12, background: 'rgba(245,158,11,0.1)', borderTop: '1px solid rgba(245,158,11,0.3)' }}>
          ⚠️ 响应较慢，可能是网络问题或 API 连接超时。可查看后端日志排查，或点击停止后重试。
        </div>
      )}
      {error && (
        <div style={{ padding: '8px 20px', color: 'var(--error)', fontSize: 12, background: 'rgba(248,113,113,0.1)' }}>
          {error}
        </div>
      )}
      {memoryStatus && memoryStatus.status !== 'not_applicable' && (
        <div style={{ padding: '6px 20px', color: memoryStatus.status === 'failed' ? 'var(--error)' : 'var(--text-secondary)', fontSize: 12, background: 'var(--bg-secondary)' }}>
          {memoryStatus.status === 'processing' && '正在整理长期记忆'}
          {memoryStatus.status === 'saved' && '长期记忆已更新'}
          {memoryStatus.status === 'ignored' && '本次内容无需保存为长期记忆'}
          {memoryStatus.status === 'duplicate' && '长期记忆已处理'}
          {memoryStatus.status === 'failed' && `长期记忆整理失败${memoryStatus.error ? `：${memoryStatus.error}` : ''}`}
        </div>
      )}
      {isHealthCheck && !isStreamingHere ? null : (
        <ChatBottomDock
          key={permissionScope || 'main'}
          showInput
          ignoreGlobalFill={embedded}
          permissionScope={permissionScope}
          defaultPermissionMode={defaultPermissionMode}
          onSend={handleSend}
          onShellCommand={enqueueShell}
          onStop={handleStop}
          disabled={contextCompactionStatus === 'compacting' || messageSelectMode}
          allowQueue
          queuePanel={<MessageQueue state={queueState} controller={queue} disabled={contextCompactionStatus === 'compacting' || messageSelectMode} />}
          streaming={isStreamingHere}
          text={inputText}
          historyMessages={messages}
          onTextChange={setInputText}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          maxAttachments={maxChatAttachments}
          attachmentTarget={`work:${workId}`}
          contextSnapshot={contextSnapshot}
          onWarmup={(thinkingEffort) => requestChatWarmup(workId, { thinkingEffort })}
        />
      )}
    </div>
    </>
  )
}

const LABEL_COLORS = {
  red: '#ef4444',
  orange: '#f97316',
  yellow: '#eab308',
  green: '#22c55e',
  blue: '#339CFF',
  purple: '#a855f7',
}

const LABEL_OPTIONS = [
  { value: 'red', label: '红色' },
  { value: 'orange', label: '橙色' },
  { value: 'yellow', label: '黄色' },
  { value: 'green', label: '绿色' },
  { value: 'blue', label: '蓝色' },
  { value: 'purple', label: '紫色' },
]

function LabelDot({ workId, label }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const updateLabel = useWorksStore((s) => s.updateLabel)
  const labelNames = useWorksStore((s) => s.labelNames)

  useEffect(() => {
    if (!open) return
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  return (
    <div ref={ref} className="chat-heading__label" style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        className={`workspace-toolbar__button${label || open ? ' is-active' : ''}`}
        onClick={() => setOpen(!open)}
        title={label ? (labelNames[label] || label) : '标记颜色'}
        aria-label={label ? `标记颜色：${labelNames[label] || label}` : '标记颜色'}
        aria-expanded={open}
      >
        <TagOutlined />
      </button>
      {open && (
        <div style={{
          position: 'absolute', right: 0, top: '100%', marginTop: 4, zIndex: 100,
          background: 'var(--bg-primary, #fff)', border: '1px solid var(--border, #e5e7eb)',
          borderRadius: 8, padding: '8px', display: 'flex', gap: 6,
          boxShadow: 'none',
        }}>
          {LABEL_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              title={labelNames[opt.value] || opt.label}
              onClick={() => {
                updateLabel(workId, label === opt.value ? null : opt.value)
                setOpen(false)
              }}
              style={{
                width: 18, height: 18, borderRadius: '50%', border: 'none',
                cursor: 'pointer', padding: 0,
                background: LABEL_COLORS[opt.value],
                outline: label === opt.value ? '2px solid var(--text-primary, #333)' : 'none',
                outlineOffset: 1,
              }}
            />
          ))}
          {label && (
            <button
              title="清除"
              onClick={() => { updateLabel(workId, null); setOpen(false) }}
              style={{
                width: 18, height: 18, borderRadius: '50%',
                border: '1px dashed var(--border, #d1d5db)',
                cursor: 'pointer', padding: 0, background: 'transparent',
                fontSize: 10, color: 'var(--text-muted)', display: 'flex',
                alignItems: 'center', justifyContent: 'center',
              }}
            >
              ✕
            </button>
          )}
        </div>
      )}
    </div>
  )
}
