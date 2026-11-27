import { describe, expect, it } from 'vitest'
import { buildPatrolEnv, runWithConcurrency, summarizeProbe } from '../patrol/probe.js'

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
