import { describe, it, expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { readUpdateCache, formatUpdateNotice, checkAdapterUpdates, CHECK_TTL_MS } from '../adapterhub-update-check.js'

describe('formatUpdateNotice', () => {
  it('空 → null;upgrade/install 各出对应命令', () => {
    expect(formatUpdateNotice([])).toBe(null)
    const text = formatUpdateNotice([
      { adapter: 'wekm', local: '1.0.9', hub: '1.1.0', action: 'upgrade' },
      { adapter: 'newone', local: null, hub: '1.0.0', action: 'install' },
    ])
    expect(text).toContain('wekm 1.0.9 → 1.1.0')
    expect(text).toContain('webgo adapterhub upgrade wekm')
    expect(text).toContain('webgo adapterhub install newone')
  })
})

describe('checkAdapterUpdates', () => {
  const ROWS = [{ adapter: 'wekm', local: '1.0.9', hub: '1.1.0', action: 'upgrade' }]
  it('缓存新鲜 → 不回源,直接返回缓存', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'ahc-')), 'c.json')
    const now = Date.now()
    writeFileSync(file, JSON.stringify({ checkedAt: now - 1000, updates: ROWS }))
    let compared = 0
    const updates = await checkAdapterUpdates({ compareImpl: async () => { compared++; return ROWS }, file, now })
    expect(updates).toEqual(ROWS)
    expect(compared).toBe(0)
  })
  it('缓存过期 → 立即返回旧缓存,后台刷新写新缓存', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'ahc-')), 'c.json')
    const now = Date.now()
    writeFileSync(file, JSON.stringify({ checkedAt: now - CHECK_TTL_MS - 1, updates: ROWS }))
    const updates = await checkAdapterUpdates({ compareImpl: async () => [{ adapter: 'x', local: '1', hub: '2', action: 'upgrade' }], file, now })
    expect(updates).toEqual(ROWS) // 本次仍用旧缓存
    await new Promise((r) => setTimeout(r, 30))
    expect(readUpdateCache(file).updates[0].adapter).toBe('x') // 后台已刷新
  })
  it('无缓存 → 返回空数组并后台刷新', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'ahc-')), 'c.json')
    const updates = await checkAdapterUpdates({ compareImpl: async () => ROWS, file, now: Date.now() })
    expect(updates).toEqual([])
    await new Promise((r) => setTimeout(r, 30))
    expect(readUpdateCache(file).updates).toEqual(ROWS)
  })
})
