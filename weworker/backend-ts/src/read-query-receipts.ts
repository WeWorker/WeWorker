import { randomBytes } from 'node:crypto'

/** Private attestation ledger. Neither tool output nor arbitrary model text is evidence. */
export const READ_QUERY_TOOL_NAME = 'mcp__weworker__weworker_read_query'
export const READ_QUERY_RECEIPT_FIELD = 'weworkerReadQueryReceipt'
export interface ReadQueryScope { workId: string | null; turnId: string | null }
export interface ReadQueryReceipt { tool: string; fixedArgs: Record<string, string | number | boolean> }
type Entry = { scope: ReadQueryScope; receipt: ReadQueryReceipt; callId: string | null; expires: number }
const entries = new Map<string, Entry>()
const TTL_MS = 2 * 60_000
const MAX_ENTRIES = 256

export function issueReadQueryReceipt(scope: ReadQueryScope, receipt: ReadQueryReceipt): string | null {
  if (!scope.workId || !scope.turnId) return null
  for (const [token, entry] of entries) if (entry.expires < Date.now()) entries.delete(token)
  while (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value!)
  const token = randomBytes(32).toString('base64url')
  entries.set(token, { scope: { ...scope }, receipt: { tool: receipt.tool, fixedArgs: { ...receipt.fixedArgs } }, callId: null, expires: Date.now() + TTL_MS })
  return token
}

/** Bind only after SDK reported both genuine matching tool_use name and tool_result id. */
export function bindReadQueryReceipt(token: string, workId: string, turnId: string, callId: string): boolean {
  const entry = entries.get(token)
  if (!entry || entry.callId || entry.expires < Date.now() || !callId
    || entry.scope.workId !== workId || entry.scope.turnId !== turnId) return false
  entry.callId = callId
  return true
}

/** Consumes even a valid receipt; a prior turn or different work can never redeem it. */
export function redeemReadQueryReceipt(token: string, workId: string, callId: string): ReadQueryReceipt | null {
  const entry = entries.get(token)
  if (!entry || !callId || entry.callId !== callId || entry.expires < Date.now()
    || entry.scope.workId !== workId || !entry.scope.turnId) return null
  entries.delete(token)
  return { tool: entry.receipt.tool, fixedArgs: { ...entry.receipt.fixedArgs } }
}

export function discardReadQueryTurn(workId: string, turnId: string): void {
  for (const [token, entry] of entries) {
    if (entry.scope.workId === workId && entry.scope.turnId === turnId) entries.delete(token)
  }
}
