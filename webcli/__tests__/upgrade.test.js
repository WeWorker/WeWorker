import { describe, it, expect } from 'vitest'
import { runUpgrade, buildInstallCommand, fetchLatestVersion, resolveGlobalInstallTarget } from '../upgrade.js'

describe('fetchLatestVersion', () => {
  it('取 manifest.version;非 ok/缺 version 抛错', async () => {
    expect(await fetchLatestVersion('http://r', 'pkg', async () => ({ ok: true, json: async () => ({ version: '2.0.0' }) }))).toBe('2.0.0')
    await expect(fetchLatestVersion('http://r', 'pkg', async () => ({ ok: false, json: async () => ({}) }))).rejects.toThrow()
  })
})

describe('buildInstallCommand', () => {
  it('npm -g 安装带 registry', () => {
    expect(buildInstallCommand('@webank/webcli', '1.1.11', 'https://registry.example.com'))
      .toBe('npm install -g @webank/webcli@1.1.11 --registry=https://registry.example.com')
  })
})

describe('runUpgrade', () => {
  const mk = (over = {}) => ({
    pkgName: '@webank/webcli', currentVersion: '1.1.8',
    fetchImpl: async () => ({ ok: true, json: async () => ({ version: '1.1.11' }) }),
    spawnImpl: async () => ({ code: 0 }),
    removeImpl: async () => {}, existsImpl: async () => true,
    log: () => {}, registryOverride: null, home: '/h', embedded: false, ...over,
  })

  it('已是最新 → 跳过安装', async () => {
    let spawned = 0
    const res = await runUpgrade(mk({ currentVersion: '1.1.11', spawnImpl: async () => { spawned++; return { code: 0 } } }))
    expect(res.upgraded).toBe(false)
    expect(spawned).toBe(0)
  })
  it('落后 → npm 安装 + 清理 SW 缓存 + upgraded', async () => {
    const calls = []
    const res = await runUpgrade(mk({
      spawnImpl: async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0 } },
      removeImpl: async (dir) => { calls.push(['rm', dir]) },
    }))
    expect(res.upgraded).toBe(true)
    expect(res.latest).toBe('1.1.11')
    expect(calls[0][0]).toBe('npm')
    expect(calls.some((c) => c[0] === 'rm' && c[1].includes('Service Worker'))).toBe(true)
  })
  it('npm 失败 → 保留原版本,upgraded=false', async () => {
    const res = await runUpgrade(mk({ spawnImpl: async () => ({ code: 1 }) }))
    expect(res.upgraded).toBe(false)
    expect(res.error).toBeTruthy()
  })
  it('内嵌模式 → 不装不查,提示走应用更新', async () => {
    let fetched = 0
    const res = await runUpgrade(mk({ embedded: true, fetchImpl: async () => { fetched++; throw new Error('should not fetch') } }))
    expect(res.upgraded).toBe(false)
    expect(res.embedded).toBe(true)
    expect(fetched).toBe(0)
  })
})

describe('resolveGlobalInstallTarget', () => {
  it('无本地全局包线索 → 不带 --prefix(走系统 npm 默认)', async () => {
    const t = await resolveGlobalInstallTarget({ env: {}, platform: 'win32', existsImpl: async () => false })
    expect(t.prefixArgs).toEqual([])
  })
  it('检测到用户级全局目录存在 → --prefix 指向它', async () => {
    const t = await resolveGlobalInstallTarget({
      env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, platform: 'win32',
      existsImpl: async (p) => p === 'C:\\Users\\u\\AppData\\Roaming\\npm',
    })
    expect(t.prefixArgs).toEqual(['--prefix', 'C:\\Users\\u\\AppData\\Roaming\\npm'])
  })
  it('POSIX 平台探测 ~/.npm-global 不存在 → 无 prefix', async () => {
    const t = await resolveGlobalInstallTarget({ env: { HOME: '/home/u' }, platform: 'linux', existsImpl: async () => false })
    expect(t.prefixArgs).toEqual([])
  })
  it('WEBCLI_UPGRADE_PREFIX 显式覆盖优先', async () => {
    const t = await resolveGlobalInstallTarget({
      env: { WEBCLI_UPGRADE_PREFIX: 'D:/npm-global' }, platform: 'win32', existsImpl: async () => false,
    })
    expect(t.prefixArgs).toEqual(['--prefix', 'D:/npm-global'])
  })
  it('生产布局推导:pkgDir 上三级 = prefix(node_modules/@webank/webcli → npm)', async () => {
    const path = await import('node:path')
    const pkgDir = 'C:/Users/u/AppData/Roaming/npm/node_modules/@webank/webcli'
    // 与实现同式:pkgDir 上三级(resolve 规范化为平台分隔符)
    expect(path.resolve(pkgDir, '..', '..', '..').replace(/\\/g, '/')).toBe('C:/Users/u/AppData/Roaming/npm')
  })
  it('runUpgrade 在用户级目录存在时把 --prefix 传给 npm', async () => {
    const calls = []
    const res = await runUpgrade({
      pkgName: '@webank/webcli', currentVersion: '1.1.8',
      fetchImpl: async () => ({ ok: true, json: async () => ({ version: '1.1.11' }) }),
      spawnImpl: async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0 } },
      removeImpl: async () => {}, existsImpl: async (p) => p === 'C:\\Users\\u\\AppData\\Roaming\\npm',
      log: () => {}, registryOverride: null, home: '/h', embedded: false,
      env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, platform: 'win32',
    })
    expect(res.upgraded).toBe(true)
    const npmLine = calls.find((c) => c[0] === 'npm')
    expect(npmLine).toContain('--prefix')
    expect(npmLine[npmLine.indexOf('--prefix') + 1]).toBe('C:\\Users\\u\\AppData\\Roaming\\npm')
  })
})
