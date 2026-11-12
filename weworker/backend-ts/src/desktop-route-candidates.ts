import { randomUUID } from 'node:crypto'
import type { DirectRouteOutcome } from './webcli-route.js'

/**
 * Desktop-only observation boundary. This module never dispatches a tool, persists a
 * route or interprets shell text. Verified fixed arguments remain private and are
 * returned only by workspace-scoped server-side get/consume methods. The caller must pass
 * the actual desktop turn's workspace key, question and direct-route outcome; do not
 * construct these from previous log entries or renderer-provided workspace IDs.
 *
 * The only way to identify a webcli call is a structured identity supplied by trusted
 * backend execution instrumentation, linked to the Agent tool-use ID. Ordinary SDK
 * Shell events do not provide that identity. They MUST NOT be command-parsed here.
 */
export interface DesktopCandidateTurn {
  source: 'desktop'
  workspaceKey: string
  workId: string
  turnId: string
  question: string
  directRoute: DirectRouteOutcome
  /** True only for the untouched current user text with no attachments. */
  plainQuestion: boolean
  /** False for ask, dedicated-agent, retries, and all other non-standard turns. */
  eligibleAgentTurn: boolean
}

export type CandidateToolEvent =
  | { type: 'tool_call_start'; id?: string; name?: string; args?: unknown }
  | { type: 'tool_call_result'; id?: string; isError?: boolean; result?: unknown }
  | { type: 'tool_call_image'; id?: string }
  | { type: 'error' | 'text_delta' | 'done'; content?: string }

export interface StructuredWebcliIdentity {
  /** Same ID as the actual Agent tool-use event. NOT a WebCLI recommendation ID. */
  toolUseId: string
  adapterId: string
  toolId: string
  /** Issued by the backend execution boundary, not parsed from a Shell command. */
  source: 'backend_execution_receipt'
}

export interface VerifiedReadQueryExecution {
  /** Redeemed by the private server receipt module, not obtained from SDK text. */
  adapterId: string
  toolId: string
  args: Readonly<Record<string, unknown>>
  toolUseId: string
  businessSuccess: boolean
}

export interface PendingDesktopCandidate {
  id: string
  question: string
  tool: { adapterId: string; toolId: string }
  workId: string
  turnId: string
  toolUseId: string
  status: 'needs_safe_test'
  evidence: 'identity_only_unverified' | 'verified_read_query'
  verification: 'identity_only_unverified' | 'verified'
  /** Public listing never includes the fixed server-side arguments. */
  runnableArgs: null | Record<string, never>
  createdAt: number
}

export interface PrivateVerifiedCandidate {
  candidate: PendingDesktopCandidate
  /** Fixed arguments for server-side safe test and approval only. */
  args: Readonly<Record<string, unknown>>
}

interface StoredCandidate {
  public: PendingDesktopCandidate
  fixedArgs?: Readonly<Record<string, unknown>>
}

interface TurnState {
  input: DesktopCandidateTurn
  calls: Map<string, { name: string; resultSeen: boolean; errored: boolean; identity?: StructuredWebcliIdentity; verified?: VerifiedReadQueryExecution }>
  invalid: boolean
  recommendationSeen: boolean
  closed: boolean
}

const MAX_QUESTION_LENGTH = 512
const MAX_CANDIDATES_PER_WORKSPACE = 40
const MAX_WORKSPACES = 64
const RECOMMENDATION_TOOL = 'webcli_route'
const VERIFIED_TOOL = 'weworker_read_query'
const WEBCLI_ID = /^[a-z][a-z0-9_-]{0,63}$/i

/** Whitespace/case only; punctuation and other wording remain distinct. */
export function normalizeObservedQuestion(question: string): string {
  return question.replace(/\s+/gu, '').toLowerCase()
}

