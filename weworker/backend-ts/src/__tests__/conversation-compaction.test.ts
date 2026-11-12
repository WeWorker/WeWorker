import { describe, expect, it } from 'vitest'
import {
  buildCompactedConversationPrompt,
  planConversationCompaction,
  takeRecentWithinTokenBudget,
  selectCompactionSource,
  normalizeCompactionRatio,
} from '../context/conversation-compaction.js'

describe('conversation compaction', () => {
  it('summarizes 80 percent of safe history at a sentence boundary without dropping its tail', () => {
    const history = 'First fact. Second fact. Third fact. Fourth fact. Fifth fact.'
    const result = selectCompactionSource({ history, contextLimit: 1000, reservedTokens: 100, estimateTokens: s => s.length })
    expect(result.source).toBe('First fact. Second fact. Third fact. ')
    expect(result.source + result.retained).toBe(history)
  })

  it('reserves instructions and output before applying the configurable ratio', () => {
    const history = '完整句子。'.repeat(100)
    const result = selectCompactionSource({ history, ratio: 50, contextLimit: 100, reservedTokens: 20, estimateTokens: s => s.length })
    expect(result.source).toBe('完整句子。'.repeat(8))
    expect(result.source + result.retained).toBe(history)
  })

  it('does not cut a single oversized sentence or silently discard it', () => {
    const history = 'x'.repeat(1000)
    const result = selectCompactionSource({ history, contextLimit: 100, reservedTokens: 20, estimateTokens: s => s.length })
    expect(result).toEqual({ source: '', retained: history })
  })

  it('defaults to 80 percent and rejects invalid ratios', () => {
    for (const value of [undefined, null, 0, 100, NaN, 'bad', true]) expect(normalizeCompactionRatio(value)).toBe(80)
    expect(normalizeCompactionRatio(60)).toBe(60)
  })
  it('triggers when the complete context reaches 90 percent', () => {
    const plan = planConversationCompaction({
      contextLimit: 1000,
      nonConversationTokens: 200,
      conversationTokens: 700,
    })

    expect(plan.shouldCompact).toBeTruthy()
    expect(plan.availableTokens).toBe(800)
    expect(plan.targetTokens).toBe(350)
  })

  it('does not trigger at or below the 90 percent threshold', () => {
    expect(planConversationCompaction({
      contextLimit: 1000,
      nonConversationTokens: 200,
      conversationTokens: 699,
    }).shouldCompact).toBe(false)
  })

  it('targets 55 percent of the complete context while only reducing conversation', () => {
    const plan = planConversationCompaction({
      contextLimit: 1000,
      nonConversationTokens: 500,
      conversationTokens: 450,
    })

    expect(plan.shouldCompact).toBe(true)
    expect(plan.targetTokens).toBe(50)
  })

  it('keeps the newest items and returns the older items for summarization', () => {
    const selection = takeRecentWithinTokenBudget(
      ['old', 'middle', 'new'],
      9,
      (item) => item.length,
    )

    expect(selection.retained).toEqual(['middle', 'new'])
    expect(selection.dropped).toEqual(['old'])
  })

  it('builds a prompt containing only summary and recent conversation', () => {
    expect(buildCompactedConversationPrompt({
      summary: '已完成登录',
      recentConversation: 'User: 查询余额',
    })).toBe('[历史对话摘要]\n已完成登录\n\n[最近对话]\nUser: 查询余额')
  })
})
