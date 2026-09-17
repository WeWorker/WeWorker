import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BACKEND_PORT,
  ExternalBackendMonitor,
  PortInUseMonitor,
  resolveBackendAvailability,
} from '../backend-availability.js'

function standaloneStatus() {
  return { service: 'weworker-backend', runtime_mode: 'standalone', backend_instance_id: '' }
}

function managedStatus() {
  return { service: 'weworker-backend', runtime_mode: 'managed', backend_instance_id: 'abc' }
}

test('resolveBackendAvailability returns free without probing when the port is not occupied', async () => {
  let probes = 0
  const availability = await resolveBackendAvailability({
    checkPort: async (port) => {
      assert.equal(port, BACKEND_PORT)
      return false
    },
    probeStatus: async () => {
      probes += 1
      return standaloneStatus()
    },
    allowExternal: true,
  })
  assert.equal(availability, 'free')
  assert.equal(probes, 0)
})

test('resolveBackendAvailability adopts a responding standalone backend in dev mode', async () => {
  const availability = await resolveBackendAvailability({
    checkPort: async () => true,
    probeStatus: async () => standaloneStatus(),
    allowExternal: true,
  })
  assert.equal(availability, 'external')
})

test('resolveBackendAvailability reports port_in_use when the holder never answers', async () => {
  const availability = await resolveBackendAvailability({
    checkPort: async () => true,
    probeStatus: async () => null,
    allowExternal: true,
  })
  assert.equal(availability, 'port_in_use')
})

test('resolveBackendAvailability never adopts an external backend when allowExternal is false', async () => {
  const availability = await resolveBackendAvailability({
    checkPort: async () => true,
    probeStatus: async () => standaloneStatus(),
    allowExternal: false,
  })
  assert.equal(availability, 'port_in_use')
})

test('resolveBackendAvailability rejects a managed backend from another instance', async () => {
  const availability = await resolveBackendAvailability({
    checkPort: async () => true,
    probeStatus: async () => managedStatus(),
    allowExternal: true,
  })
  assert.equal(availability, 'port_in_use')
})

test('ExternalBackendMonitor tolerates transient probe failures without escalating', async () => {
  const probeResults = [null, standaloneStatus(), null, null, standaloneStatus(), null]
  let probeIndex = 0
  let escalations = 0
  const monitor = new ExternalBackendMonitor({
    probeStatus: async () => probeResults[Math.min(probeIndex++, probeResults.length - 1)],
    onUnavailable: () => { escalations += 1 },
    threshold: 3,
  })
  for (let i = 0; i < probeResults.length; i += 1) {
    await monitor._tick()
  }
  assert.equal(escalations, 0)
})

test('ExternalBackendMonitor escalates once after the threshold of consecutive failures', async () => {
  let probes = 0
  const escalations = []
  const monitor = new ExternalBackendMonitor({
    probeStatus: async () => { probes += 1; return null },
    onUnavailable: () => { escalations.push(probes) },
    threshold: 3,
  })
  await monitor._tick()
  await monitor._tick()
  assert.equal(escalations.length, 0)
  await monitor._tick()
  assert.deepEqual(escalations, [3])
  await monitor._tick()
  assert.deepEqual(escalations, [3])
})

test('ExternalBackendMonitor escalates when another managed backend takes over the port', async () => {
  let escalations = 0
  const monitor = new ExternalBackendMonitor({
    probeStatus: async () => managedStatus(),
    onUnavailable: () => { escalations += 1 },
    threshold: 2,
  })
  await monitor._tick()
  assert.equal(escalations, 0)
  await monitor._tick()
  assert.equal(escalations, 1)
})

test('ExternalBackendMonitor start and stop manage the polling lifecycle', async () => {
  const monitor = new ExternalBackendMonitor({
    probeStatus: async () => standaloneStatus(),
    onUnavailable: () => {},
    threshold: 3,
  })
  assert.equal(monitor.isRunning(), false)
  monitor.start(60_000_000)
  assert.equal(monitor.isRunning(), true)
  monitor.start(60_000_000)
  assert.equal(monitor.isRunning(), true)
  monitor.stop()
  assert.equal(monitor.isRunning(), false)
})

test('PortInUseMonitor keeps waiting while the holder stays foreign', async () => {
  const recoveries = []
  const monitor = new PortInUseMonitor({
    checkPort: async () => true,
    probeStatus: async () => null,
    allowExternal: true,
    onRecovered: (availability) => { recoveries.push(availability) },
  })
  await monitor._tick()
  await monitor._tick()
  assert.deepEqual(recoveries, [])
  assert.equal(monitor.isRunning(), false)
})

test('PortInUseMonitor recovers with free once the port is released', async () => {
  let occupied = true
  const recoveries = []
  const monitor = new PortInUseMonitor({
    checkPort: async () => occupied,
    probeStatus: async () => null,
    allowExternal: true,
    onRecovered: (availability) => { recoveries.push(availability) },
  })
  await monitor._tick()
  assert.deepEqual(recoveries, [])
  occupied = false
  await monitor._tick()
  assert.deepEqual(recoveries, ['free'])
})

test('PortInUseMonitor adopts a standalone backend that starts answering again', async () => {
  let status = null
  const recoveries = []
  const monitor = new PortInUseMonitor({
    checkPort: async () => true,
    probeStatus: async () => status,
    allowExternal: true,
    onRecovered: (availability) => { recoveries.push(availability) },
  })
  await monitor._tick()
  assert.deepEqual(recoveries, [])
  status = standaloneStatus()
  await monitor._tick()
  assert.deepEqual(recoveries, ['external'])
})

test('PortInUseMonitor ignores a standalone backend when allowExternal is false', async () => {
  const recoveries = []
  const monitor = new PortInUseMonitor({
    checkPort: async () => true,
    probeStatus: async () => standaloneStatus(),
    allowExternal: false,
    onRecovered: (availability) => { recoveries.push(availability) },
  })
  await monitor._tick()
  await monitor._tick()
  assert.deepEqual(recoveries, [])
})
