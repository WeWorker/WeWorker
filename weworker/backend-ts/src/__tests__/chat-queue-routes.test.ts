import fs from 'node:fs'
import vm from 'node:vm'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { createChatTurnRegistry } from '../chat-turn-lifecycle.js'

function fixture() {
  const source = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
  const start = source.indexOf('const chatTurns = createChatTurnRegistry()')
  const end = source.indexOf('\nasync function handleChatRequest(', start)
  const routes = new Map<string, (req: any, res: any) => Promise<void> | void>()
  const steer = vi.fn(() => true)
  const lookup = vi.fn(() => ({ steer }))
  const notify = vi.fn()
  const previousAssistant = { id: 'previous-fixture', role: 'assistant', content: [{ type: 'text', text: 'before steering' }] }
  const checkpoint = vi.fn(() => previousAssistant)
  const append = vi.fn((id, role, content) => ({ id: 'saved-fixture', role, content }))
  const importAttachments = vi.fn((files: any[]) => files.map(file => ({ type: 'file_attachment', ...file })))
  let finish!: () => void
  const hold = new Promise<void>(resolve => { finish = resolve })
  const run = vi.fn((_req: any, _res: any, _controller: AbortController) => hold)
  const context = vm.createContext({
    app: { post: (route: string, handler: any) => routes.set(route, handler) },
    createChatTurnRegistry, getSteerableChatSession: lookup, notify, checkpoint,
    store: { getWork: () => ({ id: 'fixture-work' }), getWorkspaceDirectoryForWork: () => undefined, appendMessage: append },
    importChatAttachments: importAttachments, messagePromptText: (message: any) => JSON.stringify(message.content),
    createHash, channelQrId: () => '11111111-1111-4111-8111-111111111111', handleChatRequest: run,
  })
  vm.runInContext(ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context)
  vm.runInContext("chatSteeringListeners.set('fixture-work', { checkpoint, notify })", context)
  const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn(), on: vi.fn(), off: vi.fn() })
  return { routes, steer, lookup, notify, checkpoint, previousAssistant, append, importAttachments, finish, run, response }
}

describe('chat queue endpoints', () => {
  it('persists steering and attachments then sends through the existing session', async () => {
    const f = fixture(); const res = f.response()
    await f.routes.get('/works/:id/chat/steer')!({ params: { id: 'fixture-work' }, body: { message: 'correction', attachments: [{ name: 'sample.txt', path: 'C:/weworker-fixtures/sample.txt' }] } }, res)
    expect(f.append).toHaveBeenCalledTimes(1)
    expect(f.checkpoint.mock.invocationCallOrder[0]).toBeLessThan(f.append.mock.invocationCallOrder[0])
    expect(f.steer).toHaveBeenCalledWith(expect.objectContaining({ type: 'user', message: expect.objectContaining({ content: expect.stringContaining('correction') }) }), expect.objectContaining({ id: 'saved-fixture', role: 'user' }), expect.objectContaining({ id: 'previous-fixture', role: 'assistant' }))
    expect(f.notify).toHaveBeenCalledWith(expect.objectContaining({ id: 'saved-fixture' }), undefined, f.previousAssistant)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'accepted', previousAssistant: f.previousAssistant }))
  })
  it('rejects unavailable steering without persisting a message', async () => {
    const f = fixture(); const res = f.response(); f.lookup.mockReturnValue(undefined as any)
    await f.routes.get('/works/:id/chat/steer')!({ params: { id: 'fixture-work' }, body: { message: 'correction' } }, res)
    expect(res.status).toHaveBeenCalledWith(409)
    expect(f.append).not.toHaveBeenCalled()
    expect(f.steer).not.toHaveBeenCalled()
    expect(f.checkpoint).not.toHaveBeenCalled()
  })
  it('validates empty input and invalid attachments before saving', async () => {
    const f = fixture(); const res = f.response()
    await f.routes.get('/works/:id/chat/steer')!({ params: { id: 'fixture-work' }, body: { message: ' ' } }, res)
    expect(res.status).toHaveBeenCalledWith(400)
    f.importAttachments.mockImplementation(() => { throw new Error('invalid fixture attachment') })
    await f.routes.get('/works/:id/chat/steer')!({ params: { id: 'fixture-work' }, body: { message: 'correction', attachments: [{}] } }, res)
    expect(f.append).not.toHaveBeenCalled()
  })
  it('holds the lock until handler cleanup and acknowledges stop afterwards', async () => {
    const f = fixture(); const req = { params: { id: 'fixture-work' }, body: { message: 'first' } }
    const running = f.routes.get('/works/:id/chat')!(req, f.response())
    const overlap = f.response()
    await f.routes.get('/works/:id/chat')!(req, overlap)
    expect(overlap.status).toHaveBeenCalledWith(409)
    const stop = f.response()
    const stopping = f.routes.get('/works/:id/chat/stop')!(req, stop)
    expect(f.run.mock.calls[0][2].signal.aborted).toBe(true)
    expect(stop.json).not.toHaveBeenCalled()
    f.finish(); await running; await stopping
    expect(stop.json).toHaveBeenCalledWith({ status: 'stopped' })
  })
})
