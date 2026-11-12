import { getWorkWithMessages, type Message } from './works-store.js'

type Run = { executionId: string; source: 'scheduled_task' | 'channel'; pending: () => Message | null }
const runs = new Map<string, Run>()

/** Read current blocks on demand so partial tokens never require database writes. */
export function trackBackgroundChatRun(workId: string, executionId: string, source: Run['source'], pending: Run['pending']): () => void {
  const run = { executionId, source, pending }
  runs.set(workId, run)
  return () => { if (runs.get(workId) === run) runs.delete(workId) }
}

export function listBackgroundChatRuns(source?: Run['source']) {
  return [...runs].flatMap(([workId, run]) => {
    if (source && run.source !== source) return []
    const work = getWorkWithMessages(workId)
    if (!work) return []
    const pending = run.pending()
    return [{ workId, executionId: run.executionId, source: run.source, messages: [...work.messages, ...(pending ? [pending] : [])] }]
  })
}
