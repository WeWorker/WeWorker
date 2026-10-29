import type { MemoryScope, MemoryUpdateCandidate } from './memory-types.js'
import type { MemoryStore } from './memory-store.js'
import { applyMemoryUpdate } from './memory-updater.js'
import { automaticMemoryEnabled } from './automatic-memory.js'

export interface ProcessMemoryEventInput {
  eventId: string
  scope: MemoryScope
  expectedMemoryType?: MemoryUpdateCandidate['memory_type']
  store: MemoryStore
  candidate?: MemoryUpdateCandidate
}

export async function processMemoryEvent(input: ProcessMemoryEventInput): Promise<
  | { status: 'not_applicable' | 'duplicate' | 'ignored' }
  | { status: 'saved'; memoryId: string }
  | { status: 'failed'; error: string }
> {
  if (!automaticMemoryEnabled() || !input.candidate) return { status: 'not_applicable' }
  if (!input.store.beginEvent(input.eventId)) return { status: 'duplicate' }

  try {
    const candidate = input.candidate
    if (candidate.action !== 'ignore' && input.expectedMemoryType && candidate.memory_type !== input.expectedMemoryType) {
      throw new Error(`memory decision returned ${candidate.memory_type}, expected ${input.expectedMemoryType}`)
    }
    const result = input.store.completeEventAtomically(
      input.eventId,
      () => applyMemoryUpdate(input.store, input.eventId, candidate, input.scope),
    )
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    input.store.failEvent(input.eventId, message)
    return { status: 'failed', error: message }
  }
}
