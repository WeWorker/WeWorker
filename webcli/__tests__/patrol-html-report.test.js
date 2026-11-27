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
    expect(empty).not.toContain('<details')
  })
})

describe('renderHtmlReport:站点健康度按 details/summary 折叠', () => {
  // REPORT:a.com 有 pass+failed(应默认展开、排在前),b.com 全未覆盖(应默认收起)
  const html = renderHtmlReport(REPORT)

  const summaries = () => html.match(/<summary>[\s\S]*?<\/summary>/g) ?? []
  const summaryOf = (siteId) => summaries().find((s) => s.includes(siteId))

  it('分组用原生 details/summary(零 JS,无脚本标签)', () => {
    expect(html).toContain('<details')
    expect(html).toContain('<summary>')
    expect(html).not.toContain('<script')
  })
  it('有失败的站默认 open,全绿/全未覆盖站收起', () => {
    expect(html).toContain('<details class="site-group" open>') // a.com(有 failed)
    expect(html).toContain('<details class="site-group">') // b.com(全未覆盖)
  })
  it('站点排序:有失败的在前,其余按 adapterId', () => {
    expect(html.indexOf('<details class="site-group" open>')).toBeLessThan(html.indexOf('<details class="site-group">'))
  })
  it('summary 一行含站点 id 与三色小计(色点+数字)', () => {
    const a = summaryOf('a.com')
    const b = summaryOf('b.com')
    expect(a).toContain('通过 1')
    expect(a).toContain('失败 1')
    expect(a).toContain('未覆盖 0')
    expect(a).toMatch(/class="dot"/) // 三色小计带色点
    expect(b).toContain('通过 0')
    expect(b).toContain('失败 0')
    expect(b).toContain('未覆盖 1')
  })
  it('组内明细表移入 details 体,summary 不含长表格', () => {
    const detailsBlocks = html.match(/<details class="site-group"[\s\S]*?<\/details>/g) ?? []
    const aBlock = detailsBlocks.find((b) => b.includes('a.com'))
    expect(aBlock).toContain('a.ok') // 明细行在 details 体里
    const a = summaryOf('a.com')
    expect(a).not.toContain('<table') // summary 保持一行
  })
  it('失败明细总表(独立节)不受折叠影响', () => {
    expect(html).toContain('失败明细')
    expect(html).toContain('a.bad&lt;script&gt;')
  })
})
