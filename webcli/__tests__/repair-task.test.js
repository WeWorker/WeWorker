import { describe, it, expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTask, transition, saveTask, loadTask, listTasks, tasksDir, TASK_STATUSES } from '../repair/task.js'

describe('buildTask', () => {
  it('正常构建:id 含日期、status=open、runtime=null', () => {
    const t = buildTask({ source: 'errdetail', adapterId: 'wekm', failures: [{ tool: 'wekm.get-article', count: 27, lastErr: 'exited code 1' }], now: Date.parse('2026-11-23T00:00:00Z') })
    expect(t.id).toBe('rt-2026-11-23-wekm')
    expect(t.status).toBe('open')
    expect(t.runtime).toBe(null)
    expect(t.createdAt).toBe('2026-11-23T00:00:00.000Z')
  })
  it('非法 source / 缺 adapterId / 空 failures 抛错', () => {
    expect(() => buildTask({ source: 'bogus', adapterId: 'x', failures: [{ tool: 't', count: 1 }] })).toThrow(/来源/)
    expect(() => buildTask({ source: 'manual', adapterId: '', failures: [{ tool: 't', count: 1 }] })).toThrow(/adapterId/)
    expect(() => buildTask({ source: 'manual', adapterId: 'x', failures: [] })).toThrow(/failures/)
    expect(() => buildTask({ source: 'manual', adapterId: 'x', failures: [{ tool: 't', count: 0 }] })).toThrow(/count/)
  })
})

describe('transition 状态机', () => {
  it('合法迁移 open→diagnosing→draft-ready→published', () => {
    let t = { status: 'open' }
    t = transition(t, 'diagnosing'); t = transition(t, 'draft-ready'); t = transition(t, 'published')
    expect(t.status).toBe('published')
  })
  it('非法迁移抛错(open→published 禁止;published 终态)', () => {
    expect(() => transition({ status: 'open' }, 'published')).toThrow(/非法状态迁移/)
    expect(() => transition({ status: 'published' }, 'open')).toThrow(/非法状态迁移/)
  })
  it('幂等:同状态重入不抛错,仅刷新 updatedAt', () => {
    const t = transition({ status: 'diagnosing', updatedAt: '2020-01-01T00:00:00.000Z' }, 'diagnosing')
    expect(t.status).toBe('diagnosing')
    expect(t.updatedAt).not.toBe('2020-01-01T00:00:00.000Z')
    expect(() => transition({ status: 'archived' }, 'archived')).not.toThrow()
  })
  it('TASK_STATUSES 覆盖 7 个状态', () => {
    expect(TASK_STATUSES).toEqual(['open', 'diagnosing', 'draft-ready', 'published', 'archived', 'needs-login', 'needs-regeneration'])
  })
})

describe('持久化 round-trip', () => {
  it('save→load→list 一致(tmpdir 隔离)', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'repair-tasks-')), 'tasks')
    expect(tasksDir('/h')).toBe(join('/h', '.webcli', 'repair-tasks'))
    const t = buildTask({ source: 'manual', adapterId: 'wekm', failures: [{ tool: 'wekm.get-article', count: 5, lastErr: 'x' }] })
    saveTask(t, dir)
    expect(loadTask(t.id, dir).adapterId).toBe('wekm')
    expect(listTasks(dir)).toHaveLength(1)
  })
})
