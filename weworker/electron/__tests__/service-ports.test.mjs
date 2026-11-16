import assert from 'node:assert/strict'
import net from 'node:net'
import test from 'node:test'
import { selectServicePorts } from '../service-ports.js'

test('available preferred ports remain unchanged', async () => {
  const ports = await selectServicePorts({ backend: 0, exploration: 0, bridge: 0 })
  assert.equal(new Set(Object.values(ports)).size, 3)
  assert.ok(Object.values(ports).every(port => port > 0 && port <= 65535))
  assert.deepEqual(await selectServicePorts(ports), ports)
})

test('occupied ports are replaced without connecting to or stopping their holders', async t => {
  const holder = net.createServer(() => assert.fail('must probe by binding, not connect to foreign services'))
  await new Promise(resolve => holder.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => holder.close(resolve)))
  const preferred = holder.address().port
  const ports = await selectServicePorts({ backend: preferred, exploration: preferred, bridge: preferred })
  assert.equal(holder.listening, true)
  assert.equal(new Set(Object.values(ports)).size, 3)
  assert.ok(Object.values(ports).every(port => port !== preferred))
})

test('invalid port values fail before any service starts', async () => {
  for (const port of [-1, 65536, '8765', NaN, 1.5]) {
    await assert.rejects(selectServicePorts({ backend: port, exploration: 0, bridge: 0 }), /port/i)
  }
})
