import { describe, it, expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { readUpdateCache, formatUpdateNotice, checkAdapterUpdates, CHECK_TTL_MS, REFRESH_TIMEOUT_MS } from '../adapterhub-update-check.js'

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
  it('hub 黑洞 → 真 abort:socket 在 ≈REFRESH_TIMEOUT_MS 关闭,不被拖到 client 30s 超时', async () => {
    // 真实链路(defaultCompare → adapterhub-cli → adapterhub-client fetch)打到 accept 后
    // 永不响应的本地服务器:验证 abort 真正取消了 socket(ref'd pending I/O),而非只赢下 Promise。
    const net = await import('node:net')
    let resolveClosed
    const closed = new Promise((r) => { resolveClosed = r })
    const server = net.createServer((socket) => socket.on('close', resolveClosed))
    const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
    const prevEndpoint = process.env.WEBCLI_ADAPTERHUB_ENDPOINT
    process.env.WEBCLI_ADAPTERHUB_ENDPOINT = `http://127.0.0.1:${port}`
    try {
      const file = join(await mkdtemp(join(tmpdir(), 'ahc-')), 'c.json')
      const now = Date.now()
      writeFileSync(file, JSON.stringify({ checkedAt: now - CHECK_TTL_MS - 1, updates: ROWS }))
      const started = Date.now()
      // 不传 compareImpl → 走 defaultCompare 真链路;本次立即返回旧缓存
      const updates = await checkAdapterUpdates({ file, now })
      expect(updates).toEqual(ROWS)
      const outcome = await Promise.race([
        closed.then(() => 'closed'),
        new Promise((r) => setTimeout(r, 15000)).then(() => 'stuck'),
      ])
      const elapsed = Date.now() - started
      expect(outcome).toBe('closed') // socket 被真取消(server 端看到关闭),进程不被拖住
      expect(elapsed).toBeLessThan(REFRESH_TIMEOUT_MS * 2) // ≈5s abort,而非 client 默认 30s 超时
      expect(readUpdateCache(file).updates).toEqual(ROWS) // abort 不落盘,缓存仍是旧值
    } finally {
      if (prevEndpoint === undefined) delete process.env.WEBCLI_ADAPTERHUB_ENDPOINT
      else process.env.WEBCLI_ADAPTERHUB_ENDPOINT = prevEndpoint
      await Promise.race([new Promise((r) => server.close(r)), new Promise((r) => setTimeout(r, 2000))])
    }
  })
})
