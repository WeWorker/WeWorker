import { describe, expect, it, vi, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePatrolArgs, mapLoginUncovered, collectBaselineEntries, planBaselineUpdate, patrolStateDir, writeHtmlReport } from '../patrol/index.js'
import { BASELINE_VERSION } from '../patrol/baseline.js'
import { extractShape } from '../patrol/shape.js'

describe('parsePatrolArgs', () => {
  it('解析常用参数', () => {
    expect(parsePatrolArgs(['--concurrency', '8', '--only', 'a.com', '--json'])).toMatchObject({ concurrency: 8, only: 'a.com', json: true })
  })

  it('默认并发 4', () => {
    expect(parsePatrolArgs([]).concurrency).toBe(4)
  })

  it('识别 --update-baseline', () => {
    expect(parsePatrolArgs(['--update-baseline']).updateBaseline).toBe(true)
  })

  it('识别 --html(生成自包含 HTML 报告,默认关闭)', () => {
    expect(parsePatrolArgs(['--html']).html).toBe(true)
    expect(parsePatrolArgs([]).html).toBe(false)
  })

  it('--timeout 以秒为单位换算', () => {
    expect(parsePatrolArgs(['--timeout', '30']).timeoutMs).toBe(30_000)
  })

  it('--only 缺值记用法错误（而不是误入全量巡检）', () => {
    const missing = parsePatrolArgs(['--only'])
    expect(missing.usageError).toBeTruthy()
    expect(missing.only).toBeNull()
    // 值是另一个 flag 时同样视为缺值——adapterId 永不以 -- 开头
    expect(parsePatrolArgs(['--only', '--json']).usageError).toBeTruthy()
    expect(parsePatrolArgs(['--json', '--only', 'a.com']).usageError).toBeNull()
  })
})

describe('mapLoginUncovered', () => {
  const row = (over = {}) => ({ adapterId: 'a.com', tool: 'a.x', verdict: 'failed', kind: 'login_required', details: { reason: 'login_required', durationMs: 5, baselineMissing: true }, parsed: null, sampleSource: null, ...over })

  it('login_required 失败映射为未覆盖（spec 验收 5:登录态失效整站转未覆盖,不算失败）', () => {
    const mapped = mapLoginUncovered(row())
    expect(mapped.verdict).toBe('uncovered')
    expect(mapped.kind).toBe('login_required')
    expect(mapped.details.reason).toBe('login_required')
    expect(mapped.details.durationMs).toBe(5)
  })

  it('permission_denied / timeout / error 维持 failed（spec 只豁免登录态）', () => {
    for (const kind of ['permission_denied', 'timeout', 'error']) {
      expect(mapLoginUncovered(row({ kind, details: { reason: kind } })).verdict).toBe('failed')
    }
  })

  it('pass 与未覆盖行原样返回', () => {
    const passing = { adapterId: 'a.com', tool: 'a.y', verdict: 'pass', kind: null, details: { added: [] } }
    expect(mapLoginUncovered(passing)).toBe(passing)
    const uncovered = row({ verdict: 'uncovered', kind: 'needs-sample', details: { reason: 'needs-sample' } })
    expect(mapLoginUncovered(uncovered)).toBe(uncovered)
  })
})

describe('patrolStateDir', () => {
  it('落盘在用户级 ~/.webcli/patrol（巡检产物不入仓），home 可注入', () => {
    expect(patrolStateDir()).toBe(join(homedir(), '.webcli', 'patrol'))
    expect(patrolStateDir({ home: '/tmp/x' })).toBe(join('/tmp/x', '.webcli', 'patrol'))
  })
})

