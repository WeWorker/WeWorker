import { describe, expect, it } from 'vitest'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPatrolEnv, probeTool, runWithConcurrency, summarizeProbe } from '../patrol/probe.js'

describe('buildPatrolEnv', () => {
  it('强制 WEBCLI_METRICS=off / WEBCLI_METRICS_UPLOAD=off 并移除 ENDPOINT，避免污染本机统计', () => {
    const env = buildPatrolEnv({ PATH: '/x', WEBCLI_METRICS_ENDPOINT: 'http://y' })
    expect(env.WEBCLI_METRICS).toBe('off')
    expect(env.WEBCLI_METRICS_UPLOAD).toBe('off')
    expect(env.WEBCLI_METRICS_ENDPOINT).toBeUndefined()
    expect(env.PATH).toBe('/x')
  })
})

describe('runWithConcurrency', () => {
  it('保持顺序且并发不超限', async () => {
    let peak = 0
    let inFlight = 0
    const seen = []
    const out = await runWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      seen.push(n)
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
      return n * 2
    })
    expect(out).toEqual([2, 4, 6, 8, 10])
    expect(peak).toBeLessThanOrEqual(2)
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5])
  })
})

describe('summarizeProbe', () => {
  it('解析 stdout 里的 JSON，失败则 parsed 为 null', () => {
    expect(summarizeProbe({ exitCode: 0, stdout: '{"a":1}', stderr: '', timedOut: false }).parsed).toEqual({ a: 1 })
    expect(summarizeProbe({ exitCode: 0, stdout: 'not json', stderr: '', timedOut: false }).parsed).toBeNull()
  })

  it('剥掉服务启动 banner 行后再解析', () => {
    const out = 'Bridge not running, starting...\n{"ok":true}\n'
    expect(summarizeProbe({ exitCode: 0, stdout: out, stderr: '', timedOut: false }).parsed).toEqual({ ok: true })
  })
})

describe('probeTool 多字节安全', () => {
  it('中文 JSON 在管道块边界撕裂后仍能完整解码（stdout 按 utf8 解码拼接）', async () => {
    const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'patrol-tear-fixture.js')
    const raw = await probeTool({ tool: 'tear-fixture' }, { env: buildPatrolEnv(), timeoutMs: 10_000, cliEntry: fixture })
    expect(summarizeProbe(raw).parsed).toEqual({ ok: true, items: ['京东超市搜索结果第一页', '自营旗舰店'] })
  })
})

describe('probeTool stderrTail 留存', () => {
  const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'patrol-stderr-fixture.js')
  const run = (tool) => probeTool({ tool }, { env: buildPatrolEnv(), timeoutMs: 10_000, cliEntry: fixture })

  it('非零退出时返回 stderr 尾部,携带真实错误文本;summarizeProbe 透传', async () => {
    const raw = await run('stderr-boom')
    expect(raw.exitCode).toBe(1)
    expect(raw.stderrTail).toContain('boom: real cause')
    expect(summarizeProbe(raw).stderrTail).toContain('boom: real cause')
  })

  it('stderr 超长时环形丢弃旧行,只留尾部 ~800 字节', async () => {
    const raw = await run('stderr-flood')
    expect(raw.exitCode).toBe(1)
    expect(raw.stderrTail.length).toBeLessThanOrEqual(800)
    expect(raw.stderrTail).toContain('TAIL_MARKER')
    expect(raw.stderrTail).not.toContain('HEAD_MARKER')
  })

  it('成功且无 stderr 时 stderrTail 为空字符串', async () => {
    const raw = await run('stderr-ok')
    expect(raw.exitCode).toBe(0)
    expect(raw.stderrTail).toBe('')
  })
})