function eligible(input: DesktopCandidateTurn): boolean {
  return input.source === 'desktop' && input.directRoute.status === 'miss'
    && input.plainQuestion === true && input.eligibleAgentTurn === true
    && !!input.workspaceKey.trim() && !!input.workId.trim() && !!input.turnId.trim()
    && !!input.question.trim() && input.question.length <= MAX_QUESTION_LENGTH
}

function copyPublic(candidate: PendingDesktopCandidate): PendingDesktopCandidate {
  return { ...candidate, tool: { ...candidate.tool },
    runnableArgs: candidate.verification === 'verified' ? {} : null }
}

function copyFixedArgs(args: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return structuredClone(args)
}

function freezeFixedArgs(value: unknown): void {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeFixedArgs(child)
    Object.freeze(value)
  }
}

export class DesktopRouteCandidateStore {
  private readonly pending = new Map<string, StoredCandidate[]>()

  /** Public read: never expose fixed arguments even when serialized via GET. */
  list(workspaceKey: string): PendingDesktopCandidate[] {
    if (!workspaceKey.trim()) return []
    return (this.pending.get(workspaceKey) ?? []).map(entry => copyPublic(entry.public))
  }

  /** Server-side only. An unverified identity is never runnable. */
  getVerified(workspaceKey: string, candidateId: string): PrivateVerifiedCandidate | null {
    if (!workspaceKey.trim() || !candidateId) return null
    const entry = this.pending.get(workspaceKey)?.find(item => item.public.id === candidateId)
    if (!entry || !entry.fixedArgs || entry.public.verification !== 'verified') return null
    return { candidate: copyPublic(entry.public), args: copyFixedArgs(entry.fixedArgs) }
  }

  /** Use only after approval succeeded; wrong workspace and repeated consumption fail closed. */
  consumeVerified(workspaceKey: string, candidateId: string): PrivateVerifiedCandidate | null {
    const result = this.getVerified(workspaceKey, candidateId)
    if (!result || !this.ignore(workspaceKey, candidateId)) return null
    return result
  }

  ignore(workspaceKey: string, candidateId: string): boolean {
    if (!workspaceKey.trim() || !candidateId) return false
    const current = this.pending.get(workspaceKey)
    if (!current) return false
    const remaining = current.filter(entry => entry.public.id !== candidateId)
    if (remaining.length === current.length) return false
    if (remaining.length) this.pending.set(workspaceKey, remaining)
    else this.pending.delete(workspaceKey)
    return true
  }

  begin(input: DesktopCandidateTurn): DesktopCandidateObservation | null {
    if (!eligible(input)) return null
    return new DesktopCandidateObservation(this, {
      input: { ...input }, calls: new Map(), invalid: false, recommendationSeen: false, closed: false,
    })
  }

  /** Internal commit only; there is deliberately no approve/enable/dispatch API. */
  record(state: TurnState): PendingDesktopCandidate | null {
    if (state.closed || state.invalid || state.calls.size !== 1) return null
    state.closed = true
    const [toolUseId, call] = [...state.calls][0]
    const identity = call.verified ?? call.identity
    if (!identity || !call.resultSeen || call.errored || !WEBCLI_ID.test(identity.adapterId)
      || !WEBCLI_ID.test(identity.toolId) || identity.toolUseId !== toolUseId) return null
    const verified = call.verified !== undefined
    if (verified && (call.name !== VERIFIED_TOOL || call.verified?.businessSuccess !== true
      || state.recommendationSeen)) return null
    const key = state.input.workspaceKey
    const current = this.pending.get(key) ?? []
    const normalized = normalizeObservedQuestion(state.input.question)
    // A differing tool identity for the same exact question is an ambiguity, not
    // evidence to overwrite the previous candidate.
    const existing = current.find(entry => normalizeObservedQuestion(entry.public.question) === normalized)
    if (existing) return null
    if (!this.pending.has(key) && this.pending.size >= MAX_WORKSPACES) return null
    const candidate: PendingDesktopCandidate = {
      id: randomUUID(), question: state.input.question,
      tool: { adapterId: identity.adapterId, toolId: identity.toolId },
      workId: state.input.workId, turnId: state.input.turnId, toolUseId,
      status: 'needs_safe_test', evidence: verified ? 'verified_read_query' : 'identity_only_unverified',
      verification: verified ? 'verified' : 'identity_only_unverified', runnableArgs: verified ? {} : null,
      createdAt: Date.now(),
    }
    const fixedArgs = verified ? copyFixedArgs(call.verified!.args) : undefined
    if (fixedArgs) freezeFixedArgs(fixedArgs)
    this.pending.set(key, [...current.slice(-(MAX_CANDIDATES_PER_WORKSPACE - 1)), { public: candidate, fixedArgs }])
    return copyPublic(candidate)
  }
}

