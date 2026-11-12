import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { Writable } from 'node:stream'
import { writeStdout, writeStdoutThenExit } from '../stdout-flush.js'

/** 记录写入顺序的假 stdout：`flush()` 模拟「数据真正落进管道」。 */
function recordingStream() {
  const events = []
  let pending = null
  const stream = new Writable({
    write(chunk, _enc, callback) {
      events.push({ type: 'chunk', text: chunk.toString() })
      pending = callback
    },
  })
  return {
    stream,
    events,
    /** 完成当前这次写入（等价于管道收下了这段数据） */
    flush() {
      const callback = pending
      pending = null
      callback?.()
    },
    get hasPending() {
      return pending !== null
    },
  }
}

describe('writeStdout', () => {
  it('writes the text with a trailing newline and resolves after the flush callback', async () => {
    const sink = recordingStream()
    let resolved = false
    const done = writeStdout('{"ok":true}', sink.stream).then(() => {
      resolved = true
    })
    await Promise.resolve()
    expect(sink.events).toEqual([{ type: 'chunk', text: '{"ok":true}\n' }])
    expect(resolved).toBe(false)
    sink.flush()
    await done
    expect(resolved).toBe(true)
  })

  it('resolves immediately for empty text', async () => {
    const sink = recordingStream()
    await writeStdout('', sink.stream)
    expect(sink.events).toEqual([])
  })
})

describe('writeStdoutThenExit', () => {
  it('exits only after the stdout write finished (the macOS truncation guard)', async () => {
    const sink = recordingStream()
    const exitCalls = []
    const done = writeStdoutThenExit('x'.repeat(4096), 0, {
      stream: sink.stream,
      exit: (code) => exitCalls.push(code),
    })
    await Promise.resolve()
    // 写入还没落盘时绝不能退出：先退出就是「大结果被截断」的那条路径。
    expect(exitCalls).toEqual([])
    sink.flush()
    await done
    expect(exitCalls).toEqual([0])
  })

  it('still exits with the requested code when the pipe is already closed', async () => {
    const failing = new Writable({
      write(_chunk, _enc, callback) {
        callback(new Error('EPIPE'))
      },
    })
    // 写失败同样会以 'error' 事件出现；真实进程里那条路径靠 stderr 记一笔，这里只需吞掉。
    failing.on('error', () => {})
    const exitCalls = []
    const errors = []
    await writeStdoutThenExit('payload', 1, {
      stream: failing,
      exit: (code) => exitCalls.push(code),
      onError: (error) => errors.push(error),
    })
    expect(exitCalls).toEqual([1])
    expect(errors).toHaveLength(1)
  })

  it('gives up and exits when the reader never drains the pipe', async () => {
    const sink = recordingStream()
    const exitCalls = []
    await writeStdoutThenExit('payload', 0, {
      stream: sink.stream,
      exit: (code) => exitCalls.push(code),
      flushTimeoutMs: 10,
    })
    // 永不回调的写入不能把 CLI 挂住：兜底时限到了照样退出。
    expect(exitCalls).toEqual([0])
  })
})

describe('piped stdout is not truncated', () => {
  it('delivers a payload larger than any pipe buffer in full', () => {
    // 真实子进程回归：大 JSON 走管道输出必须一字不少。修复前这里是
    // `console.log(...); process.exit(0)`，macOS/Linux 上超过管道缓冲区就会被截断
    // （Windows 的管道写是同步的，所以同一份代码只在那两个平台上暴露问题）。
    const moduleUrl = new URL('../stdout-flush.js', import.meta.url).href
    const payload = 'x'.repeat(256 * 1024)
    const script = [
      `import { writeStdoutThenExit } from ${JSON.stringify(moduleUrl)}`,
      `await writeStdoutThenExit('x'.repeat(${payload.length}), 0)`,
    ].join('\n')
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
    expect(stdout.length).toBe(payload.length + 1)
    expect(stdout.endsWith('\n')).toBe(true)
  })
})
