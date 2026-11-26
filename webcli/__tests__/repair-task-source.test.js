import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { adapterIdOfTool, tasksFromErrDetail, tasksFromPatrol, fetchErrDetail } from '../repair/task-source.js'

const ERRDETAIL = {
  rows: [
    { err: 'lowpkg boom', tools: [ { tool: 'lowpkg.two', calls: 5 } ] },
    // 脏数据:open_browser 把 URL 记进工具名,派生的 adapterId 含非法字符 → 跳过
    { err: 'Toolkit Adapter exited with code 1', tools: [
      { tool: 'open.https:\\todo.weoa.com/list', calls: 12 }, { tool: 'wekm.list-articles', calls: 19 }, { tool: 'wekm.get-article', calls: 27 }, { tool: 'wekm.probe-charset', calls: 3 } ] },
    { err: 'Toolkit Adapter exited with code 1', tools: [ { tool: 'lowpkg.one', calls: 2 } ] },
  ],
}
// minCalls 边界:lowpkg 总失败数恰好等于阈值
const ERRDETAIL2 = {
  rows: [
    { err: 'lowpkg boom', tools: [ { tool: 'lowpkg.two', calls: 5 } ] },
  ],
}

describe('adapterIdOfTool', () => {
  it('取最后一个点之前;无点返回 null', () => {
    expect(adapterIdOfTool('wekm.get-article')).toBe('wekm')
    expect(adapterIdOfTool('auto-weoa-cnc-portal-tools.check-subsys-process')).toBe('auto-weoa-cnc-portal-tools')
    expect(adapterIdOfTool('open_browser')).toBe(null)
  })
})

describe('tasksFromErrDetail', () => {
  it('按 adapter 聚合、阈值过滤(minCalls=3)、failures 降序', () => {
    const tasks = tasksFromErrDetail(ERRDETAIL, { minCalls: 3, now: Date.parse('2026-11-23T00:00:00Z') })
    // lowpkg 行在 rows 中排最前,tasks[0] 仍是 wekm:鉴别「总失败数降序」排序确实生效
    expect(tasks).toHaveLength(2)
    expect(tasks[0].adapterId).toBe('wekm')
    expect(tasks[0].source).toBe('errdetail')
    expect(tasks[0].failures.map((f) => f.tool)).toEqual(['wekm.get-article', 'wekm.list-articles', 'wekm.probe-charset'])
    expect(tasks[0].failures[0].count).toBe(27)
    expect(tasks[0].failures[0].lastErr).toContain('exited with code 1')
    expect(tasks[1].adapterId).toBe('lowpkg')
  })

  it('minCalls 边界:总失败数恰好等于阈值时通过', () => {
    const tasks = tasksFromErrDetail(ERRDETAIL2, { minCalls: 5, now: Date.parse('2026-11-23T00:00:00Z') })
    expect(tasks).toHaveLength(1)
    expect(tasks[0].adapterId).toBe('lowpkg')
  })

  it('入参异常/rows 为空时返回空数组', () => {
    expect(tasksFromErrDetail(null)).toEqual([])
    expect(tasksFromErrDetail({})).toEqual([])
    expect(tasksFromErrDetail({ rows: [] })).toEqual([])
  })
})

describe('fetchErrDetail', () => {
  it('缺 endpoint 抛错;缺 token 抛错;带 Bearer 请求正确 URL 并返回 JSON', async () => {
    await expect(fetchErrDetail({ registry: null, token: 't' })).rejects.toThrow(/METRICS_STATS_ENDPOINT/)
    await expect(fetchErrDetail({ token: null, registry: 'http://example.test' })).rejects.toThrow(/METRICS_STATS_TOKEN/)
    let called = null
    const fetchImpl = async (url, opts) => {
      called = { url, opts }
      return { ok: true, json: async () => ({ rows: [] }) }
    }
    const data = await fetchErrDetail({ token: 't', since: '7d', registry: 'http://example.test', fetchImpl })
    expect(called.url).toBe('http://example.test/v1/stats?by=errdetail&kind=adapter&since=7d')
    expect(called.opts.headers.authorization).toBe('Bearer t')
    expect(data).toEqual({ rows: [] })
  })
})

describe('tasksFromPatrol', () => {
  const report = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'patrol-report.json'), 'utf8'))
  it('degraded → 任务 failures;needs-regeneration 记入 task.patrol;login-blocked/ok 跳过', () => {
    const tasks = tasksFromPatrol(report, { now: Date.parse('2026-11-26T00:00:00Z') })
    expect(tasks).toHaveLength(2)
    const costplus = tasks.find((t) => t.adapterId === 'costplus.weoa.com')
    expect(costplus.source).toBe('patrol')
    expect(costplus.runtime).toBe('extension')
    expect(costplus.failures.map((f) => f.tool)).toEqual([
      'costplus.weoa.com.list-subsidy-ledgers',
      'costplus.weoa.com.get-document-detail',
    ])
    expect(costplus.failures[0].lastErr).toContain('degraded')
    expect(costplus.failures[1].lastErr).toContain('needs-regeneration')
    expect(costplus.patrol.runId).toBe('patrol-20261126-0800')
    expect(costplus.patrol.needsRegenerationTools).toEqual(['costplus.weoa.com.get-document-detail'])
    const we123 = tasks.find((t) => t.adapterId === 'we123-teamspace')
    expect(we123).toBeUndefined() // 只有 login-blocked/ok → 无 degraded/needs-regen → 不生成任务
  })
  it('空 entries / 非法报告 → 空数组', () => {
    expect(tasksFromPatrol({})).toEqual([])
    expect(tasksFromPatrol(null)).toEqual([])
    expect(tasksFromPatrol({ adapters: [{ adapterId: 'x', entries: [] }] })).toEqual([])
  })
  it('脏 adapterId(URL 形)跳过', () => {
    const dirty = { adapters: [{ adapterId: 'open.https:\\x.com', entries: [{ tool: 'open.https:\\x.com/a', verdict: 'degraded', diff: 'd' }] }] }
    expect(tasksFromPatrol(dirty)).toEqual([])
  })
})
