// Feature: adapter-metrics, 实时上报 + 远程聚合
// 覆盖 metrics.js（classifyTool / sanitizeErr / buildRecord / whoami / buildUploadConfig）与 stats.js（aggregate / parseDuration / percentile）

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { classifyTool, sanitizeErr, buildRecord, whoami, buildUploadConfig } from '../metrics.js'
import { aggregate, parseDuration, percentile, renderRouteTable } from '../stats.js'

describe('classifyTool', () => {
  it('adapter 工具按最后一个点切出 domain', () => {
    expect(classifyTool('itsm.example.com.search_tickets')).toEqual({
      domain: 'itsm.example.com',
      kind: 'adapter',
    })
  })
  it('builtin 工具无点，domain 填工具名', () => {
    expect(classifyTool('open_browser')).toEqual({ domain: 'open_browser', kind: 'builtin' })
  })
})

describe('sanitizeErr', () => {
  it('只取首行并截断到 200 字符', () => {
    const out = sanitizeErr('line1\nline2')
    expect(out).toBe('line1')
    expect(sanitizeErr('x'.repeat(500)).length).toBe(200)
  })
  it('抹掉 URL query / token / 邮箱 / 长数字串', () => {
    const out = sanitizeErr('fail https://x/y?token=abc secret=zzz user user@example.com 13800001111')
    expect(out).not.toContain('token=abc')
    expect(out).not.toContain('zzz')
    expect(out).not.toContain('user@example.com')
    expect(out).not.toContain('13800001111')
  })
  it('null 返回 null', () => {
    expect(sanitizeErr(null)).toBe(null)
  })
})

describe('buildRecord', () => {
  it('Error 对象的 message 被脱敏', () => {
    const r = buildRecord('mail.163.com.get', false, 640, 't1', new Error('boom user@example.com'))
    expect(r.ok).toBe(false)
    expect(r.domain).toBe('mail.163.com')
    expect(r.kind).toBe('adapter')
    expect(r.err).not.toContain('user@example.com')
    expect(r.traceID).toBe('t1')
  })
})

describe('parseDuration', () => {
  it('解析 d/h/m', () => {
    expect(parseDuration('7d')).toBe(7 * 86400000)
    expect(parseDuration('12h')).toBe(12 * 3600000)
    expect(parseDuration('30m')).toBe(30 * 60000)
  })
  it('非法输入默认 30 天', () => {
    expect(parseDuration('bad')).toBe(30 * 86400000)
  })
})

describe('percentile', () => {
  it('空数组返回 0', () => expect(percentile([], 50)).toBe(0))
  it('p50 / p95', () => {
    const arr = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(percentile(arr, 50)).toBe(50)
    expect(percentile(arr, 95)).toBe(95)
  })
})

describe('aggregate', () => {
  const recs = [
    { ts: 1, tool: 'itsm.example.com.search', domain: 'itsm.example.com', kind: 'adapter', ok: true, ms: 100 },
    { ts: 2, tool: 'itsm.example.com.search', domain: 'itsm.example.com', kind: 'adapter', ok: false, ms: 300 },
    { ts: 3, tool: 'open_browser', domain: 'open_browser', kind: 'builtin', ok: true, ms: 50 },
  ]
  it('按 domain 聚合：calls / okRate / topTool', () => {
    const rows = aggregate(recs, { by: 'domain' })
    const itsm = rows.find((r) => r.key === 'itsm.example.com')
    expect(itsm.calls).toBe(2)
    expect(itsm.okRate).toBe(50)
    expect(itsm.topTool).toBe('itsm.example.com.search')
    expect(itsm.topToolCalls).toBe(2)
  })
  it('kind 过滤 adapter 排除 builtin', () => {
    const rows = aggregate(recs, { by: 'domain', kind: 'adapter' })
    expect(rows.length).toBe(1)
    expect(rows[0].key).toBe('itsm.example.com')
  })
})

