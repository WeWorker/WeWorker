// Feature: webcli-version-check, 版本自检 + upgrade
import { describe, it, expect } from 'vitest'
import { compareSemver, checkForUpdate, readVersionCache, writeVersionCache, resolveRegistry } from '../version-check.js'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpFile = () => join(tmpdir(), `vc-${randomUUID()}.json`)

describe('compareSemver', () => {
  it('数字段比较', () => {
    expect(compareSemver('1.1.8', '1.1.11')).toBe(-1)
    expect(compareSemver('1.1.10', '1.1.9')).toBe(1)
    expect(compareSemver('1.1.8', '1.1.8')).toBe(0)
    expect(compareSemver('1.2', '1.1.9')).toBe(1)
  })
})

describe('checkForUpdate', () => {
  const base = { currentVersion: '1.1.8', pkgName: '@webank/webcli', registry: 'http://x:8001' }

  it('缓存落后 → 返回提示(零网络)', async () => {
    const file = tmpFile()
    await writeVersionCache({ latest: '1.1.11', checkedAt: Date.now() }, file)
    const notice = await checkForUpdate({ ...base, file })
    expect(notice).toContain('1.1.11')
    expect(notice).toContain('webcli upgrade')
  })
  it('缓存最新 / 相同 → null', async () => {
    const file = tmpFile()
    await writeVersionCache({ latest: '1.1.8', checkedAt: Date.now() }, file)
    expect(await checkForUpdate({ ...base, file })).toBe(null)
  })
  it('无缓存/过期 → 触发后台刷新并写缓存,本次不打提示', async () => {
    const file = tmpFile()
    let fetched = 0
    const fetchImpl = async () => { fetched++; return { ok: true, json: async () => ({ version: '1.1.11' }) } }
    const notice = await checkForUpdate({ ...base, file, fetchImpl, now: 1_000_000_000_000 })
    expect(notice).toBe(null)
    expect(fetched).toBe(1)
    await new Promise((r) => setTimeout(r, 20)) // 后台刷新是 fire-and-forget,等它落盘
    expect((await readVersionCache(file)).latest).toBe('1.1.11')
  })
  it('内嵌模式(WEBCLI_EMBEDDED)直接 null,不读不写', async () => {
    const file = tmpFile()
    const notice = await checkForUpdate({ ...base, file, embedded: true })
    expect(notice).toBe(null)
    expect(await readVersionCache(file)).toBe(null)
  })
})

describe('resolveRegistry', () => {
  it('按包名自推导,可覆盖', () => {
    expect(resolveRegistry('@webank/webcli')).toBe('http://wnpm.weoa.com:8001')
    expect(resolveRegistry('weworker-webcli')).toBe('https://registry.npmjs.org')
    expect(resolveRegistry('@webank/webcli', 'http://override:8001')).toBe('http://override:8001')
  })
})
