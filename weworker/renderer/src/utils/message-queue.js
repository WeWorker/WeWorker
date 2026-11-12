/** One in-memory FIFO per conversation. Handlers can outlive the mounted chat. */
export function createMessageQueue(handlers = {}) {
  let items = []
  let active = null
  let editingId = null
  let editingText = ''
  let pausedReason = null
  let transition = null
  let disposed = false
  let sequence = 0
  let state = { items, running: false, editingId, pausedReason, transitioning: false }
  const publish = () => {
    state = { items, running: !!active, editingId, editingText, pausedReason, transitioning: !!transition }
    handlers.onChange?.(state)
  }
  const schedule = () => queueMicrotask(pump)
  async function pump() {
    if (disposed || active || transition || pausedReason || !items.length || items[0].id === editingId || !handlers.send) return
    if (handlers.isBlocked?.()) return
    const item = items[0]
    items = items.slice(1)
    let settle
    const current = { item, result: null, done: new Promise(resolve => { settle = resolve }) }
    active = current
    publish()
    try {
      const result = await handlers.send(item)
      current.result = result
      if (disposed) return
      if (result?.status !== 'completed') {
        if (result?.accepted === false) items = [item, ...items]
        pausedReason = result?.status === 'stopped' ? '已停止，队列暂停' : (result?.error || '发送未完成，队列暂停')
      }
    } catch (error) {
      current.result = { status: 'failed' }
      // Delivery is unknown: preserve the item for an explicit user decision.
      if (!disposed) { items = [item, ...items]; pausedReason = error?.message || '发送失败，队列暂停' }
    } finally {
      active = null
      settle()
      publish()
      schedule()
    }
  }
  async function transitionQueue(nextId) {
    if (disposed || transition) return
    if (nextId && !items.some(item => item.id === nextId)) return
    let settle
    transition = new Promise(resolve => { settle = resolve })
    pausedReason = nextId ? '正在发送补充指令' : '正在停止当前回复'
    publish()
    const current = active
    const external = handlers.isExternalRunning?.()
    try {
      if (current || external) {
        if (!handlers.stop) throw new Error('无法停止当前回复，排队消息已保留')
        await handlers.stop()
        if (current) await current.done
        // Drain the old stream before loading its persisted interruption point.
        if (!disposed) await handlers.afterStop?.()
      }
      if (disposed) return
      if (nextId) {
        const selected = items.find(item => item.id === nextId)
        if (selected) {
          items = [selected, ...items.filter(item => item.id !== nextId)]
          if (editingId === nextId) editingId = null
          pausedReason = null
        }
      } else pausedReason = '已停止，队列暂停'
    } catch (error) {
      pausedReason = error?.message || '停止失败，队列暂停'
      throw error
    } finally {
      transition = null
      settle()
      publish()
      schedule()
    }
  }
  return {
    snapshot: () => state,
    acknowledgeSteering(id) {
      if (!id || disposed) return
      items = items.filter(item => item.id !== id)
      if (editingId === id) editingId = null
      publish()
    },
    setHandlers(next) { handlers = { ...handlers, ...next } },
    enqueue(payload) {
      if (disposed || (!payload.text?.trim() && !payload.files?.length)) return null
      if (!items.length && !active && !transition) pausedReason = null
      const id = `queued-${Date.now()}-${++sequence}`
      items = [...items, { ...payload, id, files: (payload.files || []).map(file => ({ ...file })) }]
      publish(); schedule()
      return id
    },
    beginEdit(id) {
      const item = items.find(item => item.id === id)
      if (!transition && item) { editingId = id; editingText = item.text; publish() }
    },
    updateEdit(text) { if (editingId && !transition) { editingText = text; publish() } },
    saveEdit(id, text) {
      const item = items.find(item => item.id === id)
      if (!item || (!text.trim() && !item.files.length) || transition) return false
      items = items.map(item => item.id === id ? {
        ...item, text: text.trim(), scenarioHint: item.scenarioHint?.text === text.trim() ? item.scenarioHint : null,
        ...(item.command ? { command: text.trim().startsWith('!') ? text.trim().slice(1).trim() : undefined } : {}),
      } : item)
      editingId = null; publish(); schedule(); return true
    },
    cancelEdit() { editingId = null; publish(); schedule() },
    remove(id) {
      if (transition) return
      items = items.filter(item => item.id !== id)
      if (editingId === id) editingId = null
      publish(); schedule()
    },
    resume() { if (!transition) { pausedReason = null; publish(); schedule() } },
    wake: schedule,
    sendNow: id => transitionQueue(id),
    stop: () => transitionQueue(null),
    dispose() { disposed = true; items = []; editingId = null; publish() },
  }
}
