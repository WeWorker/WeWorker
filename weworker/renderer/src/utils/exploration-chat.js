// Keep UI capabilities aligned with the exploration service's single-runner contract.
const runningStatuses = ['queued', 'pending', 'starting', 'starting_browser', 'running', 'cancel_requested']
const resumableStatuses = ['paused', 'waiting_for_user']
const finishedStatuses = ['succeeded', 'failed', 'cancelled']

export function isExplorationUrl(value) {
  try {
    const url = new URL(value.trim())
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
  } catch { return false }
}

export function explorationControls({ status, timeline = [], disabled = false, busy = false, globalBusy = false, modelReady = true, replayActive = false }) {
  const locked = disabled || busy
  const running = runningStatuses.includes(status)
  const resumable = resumableStatuses.includes(status)
  const idle = !globalBusy && !replayActive && !running
  return {
    resumable,
    canStop: !locked && !replayActive && status !== 'cancel_requested' && running,
    canSend: !locked && modelReady && idle && (resumable || finishedStatuses.includes(status)),
    canReplay: !locked && idle && (resumable || finishedStatuses.includes(status)) && timeline.some(item => item.type === 'agent_step'),
  }
}

export function explorationComposerMode(status, submitting = false) {
  return submitting || runningStatuses.includes(status) ? 'stop' : 'send'
}

export function shouldSubmitExploration(event, actionMode = 'send') {
  return actionMode === 'send' && event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing && !event.isComposing && event.keyCode !== 229
}


export function isExplorationInProgress(item, activeExplorationId = '', developingIds = new Set()) {
  return item.exploration_id === activeExplorationId || runningStatuses.includes(item.status) || developingIds.has(item.exploration_id)
}

export function sortExplorations(records = [], activeExplorationId = '', developingIds = new Set()) {
  const priority = item => item.exploration_id === activeExplorationId ? 2 : isExplorationInProgress(item, activeExplorationId, developingIds) ? 1 : 0
  const time = item => Number.isFinite(item.created_at_timestamp) ? item.created_at_timestamp : -Infinity
  return [...(records || [])].sort((a, b) => {
    const byActivity = priority(b) - priority(a)
    if (byActivity) return byActivity
    const aTime = time(a), bTime = time(b)
    return aTime === bTime ? 0 : bTime - aTime
  })
}

// Resolve the entry view once per visit. Historical selections must not become
// the landing page; paused/waiting records remain available in the sidebar.
export function explorationEntryId(records = [], activeExplorationId = '') {
  return activeExplorationId || sortExplorations(records).find(item => runningStatuses.includes(item.status))?.exploration_id || ''
}
