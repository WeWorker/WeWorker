/**
 * 「路由直达」徽标数据面单测。
 *
 * 徽标会直接影响用户对「这个站点是否被配置覆盖」的判断，所以两面都要钉住：
 * ① 五个配置层里任一条已启用条目指向该站点 → 亮；
 * ② 「已下线」「opt-out」「工具不属于当前 Adapter」→ 一律不亮。
 * 反向断言比正向更重要：假亮的代价是用户以为配好了，实际却落回模型。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { computeRoutableSites, computeRoutableSitesFromConfig } from '../router-config/index.js'
import { emptyRouterConfigBundle, type RouterConfigBundle } from '../router-config/types.js'

const ADAPTERS = new Set(['example.com', 'shop.example.org'])

function silentLog() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}

function bundle(patch: Partial<RouterConfigBundle>): RouterConfigBundle {
  return { ...emptyRouterConfigBundle(), ...patch }
}

describe('computeRoutableSites：哪些站点被配置覆盖', () => {
  it('空配置 → 没有任何站点可直达（公开基线默认如此）', () => {
    const report = computeRoutableSites(emptyRouterConfigBundle(), ADAPTERS)
    expect([...report.routable]).toEqual([])
    expect(report.entryCount.size).toBe(0)
  })

  it('routes 层一条已启用条目 → 归属到工具所属站点', () => {
    const report = computeRoutableSites(
      bundle({ routes: { routes: [{ id: 'r1', tool: 'example.com.list' }] } }),
      ADAPTERS,
    )
    expect([...report.routable]).toEqual(['example.com'])
    expect(report.entryCount.get('example.com')).toBe(1)
  })

  it('aliases / shortcuts / patterns / plans / scenarioRoutes 五层都能点亮', () => {
    const report = computeRoutableSites(
      bundle({
        aliases: { aliases: [{ id: 'a1', tool: 'example.com.one' }] },
        shortcuts: { shortcuts: [{ id: 's1', tool: 'example.com.two' }] },
        patterns: { configs: { 'example.com.three': { enabled: true } } },
        plans: {
          plans: [
            {
              id: 'p1',
              resolvers: [{ produces: 'x', tool: 'example.com.four' }],
              terminals: [{ key: 't', tool: 'example.com.five' }],
            },
          ],
        },
        scenarioRoutes: { routes: [{ adapter: 'example.com', scenarioId: 'sc1', tool: 'example.com.six' }] },
      }),
      ADAPTERS,
    )
    expect(report.routable.has('example.com')).toBe(true)
    // 1 alias + 1 shortcut + 1 pattern + 2 plan(工具) + 1 scenario = 6
    expect(report.entryCount.get('example.com')).toBe(6)
  })

  it('scenarioRoutes 的 plan 形态按 terminal 归属', () => {
    const report = computeRoutableSites(
      bundle({
        scenarioRoutes: {
          routes: [{ adapter: 'example.com', scenarioId: 'sc2', plan: { terminal: 'shop.example.org.detail' } }],
        },
      }),
      ADAPTERS,
    )
    expect([...report.routable]).toEqual(['shop.example.org'])
  })

  it('enabled:false 的条目不算数（临时下线即刻熄灭）', () => {
    const report = computeRoutableSites(
      bundle({
        routes: { routes: [{ id: 'r1', tool: 'example.com.list', enabled: false }] },
        aliases: { aliases: [{ id: 'a1', tool: 'example.com.one', enabled: false }] },
        shortcuts: { shortcuts: [{ id: 's1', tool: 'example.com.two', enabled: false }] },
        patterns: { configs: { 'example.com.three': { enabled: false } } },
        plans: {
          plans: [
            { id: 'p1', enabled: false, terminals: [{ key: 't', tool: 'example.com.four' }] },
          ],
        },
        scenarioRoutes: {
          routes: [{ adapter: 'example.com', scenarioId: 'sc', tool: 'example.com.six', enabled: false }],
        },
      }),
      ADAPTERS,
    )
    expect([...report.routable]).toEqual([])
  })

  it('opt-out 卡片不是路由面（公开基线的 11 条都在此列，不该点亮任何站点）', () => {
    const report = computeRoutableSites(
      bundle({
        scenarioRoutes: {
          routes: [
            { adapter: 'example.com', scenarioId: 'sc', optout: true, reason: '写操作不进路由面' },
            { adapter: 'shop.example.org', scenarioId: 'sc2', direct: false } as never,
          ],
        },
      }),
      ADAPTERS,
    )
    expect([...report.routable]).toEqual([])
  })

  it('工具不属于任何当前 Adapter → 丢弃（配置项只对存在的 adapter 生效）', () => {
    const report = computeRoutableSites(
      bundle({
        routes: {
          routes: [
            { id: 'r1', tool: 'gone.example.net.list' },
            { id: 'r2', tool: 'example.com.list' },
          ],
        },
      }),
      ADAPTERS,
    )
    expect([...report.routable]).toEqual(['example.com'])
  })

  it('最长前缀优先：mail.qq.com.cn 的工具不会被记到 mail.qq.com 头上', () => {
    const ids = new Set(['mail.qq.com', 'mail.qq.com.cn'])
    const report = computeRoutableSites(
      bundle({ routes: { routes: [{ id: 'r1', tool: 'mail.qq.com.cn.list' }] } }),
      ids,
    )
    expect([...report.routable]).toEqual(['mail.qq.com.cn'])
    expect(report.routable.has('mail.qq.com')).toBe(false)
  })

  it('工具名等于 Adapter id 本身也算（isToolInAdapterScope 的既有口径）', () => {
    const report = computeRoutableSites(
      bundle({ routes: { routes: [{ id: 'r1', tool: 'example.com' }] } }),
      ADAPTERS,
    )
    expect([...report.routable]).toEqual(['example.com'])
  })

  it('坏条目（缺 tool / 非字符串 / 空串）被跳过而不是抛异常', () => {
    const report = computeRoutableSites(
      bundle({
        routes: { routes: [{ id: 'r1' }, { id: 'r2', tool: '' }, { id: 'r3', tool: 42 }] as never },
        aliases: { aliases: [null as never] },
        shortcuts: { shortcuts: [{ id: 's1', tool: 'example.com.ok' }] },
      }),
      ADAPTERS,
    )
    expect([...report.routable]).toEqual(['example.com'])
    expect(report.entryCount.get('example.com')).toBe(1)
  })

  it('空 Adapter 集合 / 空配置束 → 空报告，不抛', () => {
    expect([...computeRoutableSites(emptyRouterConfigBundle(), new Set()).routable]).toEqual([])
    expect([...computeRoutableSites(null, ADAPTERS).routable]).toEqual([])
    expect([...computeRoutableSites(undefined, ADAPTERS).routable]).toEqual([])
  })
})

describe('computeRoutableSitesFromConfig：加载失败必须退化而非抛出', () => {
  const tempDirs: string[] = []

  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-routable-'))
    tempDirs.push(dir)
    return dir
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      try {
        fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
      } catch {
        // 清理失败不影响断言
      }
    }
  })

  it('目录里没有任何配置文件 → 空报告（等于「全部不可直达」）', () => {
    const report = computeRoutableSitesFromConfig(new Set(['example.com']), {
      defaultsDir: path.join(tempDir(), 'missing'),
      userDir: path.join(tempDir(), 'missing-user'),
      log: silentLog(),
    })
    expect([...report.routable]).toEqual([])
  })

  it('坏 JSON 不让接口崩，只是徽标不亮', () => {
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, 'routes.json'), '{ this is not json', 'utf-8')
    const report = computeRoutableSitesFromConfig(new Set(['example.com']), {
      defaultsDir: dir,
      userDir: path.join(dir, 'user'),
      log: silentLog(),
    })
    expect([...report.routable]).toEqual([])
  })

  it('正常配置能读出来（证明不是「永远返回空」的假绿）', () => {
    const dir = tempDir()
    fs.writeFileSync(
      path.join(dir, 'routes.json'),
      JSON.stringify({ routes: [{ id: 'r1', tool: 'example.com.list', examples: ['示例'] }] }),
      'utf-8',
    )
    const report = computeRoutableSitesFromConfig(new Set(['example.com']), {
      defaultsDir: dir,
      userDir: path.join(dir, 'user'),
      log: silentLog(),
    })
    expect([...report.routable]).toEqual(['example.com'])
  })

  it('空 Adapter 集合直接短路（不读盘）', () => {
    const report = computeRoutableSitesFromConfig(new Set(), { defaultsDir: tempDir(), log: silentLog() })
    expect([...report.routable]).toEqual([])
  })
})
