import { describe, expect, it } from 'vitest'
import { classifyConnectivity, evaluateTool } from '../patrol/classify.js'

const ok = { ok: true }
const shapeOk = { missing: [], typeChanged: [], added: [], emptied: [], degraded: false }

describe('classifyConnectivity', () => {
  it('退出码 0 即连通', () => {
    expect(classifyConnectivity({ exitCode: 0, stdout: '{}', stderr: '' })).toEqual({ ok: true })
  })

  it('超时优先判定', () => {
    expect(classifyConnectivity({ exitCode: 1, stdout: '', stderr: '', timedOut: true }).reason).toBe('timeout')
  })

  it('登录特征', () => {
    expect(classifyConnectivity({ exitCode: 1, stdout: '', stderr: 'Error: 未登录' }).reason).toBe('login_required')
  })

  it('权限特征', () => {
    expect(classifyConnectivity({ exitCode: 1, stdout: '', stderr: 'no permission' }).reason).toBe('permission_denied')
  })

  it('其它非零退出码归 error', () => {
    expect(classifyConnectivity({ exitCode: 2, stdout: '', stderr: 'boom' }).reason).toBe('error')
  })
})

describe('evaluateTool', () => {
  it('连通失败即止，不判结构内容', () => {
    const r = evaluateTool({
      connectivity: { ok: false, reason: 'login_required' },
      shapeDiff: { ...shapeOk, degraded: true },
      emptiedPaths: [],
    })
    expect(r.verdict).toBe('failed')
    expect(r.kind).toBe('login_required')
    expect(r.details.reason).toBe('login_required')
  })

  it('结构退化归 site_changed，并带上字段明细', () => {
    const r = evaluateTool({
      connectivity: ok,
      shapeDiff: { missing: [{ path: 'a', baselineType: 'string' }], typeChanged: [], added: [], emptied: [], degraded: true },
      emptiedPaths: [],
    })
    expect(r.kind).toBe('site_changed')
    expect(r.details.missing).toHaveLength(1)
  })

  it('数组变空归 content_degraded', () => {
    const r = evaluateTool({ connectivity: ok, shapeDiff: shapeOk, emptiedPaths: ['items'] })
    expect(r.verdict).toBe('failed')
    expect(r.kind).toBe('content_degraded')
    expect(r.details.emptied).toEqual(['items'])
  })

  it('新增字段只记录，不判失败', () => {
    const r = evaluateTool({ connectivity: ok, shapeDiff: { ...shapeOk, added: ['x'] }, emptiedPaths: [] })
    expect(r.verdict).toBe('pass')
    expect(r.details.added).toEqual(['x'])
  })

  it('无基线时只判连通', () => {
    const r = evaluateTool({ connectivity: ok, shapeDiff: null, emptiedPaths: [] })
    expect(r.verdict).toBe('pass')
    expect(r.details.needsBaseline).toBe(true)
  })
})
