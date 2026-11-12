/** Serialize snapshots; release a background turn only after its final messages load. */
export function createBackgroundChatSync({ getState, setState, fetchRuns, fetchWork, onStarted, onFinished }) {
  let pending = null
  async function reconcile() {
    const runs = await fetchRuns()
    if (!Array.isArray(runs)) throw new Error('Invalid background chat progress')
    const previous = getState().backgroundChatRuns
    const active = new Set(runs.map(run => run.workId))
    let started = false
    setState(state => {
      const backgroundChatRuns = { ...state.backgroundChatRuns }
      const streamingWorkIds = new Set(state.streamingWorkIds)
      const messages = { ...state.messages }
      for (const run of runs) {
        if (state.abortControllers[run.workId]) continue
        if (!backgroundChatRuns[run.workId]) started = true
        backgroundChatRuns[run.workId] = run.executionId
        streamingWorkIds.add(run.workId)
        messages[run.workId] = run.messages
      }
      return { backgroundChatRuns, streamingWorkIds, messages }
    })
    if (started) onStarted?.()
    for (const [workId, executionId] of Object.entries(previous)) {
      if (active.has(workId)) continue
      try {
        const work = await fetchWork(workId)
        let finished = false
        setState(state => {
          if (state.backgroundChatRuns[workId] !== executionId || state.abortControllers[workId]) return state
          const backgroundChatRuns = { ...state.backgroundChatRuns }
          delete backgroundChatRuns[workId]
          const streamingWorkIds = new Set(state.streamingWorkIds)
          streamingWorkIds.delete(workId)
          finished = true
          return { backgroundChatRuns, streamingWorkIds, messages: { ...state.messages, [workId]: work.messages } }
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
