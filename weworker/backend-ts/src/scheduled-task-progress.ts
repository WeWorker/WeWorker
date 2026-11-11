import type { Message } from './works-store.js'
import { listBackgroundChatRuns, trackBackgroundChatRun } from './background-chat-progress.js'

/** Read current blocks on demand so partial tokens never require database writes. */
export function trackScheduledTaskRun(workId: string, executionId: string, pending: () => Message | null): () => void {
  return trackBackgroundChatRun(workId, executionId, 'scheduled_task', pending)
}

export function listScheduledTaskRuns() {
  return listBackgroundChatRuns('scheduled_task')
}
