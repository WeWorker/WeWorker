import { describe, it, expect } from 'vitest'
import { adapterIdOfTool, tasksFromErrDetail, fetchErrDetail } from '../repair/task-source.js'

const ERRDETAIL = {
  rows: [
    { err: 'Toolkit Adapter exited with code 1', tools: [
      { tool: 'wekm.get-article', calls: 27 }, { tool: 'wekm.list-articles', calls: 19 }, { tool: 'wekm.probe-charset', calls: 3 } ] },
    { err: 'Toolkit Adapter exited with code 1', tools: [ { tool: 'lowpkg.one', calls: 2 } ] },
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
    expect(tasks).toHaveLength(1)
    expect(tasks[0].adapterId).toBe('wekm')
    expect(tasks[0].source).toBe('errdetail')
    expect(tasks[0].failures.map((f) => f.tool)).toEqual(['wekm.get-article', 'wekm.list-articles', 'wekm.probe-charset'])
    expect(tasks[0].failures[0].count).toBe(27)
    expect(tasks[0].failures[0].lastErr).toContain('exited with code 1')
  })
})

describe('fetchErrDetail', () => {
  it('缺 token 抛错;带 Bearer 请求正确 URL 并返回 JSON', async () => {
    await expect(fetchErrDetail({ token: null })).rejects.toThrow(/METRICS_STATS_TOKEN/)
    let called = null
    const fetchImpl = async (url, opts) => {
      called = { url, opts }
      return { ok: true, json: async () => ({ rows: [] }) }
    }
    const data = await fetchErrDetail({ token: 't', since: '7d', fetchImpl })
    expect(called.url).toBe('http://weworker.weoa.com/v1/stats?by=errdetail&kind=adapter&since=7d')
    expect(called.opts.headers.authorization).toBe('Bearer t')
    expect(data).toEqual({ rows: [] })
  })
})
