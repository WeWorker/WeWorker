import { afterEach, expect, it, vi } from 'vitest'
import { automaticMemoryEnabled } from '../memory/automatic-memory.js'
import { processMemoryEvent } from '../memory/memory-lifecycle.js'
import type { MemoryStore } from '../memory/memory-store.js'

afterEach(() => vi.unstubAllEnvs())

it('only disables automatic memory when explicitly requested', () => {
  for (const value of ['', '0', 'true']) {
    vi.stubEnv('WEWORKER_DISABLE_AUTOMATIC_MEMORY', value)
    expect(automaticMemoryEnabled()).toBe(true)
  }
  vi.stubEnv('WEWORKER_DISABLE_AUTOMATIC_MEMORY', '1')
  expect(automaticMemoryEnabled()).toBe(false)
})

it('does not touch the store even when a candidate reaches the lifecycle', async () => {
  vi.stubEnv('WEWORKER_DISABLE_AUTOMATIC_MEMORY', '1')
  const store = new Proxy({}, { get() { throw new Error('store must not be accessed') } }) as MemoryStore
  expect(await processMemoryEvent({ eventId: 'example-event', scope: { user: 'local' }, store,
    candidate: { action: 'create', memory_type: 'user_usage', key: 'example', content: 'Example preference' } })).toEqual({ status: 'not_applicable' })
})
