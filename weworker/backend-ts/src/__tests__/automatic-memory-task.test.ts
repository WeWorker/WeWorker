import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '../works-store.js'

const mocks = vi.hoisted(() => ({ getMemoryStore: vi.fn(), failed: false }))
vi.mock('../memory/memory-store.js', async (original) => ({
  ...(await original<typeof import('../memory/memory-store.js')>()),
  getMemoryStore: mocks.getMemoryStore,
}))
vi.mock('../config.js', () => ({ getSettings: () => ({}), getSiteEnabled: () => false }))
vi.mock('../adapter-parser.js', () => ({ parseAllAdapters: () => new Map() }))
vi.mock('../style-settings.js', () => ({ resolveStyleId: () => undefined }))
vi.mock('../logger.js', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {} }) }))
vi.mock('../notifier.js', () => ({ notify: async () => {} }))
vi.mock('../works-store.js', () => ({
  listTaskExecutions: () => [], createWork: () => ({ id: 'fixture-work' }),
  createTaskExecution: () => ({ id: 'fixture-execution' }),
  updateTaskExecution: () => {}, appendMessage: () => {},
  getWorkWithMessages: () => ({ id: 'fixture-work', messages: [] }),
}))
vi.mock('../agent.js', () => ({
  streamChat: async function* () {
    yield { type: 'memory_candidate', candidate: { action: 'create', memory_type: 'task_execution', key: 'fixture', content: 'Public test memory' } }
    if (mocks.failed) yield { type: 'error', content: 'fixture failure' }
    else yield { type: 'text_delta', content: 'fixture response' }
  },
}))

import { executeTask } from '../task-executor.js'
import { MemoryStore } from '../memory/memory-store.js'

afterEach(() => { vi.unstubAllEnvs(); mocks.getMemoryStore.mockReset(); mocks.failed = false })

it.each([{ disabled: true, failed: false }, { disabled: true, failed: true }, { disabled: false, failed: false }, { disabled: false, failed: true }])(
  'executes a scheduled task with memory disabled=$disabled and failed=$failed', async ({ disabled, failed }) => {
    vi.stubEnv('WEWORKER_DISABLE_AUTOMATIC_MEMORY', disabled ? '1' : '0')
    mocks.failed = failed
    const db = new DatabaseSync(':memory:')
    const memoryStore = new MemoryStore(db)
    mocks.getMemoryStore.mockReturnValue(memoryStore)
    try {
      const result = await executeTask({ id: 'fixture-task', title: 'Example', prompt_template: 'Example task', notify_channels: [] } as unknown as ScheduledTask)
      await new Promise(resolve => setImmediate(resolve))
      expect(result.status).toBe(failed ? 'failed' : 'completed')
      expect(mocks.getMemoryStore).toHaveBeenCalledTimes(disabled ? 0 : 1)
      expect(memoryStore.listActiveAll()).toHaveLength(disabled ? 0 : 1)
      expect(db.prepare('SELECT count(*) AS count FROM memory_events').get()).toEqual({ count: disabled ? 0 : 1 })
    } finally { memoryStore.close() }
  },
)
