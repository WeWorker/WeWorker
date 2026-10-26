import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import XLSX from 'xlsx'

import {
  handleBackendRuntimeFetch,
  handleBackendRuntimeFileRead,
  handleBackendRuntimeFileWrite,
  handleBackendRuntimeXlsxRead,
} from '../bridge.js'

const tempDirs = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('backend runtime helpers', () => {
  it('performs http backend fetch and returns raw response text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })))

    const result = await handleBackendRuntimeFetch({
      url: 'https://itsm.example.com/api',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"query":1}',
    })

    expect(result.status).toBe(201)
    expect(result.body).toBe('{"ok":true}')
    expect(fetch).toHaveBeenCalledWith('https://itsm.example.com/api', expect.objectContaining({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"query":1}',
      redirect: 'follow',
      signal: expect.any(AbortSignal),
    }))
  })

  it('keeps a direct API request on its original URL when redirects are disallowed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', {
      status: 302,
      headers: { location: 'https://example.org/redirected' },
    })))
    const result = await handleBackendRuntimeFetch({
      url: 'https://example.com/api',
      options: { method: 'POST', redirect: 'manual', body: '{}' },
    })
    expect(result.status).toBe(302)
    expect(fetch).toHaveBeenCalledWith('https://example.com/api', expect.objectContaining({ redirect: 'manual' }))
  })

  it('omits direct API query and response bodies from trace output when requested', async () => {
    const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"result":"private fixture"}', { status: 200 })))
    await handleBackendRuntimeFetch({
      url: 'https://example.com/api',
      redactBodyInTrace: true,
      options: { method: 'POST', body: '{"query":"private fixture"}' },
    }, 'fixture-trace')
    const trace = output.mock.calls.map(([chunk]) => String(chunk)).join('')
    expect(trace).toContain('[redacted]')
    expect(trace).not.toContain('private fixture')
  })

  it('sends base64 backend fetch bodies as binary buffers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })))

    const result = await handleBackendRuntimeFetch({
      url: 'https://itsm.example.com/upload',
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from('abc').toString('base64'),
      bodyEncoding: 'base64',
    })

    expect(result.status).toBe(200)
    const init = fetch.mock.calls[0][1]
    expect(Buffer.isBuffer(init.body)).toBe(true)
    expect(init.body.toString('utf8')).toBe('abc')
  })

  it('rejects non-http backend fetch URLs', async () => {
    await expect(handleBackendRuntimeFetch({ url: 'file:///C:/secret.txt' }))
      .rejects.toThrow('Only http:// and https:// URLs are allowed')
  })

  it('reads local files as text or base64', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecli-runtime-'))
    tempDirs.push(dir)
    const filePath = path.join(dir, 'input.txt')
    fs.writeFileSync(filePath, 'hello', 'utf8')

    await expect(handleBackendRuntimeFileRead({ path: filePath, encoding: 'utf8' }))
      .resolves.toEqual({ path: filePath, encoding: 'utf8', content: 'hello', size: 5 })
    await expect(handleBackendRuntimeFileRead({ path: filePath, encoding: 'base64' }))
      .resolves.toEqual({ path: filePath, encoding: 'base64', content: 'aGVsbG8=', size: 5 })
    await expect(handleBackendRuntimeFileRead({ path: filePath, encoding: 'base64', hash: 'md5' }))
      .resolves.toEqual({
        path: filePath,
        encoding: 'base64',
        content: 'aGVsbG8=',
        size: 5,
        md5: '5d41402abc4b2a76b9719d911017c592',
      })
  })

  it('writes local files and rejects missing paths', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecli-runtime-'))
    tempDirs.push(dir)
    const filePath = path.join(dir, 'nested', 'output.txt')

    await expect(handleBackendRuntimeFileWrite({
      path: filePath,
      content: 'hello',
      encoding: 'utf8',
    })).resolves.toEqual({ path: filePath, size: 5 })
    expect(fs.readFileSync(filePath, 'utf8')).toBe('hello')

    await expect(handleBackendRuntimeFileWrite({ path: '', content: 'x' }))
      .rejects.toThrow('path is required')
  })

  it('reads the first xlsx worksheet as a two-dimensional row array', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecli-runtime-'))
    tempDirs.push(dir)
    const filePath = path.join(dir, 'input.xlsx')
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ['fieldA', 'fieldB'],
      ['labelA', 'labelB'],
      ['valueA', 2],
    ]), 'Import')
    XLSX.writeFile(workbook, filePath)

    const result = await handleBackendRuntimeXlsxRead({ path: filePath })
    expect(result.path).toBe(filePath)
    expect(result.sheetName).toBe('Import')
    expect(result.rows).toEqual([
      ['fieldA', 'fieldB'],
      ['labelA', 'labelB'],
      ['valueA', '2'],
    ])
    expect(result.size).toBeGreaterThan(0)
  })
})
