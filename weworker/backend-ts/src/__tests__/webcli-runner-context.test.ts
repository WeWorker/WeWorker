import { promisify } from 'node:util'
import { describe, expect, it, vi, beforeEach } from 'vitest'

const execFileImpl = vi.hoisted(() => vi.fn())
// 复刻真实 child_process.execFile 的 custom promisify 合同（resolve {stdout, stderr}，
// reject 时错误对象携带部分输出）；否则 promisify 只解析第一个回调值，stderr 会丢失。
const execFile = Object.assign((...args: unknown[]) => execFileImpl(...args), {
  [promisify.custom]: (file: string, args: string[], opts: unknown) => new Promise((resolve, reject) => {
    execFileImpl(file, args, opts, (error: (Error & { stdout?: string; stderr?: string }) | null, stdout: string, stderr: string) => {
      if (error) { error.stdout = stdout ?? error.stdout; error.stderr = stderr ?? error.stderr; reject(error) } else resolve({ stdout, stderr })
    })
  }),
})
vi.mock('node:child_process', () => ({ execFile }))
vi.mock('../webcli-path.js', () => ({ resolveWebcliEntry: () => 'webcli-entry.js' }))
vi.mock('../config.js', () => ({ getOpenBrowserAllowedOrigins: () => [] }))
vi.mock('../webcli-result-cache.js', () => ({ offloadIfLarge: vi.fn(() => null) }))

async function runEx(stdout: string, stderr: string, options: {
  argsJson?: string
  context?: { newContext?: boolean; contextId?: string; decisionId?: string; stepId?: string }
} = {}) {
  execFileImpl.mockImplementationOnce((_file: string, _args: string[], opts: Record<string, unknown>, cb: (err: unknown, out: string, errOut: string) => void) => {
    cb(null, stdout, stderr)
    void opts
  })
  const { runWebcliCallEx } = await import('../webcli-runner.js')
  return runWebcliCallEx('example.com.list', options.argsJson, 'work', { timeoutMs: 3_000, context: options.context })
}

function lastSpawn(): { args: string[]; opts: Record<string, unknown> } {
  const call = execFileImpl.mock.calls.at(-1)!
  return { args: call[1] as string[], opts: call[2] as Record<string, unknown> }
}

const receiptLine = (receipt: Record<string, unknown>): string => `WEBCLI_CONTEXT ${JSON.stringify(receipt)}\n`

describe('runWebcliCallEx context flags and receipt split', () => {
  beforeEach(() => {
    execFileImpl.mockReset()
  })

  it('passes --new-context and keeps business stdout separate from the receipt on stderr', async () => {
    const onReceipt = vi.fn()
    execFileImpl.mockImplementationOnce((_f: string, _a: string[], _o: unknown, cb: (e: null, o: string, e2: string) => void) =>
      cb(null, '{"rows":[]}', receiptLine({ contextId: 'ctx-1', toolOutcome: 'read_success' })))
    const { runWebcliCallEx } = await import('../webcli-runner.js')
    const output = await runWebcliCallEx('example.com.list', '{"count":2}', 'work',
      { timeoutMs: 3_000, context: { newContext: true }, onReceipt })
    expect(JSON.parse(output)).toEqual({ rows: [] })
    expect(onReceipt).toHaveBeenCalledWith(expect.objectContaining({ contextId: 'ctx-1', toolOutcome: 'read_success' }))
    const { args, opts } = lastSpawn()
    expect(args).toEqual(['webcli-entry.js', 'call', 'example.com.list', '--output-format=json', '--new-context', '--args', '{"count":2}'])
    expect(opts.timeout).toBe(3_000)
  })

  it('passes --context with decision/step association', async () => {
    await runEx('{}', '', { argsJson: '{}', context: { contextId: 'ctx-9', decisionId: 'd1', stepId: 's1' } })
    const { args } = lastSpawn()
    expect(args).toEqual(['webcli-entry.js', 'call', 'example.com.list', '--output-format=json',
      '--context', 'ctx-9', '--context-decision', 'd1', '--context-step', 's1', '--args', '{}'])
  })

  it('omits context flags entirely when no control is given (legacy parity)', async () => {
    await runEx('{}', '', { argsJson: '{}' })
    const { args } = lastSpawn()
    expect(args).toEqual(['webcli-entry.js', 'call', 'example.com.list', '--output-format=json', '--args', '{}'])
  })

  it('never surfaces the receipt as business output when stdout is empty', async () => {
    const onReceipt = vi.fn()
    const { runWebcliCallEx } = await import('../webcli-runner.js')
    execFileImpl.mockImplementationOnce((_f: string, _a: string[], _o: unknown, cb: (e: null, o: string, e2: string) => void) =>
      cb(null, '', receiptLine({ contextId: 'ctx-2', toolOutcome: 'failed' })))
    await expect(runWebcliCallEx('example.com.list', undefined, 'work', { context: { newContext: true }, onReceipt })).rejects.toThrow('produced no output')
    expect(onReceipt).toHaveBeenCalledWith(expect.objectContaining({ toolOutcome: 'failed' }))
  })

  it('captures business stdout from a non-zero exit (CLI contract keeps output on stdout)', async () => {
    const { runWebcliCallEx } = await import('../webcli-runner.js')
    execFileImpl.mockImplementationOnce((_f: string, _a: string[], _o: unknown, cb: (e: { code: number; stdout: string; stderr: string }) => void) =>
      cb({ code: 1, stdout: '{"error":"Fixture failure"}', stderr: receiptLine({ contextId: 'ctx-3', toolOutcome: 'failed' }) }))
    const output = await runWebcliCallEx('example.com.detail', '{"key":"error"}', 'work', { context: { newContext: true } })
    expect(JSON.parse(output)).toEqual({ error: 'Fixture failure' })
  })

  it('throws WebcliTimeoutError on SIGTERM kill', async () => {
    const { runWebcliCallEx, WebcliTimeoutError } = await import('../webcli-runner.js')
    execFileImpl.mockImplementationOnce((_f: string, _a: string[], opts: { timeout?: number }, cb: (e: { killed: boolean; signal: string }) => void) => {
      void opts
      cb({ killed: true, signal: 'SIGTERM' })
    })
    await expect(runWebcliCallEx('example.com.list', undefined, 'work', { timeoutMs: 3_000, context: { newContext: true } }))
      .rejects.toBeInstanceOf(WebcliTimeoutError)
  })

  it('keeps legacy runWebcliCall behavior (merged stdout/stderr, no context flags)', async () => {
    const { runWebcliCall } = await import('../webcli-runner.js')
    execFileImpl.mockImplementationOnce((_f: string, _a: string[], _o: unknown, cb: (e: null, o: string, e2: string) => void) =>
      cb(null, '{"rows":[1]}', 'some warning'))
    const output = await runWebcliCall('example.com.list', '{"count":1}', 'work', { timeoutMs: 3_000 })
    expect(JSON.parse(output)).toEqual({ rows: [1] })
    const { args } = lastSpawn()
    expect(args.join(' ')).not.toContain('--context')
  })

  it('parseWebcliContextReceipt ignores malformed lines', async () => {
    const { parseWebcliContextReceipt } = await import('../webcli-runner.js')
    expect(parseWebcliContextReceipt('WEBCLI_CONTEXT not-json\n')).toBeNull()
    expect(parseWebcliContextReceipt('nothing here\n')).toBeNull()
    expect(parseWebcliContextReceipt(receiptLine({ contextId: 'ctx' }))).toEqual({ contextId: 'ctx' })
  })
})
