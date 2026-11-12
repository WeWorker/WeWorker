/** Keep the lock until the request has persisted its final assistant message. */
export function createChatTurnRegistry() {
  type Turn = { controller: AbortController; done: Promise<void>; finish: () => void }
  const active = new Map<string, Turn>()
  return {
    start(workId: string): Turn | null {
      if (active.has(workId)) return null
      let resolve!: () => void
      const turn: Turn = {
        controller: new AbortController(),
        done: new Promise<void>(r => { resolve = r }),
        finish() {
          if (active.get(workId) === turn) active.delete(workId)
          resolve()
        },
      }
      active.set(workId, turn)
      return turn
    },
    async stop(workId: string, timeoutMs = 15000): Promise<'idle' | 'stopped' | 'timeout'> {
      const turn = active.get(workId)
      if (!turn) return 'idle'
      turn.controller.abort()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          turn.done.then(() => 'stopped' as const),
          new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs) }),
        ])
      } finally { clearTimeout(timer) }
    },
  }
}

// Desktop chat and scheduled tasks must own the same per-conversation lock.
export const chatTurns = createChatTurnRegistry()
