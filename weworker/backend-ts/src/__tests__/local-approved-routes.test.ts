import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLocalApprovedRouteService, LocalRouteError, renderLocalRouteResult, type LocalRouteInput } from '../api-query-router/local-approved-routes.js'
import type { ToolCatalog, CatalogTool } from '../api-query-router/tool-catalog.js'

const dirs: string[] = []
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-routes-test-')); dirs.push(dir)
  const tool: CatalogTool = { name: 'example.list', adapterId: 'example', description: '', parameters: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['limit'], additionalProperties: false }, safety: 'read', direct: true, requiresConfirmation: false, aliases: [] }
  const catalog: ToolCatalog = { tools: [tool], directTools: [tool], adapterIds: new Set(['example']), byName: new Map([[tool.name, tool]]) }
  const input: LocalRouteInput = { workspaceId: 'workspace-A', question: 'List example records?', tool: tool.name, args: { limit: 2 }, display: { columns: [{ key: 'name', type: 'text' }], maxRows: 2 } }
  return { service: createLocalApprovedRouteService(path.join(dir, 'approved.json')), input, catalog, dir, tool }
}
const response = JSON.stringify({ ok: true, items: [{ name: 'One', secret: 'hidden' }, { name: 'Two', secret: 'hidden' }] })
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
describe('local approved exact route', () => {
  it('requires explicit successful preview, writes private versioned file, exact scope and normalized equality', async () => {
    const { service, input, catalog, dir } = fixture()
    expect(() => service.approve(input, 'not-previewed', 0, { catalog })).toThrowError(LocalRouteError)
    let calls = 0
    const preview = await service.preview(input, { workId: 'turn', catalog, dispatch: async () => { calls++; return response } })
    expect(calls).toBe(1)
    expect(preview.markdown).toContain('One')
    expect(preview.markdown).not.toContain('hidden')
    const route = service.approve(input, preview.token, 0, { catalog })
    expect(route.tool).toBe('example.list')
    expect(service.snapshot().revision).toBe(1)
    expect(service.lookup(' LIST  example RECORDS?', 'workspace-A', { catalog }).route?.id).toBe(route.id)
    expect(service.lookup('List example records!', 'workspace-A', { catalog }).route).toBeNull()
    expect(service.lookup(input.question, 'workspace-B', { catalog }).route).toBeNull()
    expect(service.lookup(input.question, 'workspace-A', { catalog, isReserved: () => true }).route).toBeNull()
    const file = JSON.parse(fs.readFileSync(path.join(dir, 'approved.json'), 'utf8'))
    expect(file.schemaVersion).toBe(1)
    expect(file.checksum).toMatch(/^[a-f0-9]{64}$/)
    expect(file.routes).toHaveLength(1)
  })

  it('fails closed on corruption without wiping or replacing existing records', async () => {
    const { service, input, catalog, dir } = fixture()
    const ticket = await service.preview(input, { workId: 'turn', catalog, dispatch: async () => response })
    service.approve(input, ticket.token, 0, { catalog })
    const file = path.join(dir, 'approved.json')
    fs.writeFileSync(file, '{broken json', 'utf8')
    expect(service.snapshot().status).toBe('invalid')
    expect(service.lookup(input.question, input.workspaceId, { catalog }).route).toBeNull()
    await expect(service.preview(input, { workId: 'turn', catalog, dispatch: async () => response })).rejects.toMatchObject({ reason: 'invalid' })
    expect(() => service.remove('anything', input.workspaceId, 1)).toThrowError(LocalRouteError)
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken json')
  })

  it('suspends changed, missing, disabled and unsafe tools while keeping route on disk', async () => {
    const { service, input, catalog, tool } = fixture()
    const ticket = await service.preview(input, { workId: 'turn', catalog, dispatch: async () => response })
    service.approve(input, ticket.token, 0, { catalog })
    for (const changed of [ { ...tool, safety: 'write' }, { ...tool, requiresConfirmation: true }, { ...tool, parameters: { ...tool.parameters, description: 'changed' } } ]) {
      const current = { ...catalog, byName: new Map([[tool.name, changed]]) }
      expect(service.lookup(input.question, input.workspaceId, { catalog: current }).reason).toBe('suspended')
      expect(service.snapshot().routes).toHaveLength(1)
    }
    expect(service.lookup(input.question, input.workspaceId, { catalog: { ...catalog, byName: new Map() } }).reason).toBe('suspended')
  })

  it('rejects unsafe args, unsafe field names, result secrets, and unsuccessful dispatch without writing', async () => {
    const { service, input, catalog } = fixture()
    await expect(service.preview({ ...input, args: { limit: 20 } }, { workId: 'turn', catalog, dispatch: async () => response })).rejects.toMatchObject({ reason: 'unavailable' })
    await expect(service.preview({ ...input, display: { columns: [{ key: 'secret', type: 'text' }], maxRows: 2 } }, { workId: 'turn', catalog, dispatch: async () => response })).rejects.toMatchObject({ reason: 'unsafe' })
    await expect(service.preview(input, { workId: 'turn', catalog, dispatch: async () => '{"error":"auth required"}' })).rejects.toMatchObject({ reason: 'dispatch_failed' })
    expect(() => renderLocalRouteResult('{"ok":true,"items":[{"name":"<img src=x>"}]}', input.display)).toThrowError(LocalRouteError)
    expect(service.snapshot().revision).toBe(0)
  })

  it('rejects ambiguous arrays, missing or contradictory success, and unsafe hidden rows', () => {
    const { input } = fixture()
    const rejects = [
      { items: [{ name: 'One' }] },
      { ok: false, items: [{ name: 'One' }] },
      { ok: true, code: 401, items: [{ name: 'One' }] },
      { ok: true, status: 'failed', items: [{ name: 'One' }] },
      { ok: true, message: 'not logged in', items: [{ name: 'One' }] },
      { ok: true, records: [{ name: 'One' }] },
      { ok: true, items: [{ name: 'One' }], records: [{ name: 'Two' }] },
      { ok: true, items: [], records: [{ name: 'Two' }] },
      { ok: true, result: { items: [{ name: 'One' }] }, data: { items: [{ name: 'Two' }] } },
      { ok: true, items: [{ name: 'One' }, { name: 'Two' }, { name: '<img src=x>' }] },
      { ok: true, items: [{ name: 'One' }, { name: 'Two' }, { name: 'token=example-placeholder' }] },
      { ok: true, items: [{ name: 'One' }, { name: 'Two' }, { name: 42 }] },
    ]
    for (const payload of rejects) expect(() => renderLocalRouteResult(JSON.stringify(payload), input.display)).toThrowError(LocalRouteError)
  })

  it('checks column types and escapes markdown instead of interpreting values', () => {
    const display: LocalRouteInput['display'] = { maxRows: 2, columns: [
      { key: 'name', type: 'text', title: 'Name' }, { key: 'count', type: 'number' },
      { key: 'day', type: 'date' }, { key: 'state', type: 'status' },
    ] }
    const row = { name: '[click](example.com) | **bold**', count: 3.5, day: '2025-02-03', state: '`active`' }
    const md = renderLocalRouteResult(JSON.stringify({ success: true, items: [row] }), display)
    expect(md).toContain('\\[click\\]\\(example\\.com\\) \\| \\*\\*bold\\*\\*')
    expect(md).toContain('\\`active\\`')
    expect(md).not.toContain('[click](example.com)')
    for (const changed of [{ ...row, count: '3' }, { ...row, count: true }, { ...row, day: 'yesterday' }, { ...row, state: false }, { ...row, count: null }]) {
      expect(() => renderLocalRouteResult(JSON.stringify({ success: true, items: [changed] }), display)).toThrowError(LocalRouteError)
    }
    expect(() => renderLocalRouteResult(JSON.stringify({ ok: true, items: [row] }), { ...display, columns: [{ key: 'name', type: 'text', title: '**Injected**' }] })).toThrowError(LocalRouteError)
  })

  it('executes only the matching persisted current read route; fails closed without chat persistence', async () => {
    const { service, input, catalog, tool } = fixture()
    const ticket = await service.preview(input, { workId: 'turn', catalog, dispatch: async () => response })
    const route = service.approve(input, ticket.token, 0, { catalog })
    const calls: string[] = []
    const dispatch = async (name: string, args: string, workId: string) => { calls.push(`${name}/${args}/${workId}`); return response }
    const options = { workId: 'turn', catalog, dispatch }
    expect(await service.execute(route, options)).toContain('One')
    expect(calls).toEqual(['example.list/{"limit":2}/turn'])
    expect(await service.execute({ ...route, args: { limit: 5 } }, options)).toBeNull()
    expect(await service.execute(route, { ...options, isReserved: () => true })).toBeNull()
    expect(await service.execute(route, { ...options, catalog: { ...catalog, byName: new Map([[tool.name, { ...tool, safety: 'write' }]]) } })).toBeNull()
    expect(calls).toHaveLength(1)
    expect(await service.execute(route, { ...options, dispatch: async () => '{"error":"not logged in"}' })).toBeNull()
    expect(await service.execute(route, { ...options, dispatch: async () => '{"ok":true,"items":[{"name":"<script>bad</script>"}]}' })).toBeNull()
    expect(service.snapshot().routes).toHaveLength(1)
  })

  it('requires revision and exact preview input; deletion only removes its own route', async () => {
    const { service, input, catalog } = fixture()
    const preview = await service.preview(input, { workId: 'turn', catalog, dispatch: async () => response })
    expect(() => service.approve({ ...input, question: 'different question' }, preview.token, 0, { catalog })).toThrowError(LocalRouteError)
    const second = await service.preview(input, { workId: 'turn', catalog, dispatch: async () => response })
    expect(() => service.approve(input, second.token, 5, { catalog })).toThrowError(LocalRouteError)
    const route = service.approve(input, second.token, 0, { catalog })
    expect(() => service.remove(route.id, input.workspaceId, 0)).toThrowError(LocalRouteError)
    expect(() => service.remove(route.id, 'workspace-B', 1)).toThrowError(LocalRouteError)
    service.remove(route.id, input.workspaceId, 1)
    expect(service.snapshot()).toMatchObject({ revision: 2, routes: [] })
  })
})
