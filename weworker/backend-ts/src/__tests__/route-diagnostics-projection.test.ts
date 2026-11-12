import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { projectRouteDiagnostics, readRouteDiagnostics } from '../route-diagnostics-projection.js'
import { configureWorkLogs } from '../work-log-file.js'

const line = (type: string, turnId: string, data: unknown) => JSON.stringify({ time: '2026-01-01T00:00:00.000Z', type, turnId, data })
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'route-project-test-'))
afterEach(() => { configureWorkLogs(undefined); fs.rmSync(path.join(directory, 'work-one.log'), { force: true }) })

describe('allowlisted work-log route projection', () => {
  it('returns only reviewed scalars, rejects hostile fields and never copies raw lines', () => {
    const secret = 'private-secret-value'
    const text = [
      line('route_input', 'turn-one', { message: secret }),
      line('route_diagnostic', 'turn-one', { phase: 'route_config', fingerprint: '0123456789abcdef', sources: [{ path: secret }], message: secret }),
      line('route_diagnostic', 'turn-one', { phase: 'candidate_selected', layer: 'pattern', tool: 'example.com.read', rule: secret, argsTypes: { string: 1 }, secret }),
      line('route_diagnostic', 'turn-one', { phase: 'dispatch_failed', category: 'error_payload', fallback: 'llm', error: secret, tool: secret }),
      line('execution_error', 'turn-one', { stack: secret }),
    ].join('\n') + '\n'
    const result = projectRouteDiagnostics(text)
    expect(result.turns).toHaveLength(1)
    expect(result.turns[0].status).toBe('fallback')
    expect(result.turns[0].events).toHaveLength(3)
    expect(result.turns[0].events[1]).toMatchObject({ layer: 'pattern', tool: 'example.com.read' })
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it('distinguishes skipped, missed, handled and unconfirmed stages without inventing Agent outcomes', () => {
    const text = [
      line('route_diagnostic', 'one', { phase: 'route_skipped', reason: 'permission_ask' }),
      line('route_diagnostic', 'two', { phase: 'route_unmatched', reason: 'no_eligible_candidate' }),
      line('route_diagnostic', 'three', { phase: 'route_finished', handled: true }),
      line('route_diagnostic', 'four', { phase: 'candidate_selected' }),
    ].join('\n') + '\n'
    expect(projectRouteDiagnostics(text).turns.map(turn => turn.status)).toEqual(['skipped', 'missed', 'answered', 'incomplete'])
  })

  it('flags gaps and malformed records; validates IDs and missing files', () => {
    fs.writeFileSync(path.join(directory, 'work-one.log'), [
      line('route_diagnostic', 'turn-one', { phase: 'route_disabled', reason: 'environment_switch' }),
      line('log_write_gap', 'turn-one', { error: 'private-secret-value' }),
      '{malformed',
    ].join('\n') + '\n')
    configureWorkLogs(directory)
    expect(readRouteDiagnostics('work-one')).toMatchObject({ incomplete: true, turns: [{ status: 'skipped' }] })
    expect(readRouteDiagnostics('missing')).toEqual({ turns: [], incomplete: true })
    expect(() => readRouteDiagnostics('../work-one')).toThrow('Invalid work ID')
  })
})
