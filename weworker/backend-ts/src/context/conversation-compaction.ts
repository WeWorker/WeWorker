export const CONVERSATION_COMPACTION_TRIGGER_RATIO = 0.9
export const CONVERSATION_COMPACTION_TARGET_RATIO = 0.55
export const MIN_CONVERSATION_COMPACTION_TOKENS = 256
export const DEFAULT_COMPACTION_RATIO = 80

export function normalizeCompactionRatio(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 99
    ? value : DEFAULT_COMPACTION_RATIO
}

export function selectCompactionSource(input: {
  history: string
  ratio?: number
  contextLimit: number
  reservedTokens: number
  estimateTokens: (text: string) => number
}): { source: string; retained: string } {
  const safeTokens = Math.max(0, input.contextLimit - input.reservedTokens)
  const budget = Math.floor(Math.min(input.estimateTokens(input.history), safeTokens) * normalizeCompactionRatio(input.ratio) / 100)
  const boundaries = [0]
  // Keep complete sentences (including their whitespace), never a truncated payload.
  for (const part of new Intl.Segmenter('zh', { granularity: 'sentence' }).segment(input.history)) {
    boundaries.push(part.index + part.segment.length)
  }
  let low = 0
  let high = boundaries.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (input.estimateTokens(input.history.slice(0, boundaries[middle])) <= budget) low = middle
    else high = middle - 1
  }
  const end = boundaries[low]
  return { source: input.history.slice(0, end), retained: input.history.slice(end) }
}

export interface ConversationCompactionPlan {
  shouldCompact: boolean
  conversationTokens: number
  availableTokens: number
  triggerTokens: number
  targetTokens: number
}

export function planConversationCompaction(input: {
  contextLimit: number
  nonConversationTokens: number
  conversationTokens: number
}): ConversationCompactionPlan {
  const contextLimit = Math.max(1, Math.round(Number(input.contextLimit) || 1))
  const nonConversationTokens = Math.max(0, Math.round(Number(input.nonConversationTokens) || 0))
  const conversationTokens = Math.max(0, Math.round(Number(input.conversationTokens) || 0))
  const availableTokens = Math.max(1, contextLimit - nonConversationTokens)
  const triggerTokens = Math.min(availableTokens, Math.max(
    MIN_CONVERSATION_COMPACTION_TOKENS,
    Math.floor(contextLimit * CONVERSATION_COMPACTION_TRIGGER_RATIO) - nonConversationTokens,
  ))
  const targetTokens = Math.max(
    1,
    Math.floor(contextLimit * CONVERSATION_COMPACTION_TARGET_RATIO) - nonConversationTokens,
  )

  return {
    shouldCompact: nonConversationTokens + conversationTokens >= Math.floor(contextLimit * CONVERSATION_COMPACTION_TRIGGER_RATIO),
    conversationTokens,
    availableTokens,
    triggerTokens,
    targetTokens: Math.min(targetTokens, Math.max(1, conversationTokens - 1)),
  }
}

export function takeRecentWithinTokenBudget<T>(
  items: T[],
  targetTokens: number,
  estimateTokens: (item: T) => number,
): { retained: T[]; dropped: T[]; retainedTokens: number } {
  const budget = Math.max(1, Math.round(Number(targetTokens) || 1))
  const retained: T[] = []
  let retainedTokens = 0

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const itemTokens = Math.max(0, Math.round(Number(estimateTokens(items[index])) || 0))
    if (retainedTokens + itemTokens > budget) break
    retained.unshift(items[index])
    retainedTokens += itemTokens
  }

  return {
    retained,
    dropped: items.slice(0, Math.max(0, items.length - retained.length)),
    retainedTokens,
  }
}

export function buildCompactedConversationPrompt(input: {
  summary: string
  recentConversation: string
}): string {
  const summary = String(input.summary || '').trim()
  const recentConversation = String(input.recentConversation || '').trim()
  return [
    summary ? `[历史对话摘要]\n${summary}` : '',
    recentConversation ? `[最近对话]\n${recentConversation}` : '',
  ].filter(Boolean).join('\n\n')
}
