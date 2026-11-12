export const CONTEXT_CATEGORY_META = {
  system_prompt: { label: '系统提示词', color: '#7f8791', scope: 'runtime' },
  tool_definitions: { label: '工具定义', color: '#7456d8', scope: 'runtime' },
  rules: { label: '全局规则', color: '#168a68', scope: 'runtime' },
  skills: { label: 'Skills 索引', color: '#c17e20', scope: 'runtime' },
  mcp_dynamic_tools: { label: 'MCP 与动态工具', color: '#b9438a', scope: 'runtime' },
  subagent_definitions: { label: 'Agent 定义', color: '#3689c9', scope: 'runtime' },
  conversation: { label: '当前对话', color: '#df6c45', scope: 'work' },
  long_term_memory: { label: '长期记忆', color: '#5d8f57', scope: 'long_term' },
}

export const CONTEXT_SCOPE_LABELS = {
  runtime: '固定运行上下文',
  work: '当前任务上下文',
  long_term: '长期上下文',
}

export function createEmptyContextSnapshot(contextLimit = 1000000) {
  const normalizedLimit = Math.max(1, Number(contextLimit) || 1000000)
  return {
    version: 1,
    phase: 'request_start',
    estimated_total_tokens: 0,
    context_limit: normalizedLimit,
    actual_input_tokens: null,
    token_source: 'estimated',
    displayed_total_tokens: 0,
    categories: Object.entries(CONTEXT_CATEGORY_META).map(([id, meta]) => ({
      id,
      scope: meta.scope,
      estimated_tokens: 0,
      calibrated_tokens: null,
    })),
  }
}

export function normalizeContextSnapshot(snapshot, configuredContextLimit) {
  if (!snapshot || typeof snapshot !== 'object') return null
  const invalidCalibration = snapshot.token_source === 'provider_calibrated' && !(Number(snapshot.actual_input_tokens) > 0)
  const categories = Array.isArray(snapshot.categories)
    ? snapshot.categories
      .filter((item) => item && CONTEXT_CATEGORY_META[item.id])
      .map((item) => ({
        id: item.id,
        scope: item.scope || CONTEXT_CATEGORY_META[item.id].scope,
        estimated_tokens: Math.max(0, Number(item.estimated_tokens) || 0),
        calibrated_tokens: !invalidCalibration && item.calibrated_tokens != null && Number.isFinite(Number(item.calibrated_tokens))
          ? Math.max(0, Number(item.calibrated_tokens))
          : null,
      }))
    : []
  const estimatedTotal = Math.max(0, Number(snapshot.estimated_total_tokens) || 0)
  const contextLimit = Math.max(1, Number(configuredContextLimit) || Number(snapshot.context_limit) || 1000000)
  return {
    version: 1,
    phase: snapshot.phase === 'turn_end' ? 'turn_end' : 'request_start',
    estimated_total_tokens: estimatedTotal,
    context_limit: contextLimit,
    actual_input_tokens: !invalidCalibration && snapshot.actual_input_tokens != null && Number.isFinite(Number(snapshot.actual_input_tokens))
      ? Math.max(0, Number(snapshot.actual_input_tokens))
      : null,
    token_source: !invalidCalibration && snapshot.token_source === 'provider_calibrated' ? 'provider_calibrated' : 'estimated',
    displayed_total_tokens: !invalidCalibration && snapshot.displayed_total_tokens != null && Number.isFinite(Number(snapshot.displayed_total_tokens))
      ? Math.max(0, Number(snapshot.displayed_total_tokens))
      : estimatedTotal,
    compaction: snapshot.compaction && snapshot.compaction.mode === 'conversation_only'
      ? {
          mode: 'conversation_only',
          before_tokens: Math.max(0, Number(snapshot.compaction.before_tokens) || 0),
          after_tokens: Math.max(0, Number(snapshot.compaction.after_tokens) || 0),
          summarized_message_count: Math.max(0, Number(snapshot.compaction.summarized_message_count) || 0),
          retained_message_count: Math.max(0, Number(snapshot.compaction.retained_message_count) || 0),
        }
      : null,
    categories,
  }
}