describe('writeHtmlReport', () => {
  afterEach(() => vi.restoreAllMocks())

  it('--json --html 同用:HTML 提示走 stderr,stdout 保持纯 JSON 可解析', () => {
    const home = mkdtempSync(join(tmpdir(), 'patrol-html-'))
    const report = { runId: 'patrol-cli-html', coverage: { sites: '0/0', tools: '0/0' }, passed: 0, failed: 0, uncovered: [], results: [], reEvidence: [], newlyFailed: [], recovered: [], loginHealth: [] }
    // main 在 --json 模式下先往 stdout 打报告行;spy 模拟之后的输出走向
    const stdout = [JSON.stringify(report, null, 2)]
    const stderr = []
    vi.spyOn(console, 'log').mockImplementation((msg) => stdout.push(String(msg)))
    vi.spyOn(console, 'error').mockImplementation((msg) => stderr.push(String(msg)))
    try {
      const filePath = writeHtmlReport(report, { home })
      expect(filePath).toBe(join(home, '.webcli', 'patrol', 'reports', `${report.runId}.html`))
      expect(existsSync(filePath)).toBe(true)
      expect(readFileSync(filePath, 'utf8')).toContain('<!doctype html>')
      expect(stderr.join('\n')).toContain('[patrol] HTML 报告:')
      expect(stdout.join('\n')).not.toContain('HTML 报告')
      expect(() => JSON.parse(stdout.join('\n'))).not.toThrow()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('collectBaselineEntries', () => {
  const parsed = { status: 'ok', items: ['x'] }

  it('只收「连通 ok + 有样本 + parsed 非 null」的行，用首跑自建条目', () => {
    const rows = [
      { tool: 'a.ok', verdict: 'pass', kind: null, parsed, sampleSource: 'f#1' },
      { tool: 'a.changed', verdict: 'failed', kind: 'site_changed', parsed, sampleSource: 'f#2' },
      { tool: 'a.uncovered', verdict: 'uncovered', kind: 'needs-sample', parsed: null, sampleSource: null },
      { tool: 'a.connfail', verdict: 'failed', kind: 'error', parsed: null, sampleSource: 'f#3' },
      { tool: 'a.badjson', verdict: 'pass', kind: null, parsed: null, sampleSource: 'f#4' },
    ]
    const entries = collectBaselineEntries(rows, { now: '2026-11-27T00:00:00Z' })
    expect(entries.map((e) => e.tool)).toEqual(['a.ok', 'a.changed'])
    for (const { tool, entry } of entries) {
      expect(entry.source).toBe('first-run')
      expect(entry.shape).toEqual(extractShape(parsed))
      expect(entry.requiredNonEmpty).toEqual(['status', 'items'])
      expect(entry.sampleSource).toBe(`f#${tool === 'a.ok' ? 1 : 2}`)
      expect(entry.updatedAt).toBe('2026-11-27T00:00:00Z')
      expect(entry.updatedBy).toBe('patrol')
    }
  })
})

describe('planBaselineUpdate', () => {
  const oldBaseline = { version: 1, updatedAt: 'old', updatedBy: 'patrol', tools: { keep: { shape: { a: 'string' } }, changed: { shape: { b: 'number' } } } }
  const entries = [
    { tool: 'changed', entry: { source: 'first-run', shape: { b: 'string' }, requiredNonEmpty: [] } },
    { tool: 'added', entry: { source: 'first-run', shape: { c: 'boolean' }, requiredNonEmpty: ['c'] } },
  ]

  it('合并旧基线（未探到的工具保留，不会误报移除）并产出变更预览', () => {
    const { newBaseline, plan } = planBaselineUpdate(oldBaseline, entries)
    expect(plan.added).toEqual(['added'])
    expect(plan.changed).toEqual(['changed'])
    expect(plan.removed).toEqual([])
    expect(newBaseline.version).toBe(BASELINE_VERSION)
    expect(newBaseline.tools.keep).toEqual(oldBaseline.tools.keep) // 未探到的原样保留
    expect(newBaseline.tools.changed).toEqual(entries[0].entry)
    expect(newBaseline.tools.added).toEqual(entries[1].entry)
  })

  it('旧基线为 null 时全部记 added', () => {
    const { plan } = planBaselineUpdate(null, entries)
    expect(plan.added.sort()).toEqual(['added', 'changed'])
    expect(plan.removed).toEqual([])
  })
})
