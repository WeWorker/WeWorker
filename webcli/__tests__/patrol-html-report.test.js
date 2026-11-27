import { describe, it, expect } from 'vitest'
import { escapeHtml, statusMeta, renderHtmlReport } from '../patrol/html-report.js'

const REPORT = {
  runId: 'patrol-1',
  startedAt: '2026-11-27T01:00:00Z', finishedAt: '2026-11-27T01:05:00Z',
  coverage: { sites: '2/3', tools: '5/10' },
  passed: 4, failed: 1, uncovered: [{ adapterId: 'b.com', tool: 'b.x', reason: 'login_required' }],
  results: [
    { adapterId: 'a.com', tool: 'a.ok', verdict: 'pass', kind: null, details: { added: ['x'] }, durationMs: 9000 },
    { adapterId: 'a.com', tool: 'a.bad<script>', verdict: 'failed', kind: 'site_changed', details: { missing: [{ path: 'items', baselineType: 'string' }] }, durationMs: 3000 },
    { adapterId: 'b.com', tool: 'b.x', verdict: 'uncovered', kind: 'login_required', details: { reason: 'login_required' } },
  ],
  reEvidence: [{ adapterId: 'a.com', tool: 'a.bad<script>', reason: 'site_changed', evidence: {} }],
  newlyFailed: ['a.bad<script>'], recovered: [], loginHealth: [],
}

describe('escapeHtml', () => {
  it('转义五个实体', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;')
  })
})

describe('statusMeta', () => {
  it('pass/failed/uncovered 三态色点与标签', () => {
    expect(statusMeta('pass').dot).toBe('#0ca30c')
    expect(statusMeta('failed').dot).toBe('#ec835a')
    expect(statusMeta('uncovered').dot).toBe('#fab219')
    expect(statusMeta('pass').label).toBe('通过')
  })
})

describe('renderHtmlReport', () => {
  const html = renderHtmlReport(REPORT)
  it('自包含单文件骨架', () => {
    expect(html).toContain('<!doctype html>')
    expect(html).not.toMatch(/https?:\/\//) // 零外部依赖
    expect(html).toContain('prefers-color-scheme')
  })
  it('覆盖率与计数进页面', () => {
    expect(html).toContain('2/3')
    expect(html).toContain('5/10')
  })
  it('三类明细齐全:失败/未覆盖/需重新取证', () => {
    expect(html).toContain('需重新取证')
    expect(html).toContain('未覆盖')
  })
  it('动态文本转义(XSS 防护)', () => {
    expect(html).not.toContain('a.bad<script>')
    expect(html).toContain('a.bad&lt;script&gt;')
  })
  it('空态:零结果有文案不是空表', () => {
    const empty = renderHtmlReport({ runId: 'r', coverage: { sites: '0/0', tools: '0/0' }, passed: 0, failed: 0, uncovered: [], results: [], reEvidence: [], newlyFailed: [], recovered: [], loginHealth: [] })
    expect(empty).toContain('无结果')
  })
})
