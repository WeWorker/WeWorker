import { beforeEach, describe, expect, it, vi } from 'vitest'
import { redeemReadQueryReceipt, bindReadQueryReceipt } from '../read-query-receipts.js'

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  catalog: vi.fn(),
}))
vi.mock('../webcli-runner.js', () => ({ runWebcliCall: mocks.run }))
vi.mock('../api-query-router/tool-catalog.js', () => ({ getCatalog: mocks.catalog }))
vi.mock('../logger.js', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }))
vi.mock('../works-store.js', () => ({ createScheduledTask: vi.fn(), listScheduledTasks: vi.fn(() => []) }))
vi.mock('../scheduler.js', () => ({ scheduler: {}, Scheduler: {} }))
vi.mock('../channels/channel-manager.js', () => ({ channelManager: {} }))

const toolDef = { name: 'example.com.list', adapterId: 'example.com', direct: true, safety: 'read', requiresConfirmation: false,
  parameters: { type: 'object', properties: { page: { type: 'integer' }, query: { type: 'string' } }, additionalProperties: false } }
const result = (value: { content: Array<{ text: string }> }) => JSON.parse(value.content[0].text) as Record<string, unknown>
async function handler(scope: { workId: string | null; turnId: string | null } = { workId: 'work', turnId: 'turn' }) {
  const { buildMcpServer } = await import('../tools.js')
  const server = buildMcpServer({ channelPermissionMode: 'full', workId: 'work', readQueryScope: () => scope })
  return (server.instance as unknown as { _registeredTools: Record<string, { handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> })
    ._registeredTools.weworker_read_query.handler
}

describe('guarded structured WebCLI read query', () => {
  beforeEach(() => {
    mocks.run.mockReset().mockResolvedValue('{"ok":true,"data":{"items":[{"id":1}]}}')
    mocks.catalog.mockReset().mockReturnValue({ byName: new Map([[toolDef.name, toolDef]]), adapterIds: new Set(['example.com']) })
  })
  it('runs real WebCLI, issues only a bound one-use attestation for exact safe args', async () => {
    const call = await handler()
    const output = result(await call({ name: toolDef.name, args: { page: 2 } }))
    expect(mocks.run).toHaveBeenCalledWith(toolDef.name, '{"page":2}', 'work', { timeoutMs: 30_000 })
    expect(output.weworkerReadQueryReceipt).toEqual(expect.any(String))
    const token = output.weworkerReadQueryReceipt as string
    expect(bindReadQueryReceipt(token, 'work', 'turn', 'sdk-call')).toBe(true)
    expect(redeemReadQueryReceipt(token, 'work', 'sdk-call')).toEqual({ tool: toolDef.name, fixedArgs: { page: 2 } })
  })
  it('does not learn unknown, sensitive, or incomplete arguments', async () => {
    const call = await handler()
    const unsupported = result(await call({ name: toolDef.name, args: { query: 'private text' } }))
    expect(unsupported.weworkerReadQueryReceipt).toBeUndefined()
    expect(mocks.run).toHaveBeenCalledTimes(1)
    const invalid = result(await call({ name: toolDef.name, args: { arbitrary: true } }))
    expect(invalid.error).toBeTruthy()
    expect(mocks.run).toHaveBeenCalledTimes(1)
  })
  it('does not attest ambiguous success, failed business status, writes, or expired turns', async () => {
    const call = await handler()
    mocks.run.mockResolvedValueOnce('{"ok":true}')
    expect(result(await call({ name: toolDef.name, args: {} })).weworkerReadQueryReceipt).toBeUndefined()
    mocks.run.mockResolvedValueOnce('{"ok":false,"data":{"items":[1]}}')
    expect(result(await call({ name: toolDef.name, args: {} })).weworkerReadQueryReceipt).toBeUndefined()
    mocks.catalog.mockReturnValue({ byName: new Map([[toolDef.name, { ...toolDef, safety: 'write' }]]), adapterIds: new Set(['example.com']) })
    expect(result(await call({ name: toolDef.name, args: {} })).error).toBeTruthy()
    const stale = await handler({ workId: 'work', turnId: null })
    expect(result(await stale({ name: toolDef.name, args: {} })).error).toBeTruthy()
  })
})
