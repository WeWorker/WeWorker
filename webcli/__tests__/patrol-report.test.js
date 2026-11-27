import { describe, expect, it } from 'vitest'
import { buildReport, formatTextReport } from '../patrol/report.js'

const rows = [
  { adapterId: 'a.com', tool: 'a.com.ok', verdict: 'pass', kind: null },
  { adapterId: 'a.com', tool: 'a.com.bad', verdict: 'failed', kind: 'site_changed', details: { missing: [{ path: 'x', baselineType: 'string' }] } },
  { adapterId: 'b.com', tool: 'b.com.x', verdict: 'uncovered', kind: 'login_required', details: { reason: 'login_required' } },
  { adapterId: 'c.com', tool: 'c.com.y', verdict: 'uncovered', kind: 'needs-sample', details: { reason: 'needs-sample' } },
]

describe('buildReport', () => {
  const report = buildReport({ runId: 'r1', startedAt: 's', finishedAt: 'f', rows, siteCount: 3, loginHealth: [] })

  it('覆盖率是头号指标', () => {
    expect(report.coverage).toMatchObject({ tools: '2/4' })
  })

  it('未覆盖单独成块并带原因', () => {
    expect(report.uncovered).toHaveLength(2)
    expect(report.uncovered.map((u) => u.reason).sort()).toEqual(['login_required', 'needs-sample'])
  })

  it('site_changed 进需重新取证清单', () => {
    expect(report.reEvidence).toHaveLength(1)
    expect(report.reEvidence[0].tool).toBe('a.com.bad')
  })

  it('内容退化不进清单（除非连续两次）', () => {
    const r = buildReport({ runId: 'r', rows: [{ adapterId: 'a.com', tool: 't', verdict: 'failed', kind: 'content_degraded', details: { emptied: ['items'] } }], previousReport: null })
    expect(r.reEvidence).toHaveLength(0)
    expect(r.results.find((x) => x.tool === 't').escalated).toBe(false)
  })

  it('内容退化连续两次才升级进清单', () => {
    const r = buildReport({
      runId: 'r',
      rows: [{ adapterId: 'a.com', tool: 't', verdict: 'failed', kind: 'content_degraded', details: { emptied: ['items'] } }],
      previousReport: { results: [{ tool: 't', kind: 'content_degraded' }] },
    })
    expect(r.reEvidence).toHaveLength(1)
  })
})

describe('formatTextReport', () => {
  it('文本报告把覆盖率放在最前', () => {
    const text = formatTextReport(buildReport({ runId: 'r1', rows, siteCount: 3 }))
    expect(text.split('\n')[0]).toContain('覆盖')
  })

  it('列出未覆盖原因与需重新取证', () => {
    const text = formatTextReport(buildReport({ runId: 'r1', rows, siteCount: 3 }))
    expect(text).toContain('未覆盖')
    expect(text).toContain('需重新取证')
  })
})