describe('whoami', () => {
  it('返回非空字符串（当前系统用户）', () => {
    const u = whoami()
    expect(typeof u === 'string').toBe(true)
    expect(u.length).toBeGreaterThan(0)
  })
  it('不含路径分隔符（DOMAIN\\\\user → user）', () => {
    const u = whoami()
    if (u) expect(u).not.toMatch(/[\\/]/)
  })
})

describe('buildUploadConfig', () => {
  const keys = ['WEBCLI_METRICS', 'WEBCLI_METRICS_UPLOAD', 'WEBCLI_METRICS_ENDPOINT', 'WEBCLI_METRICS_TOKEN']
  let saved = {}
  beforeEach(() => {
    saved = {}
    for (const k of keys) { saved[k] = process.env[k]; delete process.env[k] }
  })
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('默认（无任何 env）→ 仅本地记录，不启用远程上报', async () => {
    const cfg = await buildUploadConfig({ webcliVersion: '1.0.5' })
    expect(cfg.endpoint).toBe(null)
    expect(cfg.token).toBe('')
    expect(cfg.meta.webcliVersion).toBe('1.0.5')
    expect(cfg.meta.os).toBe(process.platform)
  })

  it('env 覆盖内置 endpoint / token', async () => {
    process.env.WEBCLI_METRICS_UPLOAD = 'on'
    process.env.WEBCLI_METRICS_ENDPOINT = 'https://override/v1/metrics/batch'
    process.env.WEBCLI_METRICS_TOKEN = 'override-token'
    const cfg = await buildUploadConfig({ webcliVersion: '1.0.5' })
    expect(cfg.endpoint).toBe('https://override/v1/metrics/batch')
    expect(cfg.token).toBe('override-token')
  })

  it('WEBCLI_METRICS=off → 完全关闭', async () => {
    process.env.WEBCLI_METRICS = 'off'
    const cfg = await buildUploadConfig({ webcliVersion: '1.0.5' })
    expect(cfg.endpoint).toBe(null)
  })

  it('WEBCLI_METRICS_UPLOAD=off → 关闭上报', async () => {
    process.env.WEBCLI_METRICS_UPLOAD = 'off'
    const cfg = await buildUploadConfig({ webcliVersion: '1.0.5' })
    expect(cfg.endpoint).toBe(null)
  })

  it('clientId 持久且 user 由 whoami 取得', async () => {
    const cfg = await buildUploadConfig({ webcliVersion: '1.0.5' })
    expect(typeof cfg.meta.clientId).toBe('string')
    expect(cfg.meta.clientId.length).toBeGreaterThan(0)
    expect(cfg.meta.user).toBe(whoami())
  })
})

describe('renderRouteTable（by=route 视图）', () => {
  it('total 0 → 提示无数据', () => {
    expect(renderRouteTable({ total: 0, hitRate: 0, byKind: [] })).toContain('暂无路由埋点数据')
  })

  it('渲染命中率行 + 分 kind 表（calls/p50/p95）', () => {
    const out = renderRouteTable(
      {
        total: 8,
        hitRate: 50,
        byKind: [
          { kind: 'route_miss', calls: 3, p50: 0, p95: 50 },
          { kind: 'route_hit.override', calls: 2, p50: 200, p95: 400 },
          { kind: 'route_hit.alias', calls: 1, p50: 100, p95: 100 },
          { kind: 'route_hit.llm', calls: 1, p50: 300, p95: 300 },
        ],
      },
      { since: '7d' },
    )
    expect(out).toContain('命中率 50%')
    expect(out).toContain('命中 4/8') // alias(1)+override(2)+llm(1)
    expect(out).toContain('近 7d')
    expect(out).toContain('CALLS')
    expect(out).toContain('p50(ms)')
    expect(out).toContain('route_hit.override')
    expect(out).toContain('route_miss')
  })
})
