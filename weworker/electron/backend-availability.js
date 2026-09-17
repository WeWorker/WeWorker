import { isStandaloneWeWorkerBackend } from './local-service.js'

// Port 8765 availability decision logic for NodeManager. This module must
// stay free of electron imports so the state machine is testable under plain
// `node --test`. NodeManager wires it to real probes in managers.js.

export const BACKEND_PORT = 8765
// A busy (but healthy) standalone backend can easily block the event loop for
// a few seconds (sqlite checkpoint, sync compaction, ...). The startup probe
// budget spans that window so a transient stall is not mistaken for a foreign
// process holding the port.
export const START_PROBE_TIMEOUT_MS = 3000
export const EXTERNAL_MONITOR_INTERVAL_MS = 3000
export const EXTERNAL_MONITOR_PROBE_TIMEOUT_MS = 1000
// The external monitor escalates only after this many consecutive failed
// probes (~9s of sustained unavailability). A single 1s timeout must not
// trigger a backend replacement.
export const EXTERNAL_FAILURE_THRESHOLD = 3
export const PORT_IN_USE_MONITOR_INTERVAL_MS = 5000

// Resolve how the manager should treat port 8765 right now:
//   'free'        — nothing listens, a managed backend may be spawned
//   'external'    — a standalone WeWorker backend answers /status (dev only)
//   'port_in_use' — occupied by a foreign or unresponsive process
export async function resolveBackendAvailability({ checkPort, probeStatus, allowExternal = true }) {
  const occupied = await checkPort(BACKEND_PORT)
  if (!occupied) return 'free'
  if (allowExternal) {
    const status = await probeStatus(START_PROBE_TIMEOUT_MS)
    if (isStandaloneWeWorkerBackend(status)) return 'external'
  }
  return 'port_in_use'
}

// Watches an adopted standalone backend. Only sustained unavailability
// (threshold consecutive failures) reports it gone; transient stalls are
// tolerated so the desktop app never flips to a wrong state because of one
// slow probe.
export class ExternalBackendMonitor {
  constructor({ probeStatus, onUnavailable, threshold = EXTERNAL_FAILURE_THRESHOLD }) {
    this._probeStatus = probeStatus
    this._onUnavailable = onUnavailable
    this._threshold = threshold
    this._timer = null
    this._checking = false
    this._failures = 0
  }

  start(intervalMs = EXTERNAL_MONITOR_INTERVAL_MS) {
    if (this._timer) return
    this._failures = 0
    this._timer = setInterval(() => { void this._tick() }, intervalMs)
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
    this._failures = 0
  }

  isRunning() {
    return this._timer !== null
  }

  async _tick() {
    if (this._checking) return
    this._checking = true
    try {
      const status = await this._probeStatus(EXTERNAL_MONITOR_PROBE_TIMEOUT_MS)
      if (isStandaloneWeWorkerBackend(status)) {
        this._failures = 0
        return
      }
      this._failures += 1
      if (this._failures >= this._threshold) {
        this.stop()
        this._onUnavailable()
      }
    } finally {
      this._checking = false
    }
  }
}

// 'port_in_use' is not a terminal state. The port may belong to a busy
// standalone backend that starts answering again, or the holder may exit.
// Either way the manager re-runs the availability decision and recovers
// without a manual app restart.
export class PortInUseMonitor {
  constructor({ checkPort, probeStatus, allowExternal, onRecovered }) {
    this._checkPort = checkPort
    this._probeStatus = probeStatus
    this._allowExternal = allowExternal
    this._onRecovered = onRecovered
    this._timer = null
    this._checking = false
  }

  start(intervalMs = PORT_IN_USE_MONITOR_INTERVAL_MS) {
    if (this._timer) return
    this._timer = setInterval(() => { void this._tick() }, intervalMs)
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  }

  isRunning() {
    return this._timer !== null
  }

  async _tick() {
    if (this._checking) return
    this._checking = true
    try {
      const availability = await resolveBackendAvailability({
        checkPort: this._checkPort,
        probeStatus: this._probeStatus,
        allowExternal: this._allowExternal,
      })
      if (availability === 'free' || availability === 'external') {
        this.stop()
        this._onRecovered(availability)
      }
    } finally {
      this._checking = false
    }
  }
}
