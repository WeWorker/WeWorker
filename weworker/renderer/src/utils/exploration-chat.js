// Keep UI capabilities aligned with the exploration service's single-runner contract.
const runningStatuses = ['queued', 'pending', 'starting', 'running', 'pause_requested', 'cancel_requested']
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
    canPause: !locked && !replayActive && status === 'running',
    canResume: !locked && modelReady && idle && resumable,
    canCancel: !locked && !replayActive && status !== 'cancel_requested' && (running || resumable),
    canSend: !locked && modelReady && idle && (resumable || finishedStatuses.includes(status)),
    canReplay: !locked && idle && (resumable || finishedStatuses.includes(status)) && timeline.some(item => item.type === 'agent_step'),
  }
}

export function explorationComposerMode(status, submitting = false) {
  if (submitting || runningStatuses.includes(status)) return 'pause'
  return resumableStatuses.includes(status) ? 'resume' : 'send'
}

export function shouldSubmitExploration(event, actionMode = 'send') {
  return actionMode !== 'pause' && event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing && !event.isComposing && event.keyCode !== 229
}


export function sortExplorations(records = [], activeExplorationId = '') {
  const priority = item => item.exploration_id === activeExplorationId ? 2 : runningStatuses.includes(item.status) ? 1 : 0
  const time = item => Number.isFinite(item.created_at_timestamp) ? item.created_at_timestamp : -Infinity
  return [...(records || [])].sort((a, b) => {
    const byActivity = priority(b) - priority(a)
    if (byActivity) return byActivity
    const aTime = time(a), bTime = time(b)
    return aTime === bTime ? 0 : bTime - aTime
  })
}