export function calibrateContextSnapshot(snapshot, actualInputTokens) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot
  const actualTotal = Number(actualInputTokens)
  if (!Number.isFinite(actualTotal) || actualTotal <= 0) return snapshot
  const normalizedActualTotal = Math.max(0, Math.round(actualTotal))
  const categories = Array.isArray(snapshot.categories) ? snapshot.categories : []
  const estimatedTotal = categories.reduce((sum, item) => sum + (Math.max(0, Number(item.estimated_tokens) || 0)), 0)
  if (estimatedTotal <= 0) {
    return {
      ...snapshot,
      actual_input_tokens: normalizedActualTotal,
      token_source: 'provider_calibrated',
      displayed_total_tokens: normalizedActualTotal,
      categories: categories.map((item) => ({ ...item, calibrated_tokens: 0 })),
    }
  }

  const allocations = categories.map((item, index) => {
    const exact = normalizedActualTotal * Math.max(0, Number(item.estimated_tokens) || 0) / estimatedTotal
    const whole = Math.floor(exact)
    return { index, whole, remainder: exact - whole }
  })
  let remaining = normalizedActualTotal - allocations.reduce((sum, item) => sum + item.whole, 0)
  allocations.sort((left, right) => right.remainder - left.remainder || left.index - right.index)
  for (let index = 0; index < remaining; index += 1) allocations[index % allocations.length].whole += 1
  allocations.sort((left, right) => left.index - right.index)

  return {
    ...snapshot,
    actual_input_tokens: normalizedActualTotal,
    token_source: 'provider_calibrated',
    displayed_total_tokens: normalizedActualTotal,
    categories: categories.map((item, index) => ({ ...item, calibrated_tokens: allocations[index].whole })),
  }
}

export function createContextTokenAnchor(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null
  const actualTotal = Number(snapshot.actual_input_tokens)
  if (!Number.isFinite(actualTotal) || actualTotal <= 0) return null
  const categories = Array.isArray(snapshot.categories) ? snapshot.categories : []
  const conversation = categories.find((item) => item?.id === 'conversation')
  const explicitConversationTokens = conversation?.calibrated_tokens == null
    ? Number.NaN
    : Number(conversation.calibrated_tokens)
  const calibratedConversation = Number.isFinite(explicitConversationTokens)
    ? explicitConversationTokens
    : calibrateContextSnapshot(snapshot, actualTotal).categories.find((item) => item?.id === 'conversation')?.calibrated_tokens
  const conversationTokens = Math.max(0, Number(calibratedConversation) || 0)
  return {
    actual_input_tokens: Math.max(0, Math.round(actualTotal)),
    non_conversation_tokens: Math.max(0, Math.round(actualTotal) - conversationTokens),
  }
}

