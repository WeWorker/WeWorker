import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import type { Server } from 'node:http'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { FileChangeStore } from '../file-changes.js'
import { readFileChangesForModel, registerFileChangeRoutes } from '../file-change-access.js'

let directory: string, store: FileChangeStore, id: string, server: Server, url: string
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'file-change-access-'))
  store = new FileChangeStore(directory)
  id = store.recordId('example-tool')
  store.save({ id, workId: 'example-work', turnId: 'example-turn', toolCallId: 'example-tool', tool: 'Edit', source: 'file_tool', status: 'completed', startedAt: new Date().toISOString(), files: [
    { path: '/example/report.txt', before: { state: 'text', text: 'before text' }, after: { state: 'text', text: 'after text' }, added: 1, removed: 1 },
  ] })
  const app = express()
  app.use((req, res, next) => { if (req.headers['x-weworker-auth'] !== 'example-test-token') { res.sendStatus(401); return }; next() })
  registerFileChangeRoutes(app, { store, workExists: workId => workId === 'example-work' || workId === 'other-work' })
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as { port: number }
  url = `http://127.0.0.1:${address.port}`
})
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(directory, { recursive: true, force: true }) })
const get = (route: string) => fetch(url + route, { headers: { 'X-WeWorker-Auth': 'example-test-token' } })

it('serves summaries and paginated comparisons without a mutation endpoint', async () => {
  expect((await fetch(url + '/works/example-work/file-changes')).status).toBe(401)
  const list = await get('/works/example-work/file-changes?tools=example-tool')
  expect((await list.json()).records[0]).toMatchObject({ id, fileCount: 1, files: [{ operation: 'edit' }] })
  const detail = await get(`/works/example-work/file-changes/${id}?file=0`)
  expect(await detail.json()).toMatchObject({ id, file: { operation: 'edit', before: { text: 'before text' }, after: { text: 'after text' } }, diff: { added: 1, removed: 1 } })
  expect((await get(`/works/other-work/file-changes/${id}`)).status).toBe(404)
  expect((await get(`/works/example-work/file-changes/${id}?file=-1`)).status).toBe(400)
  expect((await get('/works/missing/file-changes')).status).toBe(404)
  expect((await fetch(url + `/works/example-work/file-changes/${id}/undo`, { method: 'POST', headers: { 'X-WeWorker-Auth': 'example-test-token' } })).status).toBe(404)
})

it('gives the AI scoped, bounded records and rechecks file access on every read', async () => {
  const allow = async () => true
  const list = await readFileChangesForModel(store, 'example-work', {}, allow)
  expect(JSON.stringify(list)).toContain(id)
  const detail = await readFileChangesForModel(store, 'example-work', { change_id: id, limit: 4 }, allow)
  expect(detail).toMatchObject({ before: { text: 'befo', truncated: true, nextOffset: 4 }, after: { text: 'afte' } })
  expect(await readFileChangesForModel(store, 'example-work', { change_id: id }, async () => false)).toMatchObject({ error: expect.any(String) })
  expect(await readFileChangesForModel(store, 'other-work', { change_id: id }, allow)).toMatchObject({ error: expect.any(String) })
  expect(await readFileChangesForModel(store, null, {}, allow)).toMatchObject({ error: expect.any(String) })
  expect((await readFileChangesForModel(store, 'example-work', {}, async () => false) as any).records).toEqual([])
})

it('keeps original file indexes when the AI cannot access every file in a record', async () => {
  const record = store.read('example-work', id)!
  record.files.push({ ...record.files[0], path: '/example/allowed.txt' })
  store.save(record)
  const allow = async (file: string) => file.endsWith('/allowed.txt')
  const list = await readFileChangesForModel(store, 'example-work', {}, allow) as any
  expect(list.records[0].files).toMatchObject([{ path: '/example/allowed.txt', file_index: 1 }])
  const detail = await readFileChangesForModel(store, 'example-work', { change_id: id, file_index: list.records[0].files[0].file_index }, allow)
  expect(detail).toMatchObject({ path: '/example/allowed.txt' })
})