export class DesktopCandidateObservation {
  constructor(private readonly store: DesktopRouteCandidateStore, private readonly state: TurnState) {}

  /** SDK start can repeat with complete args; neither version is parsed or retained. */
  event(event: CandidateToolEvent): void {
    if (this.state.closed) return
    if (event.type === 'error') { this.state.invalid = true; return }
    if (event.type === 'tool_call_image') { this.state.invalid = true; return }
    if (event.type === 'tool_call_start') {
      if (event.name === RECOMMENDATION_TOOL) { this.state.recommendationSeen = true; return }
      if (!event.id || !event.name) { this.state.invalid = true; return }
      const previous = this.state.calls.get(event.id)
      if (previous && previous.name !== event.name) { this.state.invalid = true; return }
      if (!previous) this.state.calls.set(event.id, { name: event.name, resultSeen: false, errored: false })
    } else if (event.type === 'tool_call_result') {
      if (!event.id || event.id.startsWith('webcli-route-')) return
      const call = this.state.calls.get(event.id)
      if (!call) { this.state.invalid = true; return }
      // A Shell exit status, isError=false or response body is never business proof.
      call.resultSeen = true
      call.errored ||= event.isError === true
    }
  }

  /** Supply only a private receipt redemption result, never SDK/tool text or model args. */
  verifiedExecution(execution: VerifiedReadQueryExecution): void {
    if (this.state.closed) return
    const call = this.state.calls.get(execution.toolUseId)
    if (!call || call.name !== VERIFIED_TOOL || call.verified || call.identity
      || !WEBCLI_ID.test(execution.adapterId) || !WEBCLI_ID.test(execution.toolId)
      || execution.businessSuccess !== true || !execution.args
      || typeof execution.args !== 'object' || Array.isArray(execution.args)) {
      this.state.invalid = true
      return
    }
    // Copy immediately: receipt issuer and caller cannot later mutate fixed arguments.
    const args = copyFixedArgs(execution.args)
    freezeFixedArgs(args)
    call.verified = {
      adapterId: execution.adapterId, toolId: execution.toolId, args,
      toolUseId: execution.toolUseId, businessSuccess: true,
    }
  }

  /** Legacy unverified identity. Never upgrades to verified or supplies arguments. */
  structuredIdentity(identity: StructuredWebcliIdentity): void {
    if (this.state.closed) return
    const call = this.state.calls.get(identity.toolUseId)
    if (identity.source !== 'backend_execution_receipt' || !call || call.identity || call.verified
      || !WEBCLI_ID.test(identity.adapterId) || !WEBCLI_ID.test(identity.toolId)) {
      this.state.invalid = true
      return
    }
    call.identity = {
      toolUseId: identity.toolUseId, adapterId: identity.adapterId,
      toolId: identity.toolId, source: 'backend_execution_receipt',
    }
  }

  /** Call after stream completion, final user-visible answer and tool results. */
  finish(input: { completed: boolean; finalAnswerVisible: boolean; cancelled: boolean }): PendingDesktopCandidate | null {
    if (!input.completed || !input.finalAnswerVisible || input.cancelled) {
      this.state.closed = true
      return null
    }
    return this.store.record(this.state)
  }
}