export function calibrateCompactedContextSnapshot(snapshot, actualInputTokens, anchor) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot
  const actualTotal = Number(actualInputTokens)
  if (!Number.isFinite(actualTotal) || actualTotal <= 0) return snapshot
  const nonConversationTokens = anchor?.non_conversation_tokens == null ? Number.NaN : Number(anchor.non_conversation_tokens)
  if (!Number.isFinite(actualTotal) || !Number.isFinite(nonConversationTokens)) {
    return calibrateContextSnapshot(snapshot, actualInputTokens)
  }
  const normalizedActualTotal = Math.max(0, Math.round(actualTotal))
  const categories = Array.isArray(snapshot.categories) ? snapshot.categories : []
  const nonConversationTarget = Math.min(normalizedActualTotal, Math.max(0, Math.round(nonConversationTokens)))
  const conversationTarget = normalizedActualTotal - nonConversationTarget
  const nonConversationCategories = categories.filter((item) => item?.id !== 'conversation')
  const estimatedTotal = nonConversationCategories.reduce((sum, item) => sum + Math.max(0, Number(item?.estimated_tokens) || 0), 0)
  const allocations = new Map()
  let allocated = 0
  for (const item of nonConversationCategories) {
    const weight = Math.max(0, Number(item?.estimated_tokens) || 0)
    const value = estimatedTotal > 0 ? Math.floor(nonConversationTarget * weight / estimatedTotal) : 0
    allocations.set(item.id, value)
    allocated += value
  }
  const remainder = nonConversationTarget - allocated
  for (let index = 0; index < remainder; index += 1) {
    const item = nonConversationCategories[index % Math.max(1, nonConversationCategories.length)]
    if (item) allocations.set(item.id, (allocations.get(item.id) || 0) + 1)
  }

  return {
    ...snapshot,
    actual_input_tokens: normalizedActualTotal,
    token_source: 'provider_calibrated',
    displayed_total_tokens: normalizedActualTotal,
    categories: categories.map((item) => ({
      ...item,
      calibrated_tokens: item.id === 'conversation' ? conversationTarget : (allocations.get(item.id) || 0),
    })),
  }
}

export function projectContextSnapshot(snapshot, displayedTotalTokens) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot
  const projectedTotal = Math.max(0, Math.round(Number(displayedTotalTokens) || 0))
  const categories = Array.isArray(snapshot.categories) ? snapshot.categories : []
  const estimatedTotal = categories.reduce((sum, item) => sum + (Math.max(0, Number(item.estimated_tokens) || 0)), 0)
  if (estimatedTotal <= 0) {
    return {
      ...snapshot,
      displayed_total_tokens: projectedTotal,
      categories: categories.map((item) => ({ ...item, calibrated_tokens: 0 })),
    }
  }

  const allocations = categories.map((item, index) => {
    const exact = projectedTotal * Math.max(0, Number(item.estimated_tokens) || 0) / estimatedTotal
    const whole = Math.floor(exact)
    return { index, whole, remainder: exact - whole }
  })
  let remaining = projectedTotal - allocations.reduce((sum, item) => sum + item.whole, 0)
  allocations.sort((left, right) => right.remainder - left.remainder || left.index - right.index)
  for (let index = 0; index < remaining; index += 1) allocations[index % allocations.length].whole += 1
  allocations.sort((left, right) => left.index - right.index)

  return {
    ...snapshot,
    displayed_total_tokens: projectedTotal,
    categories: categories.map((item, index) => ({ ...item, calibrated_tokens: allocations[index].whole })),
  }
}

export function projectIncrementalContextSnapshot(snapshot, baseActualTokens, previousRequestStartEstimatedTotalTokens) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot
  const currentEstimatedTotal = Math.max(0, Math.round(Number(snapshot.estimated_total_tokens) || 0))
  const previousEstimatedTotal = Math.max(0, Math.round(Number(previousRequestStartEstimatedTotalTokens) || 0))
  const baseActualTotal = Math.max(0, Math.round(Number(baseActualTokens) || 0))
  const delta = Math.max(0, currentEstimatedTotal - previousEstimatedTotal)
  return projectContextSnapshot(snapshot, baseActualTotal + delta)
}

export function formatContextTokens(value) {
  const tokens = Math.max(0, Number(value) || 0)
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(tokens >= 10000000 ? 1 : 2).replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1')}M`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(tokens >= 10000 ? 1 : 2).replace(/\.0$/, '')}K`
  return String(Math.round(tokens))
}

export function contextUsagePercent(snapshot) {
  if (!snapshot) return 0
  const displayedTotal = Number.isFinite(Number(snapshot.displayed_total_tokens))
    ? Number(snapshot.displayed_total_tokens)
    : snapshot.estimated_total_tokens
  return Math.min(100, Math.max(0, (displayedTotal / snapshot.context_limit) * 100))
}
