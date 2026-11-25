import { createLogger } from './logger.js'

const log = createLogger('adapter-state-refresh')

export interface AdapterStateEvent {
  profile: string
  previousRevision: number
  revision: number
  adapters: string[]
  sync?: boolean
  hubInstall?: boolean
}

export interface AdapterStateRefreshDependencies {
  clearCache: () => void
  refreshSkills: () => unknown
  broadcast: (event: { type: 'adapter_state_changed' } & AdapterStateEvent) => void
  retryDelaysMs?: number[]
  logger?: (message: string, error?: unknown) => void
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Serialize Backend-side Adapter refreshes and retry transient Skill failures.
 * A state event is broadcast to Renderer only after the local catalog is fresh.
 */
export function createAdapterStateRefreshHandler({
  clearCache,
  refreshSkills,
  broadcast,
  retryDelaysMs = [100, 500],
  logger = (message, error) => log.error(message, error),
}: AdapterStateRefreshDependencies): (event: AdapterStateEvent) => void {
  let queue: Promise<void> = Promise.resolve()
  let active = false
  let pendingEvent: AdapterStateEvent | undefined

  const refresh = async (event: AdapterStateEvent): Promise<void> => {
    const delays = [...retryDelaysMs]
    for (let attempt = 0; ; attempt++) {
      try {
        clearCache()
        await refreshSkills()
        clearCache()
        broadcast({ type: 'adapter_state_changed', ...event })
        return
      } catch (error) {
        if (delays.length === 0) throw error
        const delay = delays.shift() ?? 0
        logger('Adapter state refresh attempt ' + (attempt + 1) + ' failed; retrying in ' + delay + 'ms', error)
        await wait(delay)
      }
    }
  }

  return (event) => {
    // Coalesce rapid installer commits to the newest revision while a refresh is active.
    pendingEvent = pendingEvent && pendingEvent.profile === event.profile
      ? { ...event, adapters: [...new Set([...pendingEvent.adapters, ...event.adapters])],
          sync: pendingEvent.sync || event.sync, hubInstall: pendingEvent.hubInstall && event.hubInstall }
      : event
    if (active) return
    active = true
    queue = (async () => {
      while (pendingEvent) {
        const current = pendingEvent
        pendingEvent = undefined
        await refresh(current)
      }
    })()
.catch((error) => logger('Failed to refresh managed Adapters after retries', error))
.finally(() => { active = false })
  }
}
