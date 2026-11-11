/** Serialize snapshots; release a background turn only after its final messages load. */
export function createScheduledTaskSync({ getState, setState, fetchRuns, fetchWork, onStarted, onFinished }) {
  let pending = null
  async function reconcile() {
    const runs = await fetchRuns()
    if (!Array.isArray(runs)) throw new Error('Invalid scheduled task progress')
    const previous = getState().scheduledTaskRuns
    const active = new Set(runs.map(run => run.workId))
    let started = false
    setState(state => {
      const scheduledTaskRuns = { ...state.scheduledTaskRuns }
      const streamingWorkIds = new Set(state.streamingWorkIds)
      const messages = { ...state.messages }
      for (const run of runs) {
        if (state.abortControllers[run.workId]) continue
        if (!scheduledTaskRuns[run.workId]) started = true
        scheduledTaskRuns[run.workId] = run.executionId
        streamingWorkIds.add(run.workId)
        messages[run.workId] = run.messages
      }
      return { scheduledTaskRuns, streamingWorkIds, messages }
    })
    if (started) onStarted?.()
    for (const [workId, executionId] of Object.entries(previous)) {
      if (active.has(workId)) continue
      try {
        const work = await fetchWork(workId)
        let finished = false
        setState(state => {
          if (state.scheduledTaskRuns[workId] !== executionId || state.abortControllers[workId]) return state
          const scheduledTaskRuns = { ...state.scheduledTaskRuns }
          delete scheduledTaskRuns[workId]
          const streamingWorkIds = new Set(state.streamingWorkIds)
          streamingWorkIds.delete(workId)
          finished = true
          return { scheduledTaskRuns, streamingWorkIds, messages: { ...state.messages, [workId]: work.messages } }
        })
        if (finished) onFinished?.(workId)
      } catch {
        // Retain ownership and queued messages until a later poll can load the result.
      }
    }
  }
  return () => {
    if (!pending) pending = reconcile().finally(() => { pending = null })
    return pending
  }
}
