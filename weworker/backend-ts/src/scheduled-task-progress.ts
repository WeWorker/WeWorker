import { getWorkWithMessages, type Message } from './works-store.js'

const runs = new Map<string, { executionId: string; pending: () => Message | null }>()

/** Read current blocks on demand so partial tokens never require database writes. */
export function trackScheduledTaskRun(workId: string, executionId: string, pending: () => Message | null): () => void {
  const run = { executionId, pending }
  runs.set(workId, run)
  return () => { if (runs.get(workId) === run) runs.delete(workId) }
}

export function listScheduledTaskRuns() {
  return [...runs].flatMap(([workId, run]) => {
    const work = getWorkWithMessages(workId)
    if (!work) return []
    const pending = run.pending()
    return [{ workId, executionId: run.executionId, messages: [...work.messages, ...(pending ? [pending] : [])] }]
  })
}
