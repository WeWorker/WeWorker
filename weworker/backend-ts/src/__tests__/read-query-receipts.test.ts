import { describe, expect, it } from 'vitest'
import { bindReadQueryReceipt, discardReadQueryTurn, issueReadQueryReceipt, redeemReadQueryReceipt } from '../read-query-receipts.js'

describe('private typed query receipts', () => {
  it('only redeems once after SDK call binding in the same work', () => {
    const token = issueReadQueryReceipt({ workId: 'work-a', turnId: 'turn-a' }, { tool: 'example.com.list', fixedArgs: { page: 2 } })!
    expect(redeemReadQueryReceipt(token, 'work-a', 'sdk-1')).toBeNull()
    expect(bindReadQueryReceipt(token, 'work-b', 'turn-a', 'sdk-1')).toBe(false)
    expect(bindReadQueryReceipt(token, 'work-a', 'turn-b', 'sdk-1')).toBe(false)
    expect(bindReadQueryReceipt(token, 'work-a', 'turn-a', 'sdk-1')).toBe(true)
    expect(bindReadQueryReceipt(token, 'work-a', 'turn-a', 'sdk-2')).toBe(false)
    expect(redeemReadQueryReceipt(token, 'work-b', 'sdk-1')).toBeNull()
    expect(redeemReadQueryReceipt(token, 'work-a', 'sdk-2')).toBeNull()
    expect(redeemReadQueryReceipt(token, 'work-a', 'sdk-1')).toEqual({ tool: 'example.com.list', fixedArgs: { page: 2 } })
    expect(redeemReadQueryReceipt(token, 'work-a', 'sdk-1')).toBeNull()
  })
  it('fails closed after turn closure, including unused receipts', () => {
    const token = issueReadQueryReceipt({ workId: 'work-b', turnId: 'turn-old' }, { tool: 'example.com.list', fixedArgs: {} })!
    discardReadQueryTurn('work-b', 'turn-old')
    expect(bindReadQueryReceipt(token, 'work-b', 'turn-old', 'sdk-1')).toBe(false)
    expect(issueReadQueryReceipt({ workId: null, turnId: 'turn' }, { tool: 'example.com.list', fixedArgs: {} })).toBeNull()
  })
})
