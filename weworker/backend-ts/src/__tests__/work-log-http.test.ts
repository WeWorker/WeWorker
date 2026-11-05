import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendWorkLog, configureWorkLogs, readWorkLog } from '../work-log-file.js'

let directory: string
let server: Server
let url: string
const work = { id: 'fixture-work', messages: [] }
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'work-log-http-'))
  configureWorkLogs(directory)
  const app = express()
  // Exercise the actual endpoint without starting schedulers, bots or the user's DB.
  const source = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
  const start = source.indexOf("app.get('/works/:id/logs.txt'")
  const route = source.slice(start, source.indexOf('\n})', start) + 3)
  new Function('app', 'store', 'readWorkLog', route)(app, {
    getWorkWithMessages: (id: string) => id === work.id ? work : undefined,
  }, readWorkLog)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test address')
  url = 'http://127.0.0.1:' + address.port
})
afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  configureWorkLogs(undefined)
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('copy and download conversation logs', () => {
  it('returns the existing file byte-for-byte from the shared endpoint, including newly appended events', async () => {
    appendWorkLog(work.id, 'tool_call_result', { result: '中文结果'.repeat(2_000) + 'FIRST-END' })
    const copy = await fetch(url + '/works/' + work.id + '/logs.txt')
    expect(copy.status).toBe(200)
    expect(copy.headers.get('Content-Type')).toContain('text/plain')
    expect(await copy.text()).toBe(fs.readFileSync(path.join(directory, work.id + '.log'), 'utf8'))
    appendWorkLog(work.id, 'done', { text: 'LAST-END' })
    const download = await fetch(url + '/works/' + work.id + '/logs.txt')
    expect(download.headers.get('Content-Disposition')).toContain('attachment;')
    const output = await download.text()
    expect(output).toBe(fs.readFileSync(path.join(directory, work.id + '.log'), 'utf8'))
    expect(output).toContain('FIRST-END')
    expect(output).toContain('LAST-END')
  })

  it('returns 404 for missing works and 500 for unreadable files, not an apparently successful empty export', async () => {
    expect((await fetch(url + '/works/missing/logs.txt')).status).toBe(404)
    fs.mkdirSync(path.join(directory, work.id + '.log'))
    const response = await fetch(url + '/works/' + work.id + '/logs.txt')
    expect(response.status).toBe(500)
    expect(await response.text()).toContain('读取失败')
  })
})
