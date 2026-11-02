/**
 * ask_user 待处理请求的共享状态（桌面端 SSE 模式）。
 *
 * 工具层 ask_user（tools.ts）注册一个 pending promise；前端点选后 POST /works/:id/user-choice
 * （server.ts）调 resolvePendingAskUser 解掉。api-query-router 的交互式确认门复用同一份状态，
 * 故抽到独立模块 —— 避免路由层为这点状态引入 tools.ts 的重依赖图。
 */
export interface AskUserRequest {
  toolCallId: string
  question: string
  options: Array<{ label: string; description?: string }>
  resolve: (answer: string) => void
  onActivate?: () => void
}

const _pendingAskUser = new Map<string, AskUserRequest[]>()

export function setPendingAskUser(workId: string, req: AskUserRequest): void {
  const queue = _pendingAskUser.get(workId) ?? []
  queue.push(req)
  _pendingAskUser.set(workId, queue)
  if (queue.length === 1) req.onActivate?.()
}

export function resolvePendingAskUser(workId: string, answer: string, toolCallId?: string): boolean {
  const req = getPendingAskUser(workId)
  if (!req) return false
  if (toolCallId ? toolCallId !== req.toolCallId : req.toolCallId.startsWith('permission-')) return false
  return cancelPendingAskUser(workId, req.toolCallId, answer)
}

/** Also removes queued requests on cancellation without answering another call. */
export function cancelPendingAskUser(workId: string, toolCallId: string, answer: string): boolean {
  const queue = _pendingAskUser.get(workId)
  const index = queue?.findIndex(req => req.toolCallId === toolCallId) ?? -1
  if (!queue || index < 0) return false
  const [req] = queue.splice(index, 1)
  if (!queue.length) _pendingAskUser.delete(workId)
  req.resolve(answer)
  if (index === 0) queue[0]?.onActivate?.()
  return true
}

export function hasPendingAskUser(workId: string): boolean {
  return _pendingAskUser.has(workId)
}

export function getPendingAskUser(workId: string): AskUserRequest | undefined {
  return _pendingAskUser.get(workId)?.[0]
}

export interface UserChoiceEvent {
  type: string
  id: string
  question: string
  options: AskUserRequest['options']
}

export const USER_CHOICE_TIMEOUT_MS = 5 * 60 * 1000

/** Every choice has its own lifetime, including time spent waiting in the queue. */
export function requestUserChoice(input: {
  workId: string
  toolCallId: string
  question: string
  options: AskUserRequest['options']
  onChoice: (event: UserChoiceEvent) => void
  signal?: AbortSignal
}): Promise<string> {
  if (input.signal?.aborted) return Promise.resolve('用户取消了本次操作')
  return new Promise(resolve => {
    let settled = false
    const finish = (answer: string) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      input.signal?.removeEventListener('abort', onAbort)
      resolve(answer)
    }
    const cancel = (answer: string) => {
      if (!cancelPendingAskUser(input.workId, input.toolCallId, answer)) finish(answer)
    }
    const onAbort = () => cancel('用户取消了本次操作')
    const timeout = setTimeout(() => cancel('用户未在规定时间内确认'), USER_CHOICE_TIMEOUT_MS)
    input.signal?.addEventListener('abort', onAbort, { once: true })
    setPendingAskUser(input.workId, {
      toolCallId: input.toolCallId, question: input.question, options: input.options,
      resolve: finish,
      onActivate: () => {
        try {
          input.onChoice({ type: 'user_choice', id: input.toolCallId, question: input.question, options: input.options })
        } catch {
          cancel('无法显示操作确认，请重试')
        }
      },
    })
  })
}
