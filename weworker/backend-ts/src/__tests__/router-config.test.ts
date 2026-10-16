import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyRouterConfigScope,
  getRouterConfig,
  getScopedRouterConfig,
  isToolInAdapterScope,
  loadRouterConfig,
  resetRouterConfigCacheForTests,
  resolveDefaultsDir,
  validateManifestFile,
  validatePlansFile,
  validateScenarioRoutesFile,
  validateShortcutsFile,
} from '../router-config/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** 仓库内真实的随包默认配置目录：backend-ts/src/__tests__ → weworker/router-config */
const REPO_DEFAULTS_DIR = path.resolve(HERE, '..', '..', '..', 'router-config')

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `weworker-router-${prefix}-`))
  tempDirs.push(dir)
  return dir
}

function writeJson(dir: string, name: string, value: unknown): string {
  const filePath = path.join(dir, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
  return filePath
}

/** 「零配置」的层文件内容：存在但为空。 */
const EMPTY_LAYER_FILES: Record<string, unknown> = {
  'manifest.json': { schemaVersion: 1, layers: {} },
  'routes.json': { routes: [] },
  'aliases.json': { aliases: [] },
  'shortcuts.json': { shortcuts: [] },
  'patterns.json': { version: '1', configs: {} },
  'plans.json': { plans: [] },
  'renderers.json': { schemas: {} },
  'plan-terminals.json': { version: 1, adapters: {} },
  'scenario-routes.json': { version: 2, routes: [] },
}

beforeEach(() => {
  resetRouterConfigCacheForTests()
})

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响断言
    }
  }
  resetRouterConfigCacheForTests()
})

describe('router-config 随包默认配置', () => {
  it('零配置时所有层为空且不报错（行为与未接入智能路由一致）', () => {
    // 「零配置」指层文件存在但内容为空——这与仓库当前是否已随包带配置无关。
    // 用临时空目录而不是 REPO_DEFAULTS_DIR，避免随包配置一开始有内容这条用例就失效。
    const emptyDefaults = makeTempDir('empty-defaults')
    for (const [name, value] of Object.entries(EMPTY_LAYER_FILES)) writeJson(emptyDefaults, name, value)
    const emptyUser = makeTempDir('empty-user')
    const loaded = loadRouterConfig({ defaultsDir: emptyDefaults, userDir: emptyUser, log: silentLog() })

    expect(loaded.bundle.routes.routes).toEqual([])
    expect(loaded.bundle.aliases.aliases).toEqual([])
    expect(loaded.bundle.shortcuts.shortcuts).toEqual([])
    expect(loaded.bundle.patterns.configs).toEqual({})
    expect(loaded.bundle.plans.plans).toEqual([])
    expect(loaded.bundle.renderers.schemas).toEqual({})
    expect(loaded.bundle.planTerminals.adapters).toEqual({})
    expect(loaded.bundle.scenarioRoutes.routes).toEqual([])

    expect(loaded.bundle.sources.every((source) => !source.rejected)).toBe(true)
    expect(loaded.bundle.sources.map((source) => source.layer)).toContain('manifest')
    expect(loaded.bundle.sources.find((source) => source.layer === 'routes')?.origin).toBe('bundled')
  })

  it('随包基线自身可被加载器接受（`gen:routes` 产物与运行时同源）', () => {
    const emptyUser = makeTempDir('baseline-user')
    const loaded = loadRouterConfig({ defaultsDir: REPO_DEFAULTS_DIR, userDir: emptyUser, log: silentLog() })

    expect(loaded.bundle.sources.every((source) => !source.rejected)).toBe(true)
    const scenarioSource = loaded.bundle.sources.find((source) => source.layer === 'scenarioRoutes')
    expect(scenarioSource?.origin).toBe('bundled')
    // 产物必须被校验器接受：`gen:routes` 写出的东西加载器要能原样吃下，
    // 否则「编译期通过、运行期整层被拒」会在最坏的时候才暴露。
    expect(loaded.bundle.scenarioRoutes.routes?.length ?? 0).toBeGreaterThan(0)
  })

  it('同一签名重复读取命中缓存，不重复解析', () => {
    const emptyUser = makeTempDir('cache-user')
    const first = loadRouterConfig({ defaultsDir: REPO_DEFAULTS_DIR, userDir: emptyUser, log: silentLog() })
    const second = loadRouterConfig({ defaultsDir: REPO_DEFAULTS_DIR, userDir: emptyUser, log: silentLog() })
    expect(second.signature).toBe(first.signature)
    expect(second.bundle).toBe(first.bundle)
  })

  it('开发态默认目录指向 weworker/router-config，环境变量优先', () => {
    const previous = process.env.WEWORKER_ROUTER_CONFIG_DIR
    try {
      delete process.env.WEWORKER_ROUTER_CONFIG_DIR
      expect(resolveDefaultsDir()).toBe(REPO_DEFAULTS_DIR)

      const override = makeTempDir('override-dir')
      writeJson(override, 'routes.json', { routes: [] })
      process.env.WEWORKER_ROUTER_CONFIG_DIR = override
      expect(resolveDefaultsDir()).toBe(path.resolve(override))
    } finally {
      if (previous === undefined) delete process.env.WEWORKER_ROUTER_CONFIG_DIR
      else process.env.WEWORKER_ROUTER_CONFIG_DIR = previous
    }
  })
})

describe('router-config 用户覆盖层', () => {
  it('用户层新增条目按 id 合并进来，并记录来源', () => {
    const defaults = makeTempDir('defaults')
    const user = makeTempDir('user')
    writeJson(defaults, 'shortcuts.json', {
      shortcuts: [{ id: 'base', tool: 'example.com.list-items', patterns: { positive: ['^列表$'] }, examples: ['列表'] }],
    })
    writeJson(user, 'shortcuts.json', {
      shortcuts: [
        { id: 'base', tool: 'example.com.list-items', priority: 5, examples: ['列表'] },
        { id: 'extra', tool: 'example.com.search-items', patterns: { positive: ['^搜索'] }, examples: ['搜索'] },
      ],
    })

    const bundle = getRouterConfig({ defaultsDir: defaults, userDir: user, log: silentLog() })
    expect(bundle.shortcuts.shortcuts?.map((entry) => entry.id)).toEqual(['base', 'extra'])
    // 同 id 覆盖：整条替换，不做深合并
    expect(bundle.shortcuts.shortcuts?.[0]).toEqual({
      id: 'base',
      tool: 'example.com.list-items',
      priority: 5,
      examples: ['列表'],
    })

    const source = bundle.sources.find((item) => item.layer === 'shortcuts')
    expect(source?.origin).toBe('user')
    expect(source?.overriddenIds).toEqual(['base', 'extra'])
  })

  it('记录型层用户侧值为 null 时删除该键', () => {
    const defaults = makeTempDir('defaults')
    const user = makeTempDir('user')
    writeJson(defaults, 'renderers.json', { schemas: { keep: { maxRows: 10 }, drop: { maxRows: 20 } } })
    writeJson(user, 'renderers.json', { schemas: { drop: null, added: { maxRows: 5 } } })

    const bundle = getRouterConfig({ defaultsDir: defaults, userDir: user, log: silentLog() })
    expect(Object.keys(bundle.renderers.schemas ?? {}).sort()).toEqual(['added', 'keep'])
  })

  it('manifest.layers 显式关闭的层返回空结构', () => {
    const defaults = makeTempDir('defaults')
    const user = makeTempDir('user')
    writeJson(defaults, 'shortcuts.json', { shortcuts: [{ id: 'x', tool: 'example.com.list-items' }] })
    writeJson(user, 'manifest.json', { schemaVersion: 1, layers: { shortcuts: false } })

    const bundle = getRouterConfig({ defaultsDir: defaults, userDir: user, log: silentLog() })
    expect(bundle.shortcuts.shortcuts).toEqual([])
    expect(bundle.sources.find((item) => item.layer === 'shortcuts')?.rejected).toContain('disabled by manifest.layers')
  })

  it('用户层 manifest 只覆盖显式给出的开关', () => {
    const defaults = makeTempDir('defaults')
    const user = makeTempDir('user')
    writeJson(defaults, 'manifest.json', { schemaVersion: 1, layers: { shortcuts: false, routes: true } })
    writeJson(user, 'manifest.json', { layers: { routes: false } })

    const bundle = getRouterConfig({ defaultsDir: defaults, userDir: user, log: silentLog() })
    expect(bundle.manifest.layers).toEqual({ shortcuts: false, routes: false })
  })
})

describe('router-config 热重载与错误降级', () => {
  it('改文件后下次读取即生效，无需重启', () => {
    const defaults = makeTempDir('defaults')
    const user = makeTempDir('user')
    writeJson(defaults, 'aliases.json', { aliases: [] })
    writeJson(user, 'aliases.json', {
      aliases: [{ id: 'first', tool: 'example.com.list-items', examples: ['!first'] }],
    })

    const options = { defaultsDir: defaults, userDir: user, log: silentLog() }
    expect(getRouterConfig(options).aliases.aliases?.map((entry) => entry.id)).toEqual(['first'])

    writeJson(user, 'aliases.json', {
      aliases: [
        { id: 'first', tool: 'example.com.list-items', examples: ['!first'] },
        { id: 'second-alias', tool: 'example.com.search-items', examples: ['!second-alias'] },
      ],
    })
    expect(getRouterConfig(options).aliases.aliases?.map((entry) => entry.id)).toEqual(['first', 'second-alias'])
  })

  it('非法正则被加载期拦下，整层回退到上一份可用配置', () => {
    const defaults = makeTempDir('defaults')
    const user = makeTempDir('user')
    writeJson(defaults, 'shortcuts.json', {
      shortcuts: [{ id: 'good', tool: 'example.com.list-items', examples: ['列表'] }],
    })

    const options = { defaultsDir: defaults, userDir: user, log: silentLog() }
    expect(getRouterConfig(options).shortcuts.shortcuts?.map((entry) => entry.id)).toEqual(['good'])

    // 唯一被拒的原因必须是「正则非法」：`examples` 已给全，否则这条用例会变成
    // 「反正都被拒了」，正则校验反而失去覆盖。
    writeJson(user, 'shortcuts.json', {
      shortcuts: [
        { id: 'broken', tool: 'example.com.list-items', patterns: { positive: ['('] }, examples: ['列表'] },
      ],
    })
    const bundle = getRouterConfig(options)
    expect(bundle.shortcuts.shortcuts?.map((entry) => entry.id)).toEqual(['good'])
    expect(bundle.sources.find((item) => item.layer === 'shortcuts')?.rejected).toContain('kept previous')
  })

  it('用户层 JSON 解析失败只告警，不影响随包默认', () => {
    const defaults = makeTempDir('defaults')
    const user = makeTempDir('user')
    writeJson(defaults, 'plans.json', { plans: [{ id: 'plan-a', adapterId: 'example.com', examples: ['示例'] }] })
    fs.writeFileSync(path.join(user, 'plans.json'), '{ this is not json', 'utf-8')

    const bundle = getRouterConfig({ defaultsDir: defaults, userDir: user, log: silentLog() })
    expect(bundle.plans.plans?.map((plan) => plan.id)).toEqual(['plan-a'])
    // 光回退不够：必须能对外说出「为什么这一层不是你要的那份」，否则排查「为什么没命中」时
    // 只会看到「层是空的」，与「条目都没匹配上」无法区分。
    expect(bundle.sources.find((item) => item.layer === 'plans')?.rejected).toContain('解析失败')
  })

  it('切换配置目录时不继承上一个目录的回退内容', () => {
    const defaults = makeTempDir('defaults')
    const userA = makeTempDir('user-a')
    const userB = makeTempDir('user-b')
    writeJson(defaults, 'shortcuts.json', {
      shortcuts: [{ id: 'base', tool: 'example.com.list-items', examples: ['列表'] }],
    })
    writeJson(userA, 'shortcuts.json', {
      shortcuts: [{ id: 'from-a', tool: 'example.com.list-items', examples: ['列表'] }],
    })
    expect(
      getRouterConfig({ defaultsDir: defaults, userDir: userA, log: silentLog() }).shortcuts.shortcuts?.map((e) => e.id),
    ).toEqual(['base', 'from-a'])

    writeJson(userB, 'shortcuts.json', {
      shortcuts: [
        { id: 'bad', tool: 'example.com.list-items', patterns: { positive: ['('] }, examples: ['列表'] },
      ],
    })
    const bundle = getRouterConfig({ defaultsDir: defaults, userDir: userB, log: silentLog() })
    expect(bundle.shortcuts.shortcuts?.map((entry) => entry.id)).toEqual(['base'])
    expect(bundle.sources.find((item) => item.layer === 'shortcuts')?.rejected).toContain('fell back to bundled')
  })

  it('随包默认配置本身非法时该层退化为空，不抛异常', () => {
    const defaults = makeTempDir('defaults')
    const user = makeTempDir('user')
    fs.writeFileSync(path.join(defaults, 'routes.json'), '{ broken', 'utf-8')

    const bundle = getRouterConfig({ defaultsDir: defaults, userDir: user, log: silentLog() })
    expect(bundle.routes.routes).toEqual([])
    // 「层是空的」必须带原因：这条断言就是给那次事故立的碑——
    // 改动前的引擎用裸 JSON.parse 读带注释的新配置，8 个层全空、rejected 全 undefined，
    // 用户侧只看到「路由突然不生效了」，没有任何可查的线索。
    const rejected = bundle.sources.find((item) => item.layer === 'routes')?.rejected ?? ''
    expect(rejected).toContain('routes.json')
    expect(rejected).toContain('解析失败')
  })

  it('随包配置被改坏导致解析失败时，保留上一份可用配置而不是让该层变空', () => {
    const defaults = makeTempDir('defaults')
    const user = makeTempDir('user')
    writeJson(defaults, 'routes.json', {
      routes: { 'example.com': [{ id: 'hot', tool: 'example.com.hot', examples: ['示例站点热榜'] }] },
    })
    expect(getRouterConfig({ defaultsDir: defaults, userDir: user, log: silentLog() }).routes.routes?.length).toBe(1)

    // 把文件改坏（语法错 / 换成裸 JSON.parse 读不懂的形态）
    fs.writeFileSync(path.join(defaults, 'routes.json'), '/* 注释 */ { "routes": { ', 'utf-8')
    const bundle = getRouterConfig({ defaultsDir: defaults, userDir: user, log: silentLog() })
    expect(bundle.routes.routes?.map((entry) => entry.id)).toEqual(['hot'])
    expect(bundle.sources.find((item) => item.layer === 'routes')?.rejected).toContain('kept previous')
  })
})

describe('router-config 作用域过滤（只对当前存在的 Adapter 生效）', () => {
  it('工具名按 Adapter 前缀判定，且不匹配同前缀的相邻域名', () => {
    const adapters = new Set(['example.com'])
    expect(isToolInAdapterScope('example.com', adapters)).toBe(true)
    expect(isToolInAdapterScope('example.com.list-items', adapters)).toBe(true)
    expect(isToolInAdapterScope('example.company.list-items', adapters)).toBe(false)
    expect(isToolInAdapterScope('example.comx', adapters)).toBe(false)
  })

  it('不在当前 Adapter 集合内的条目被丢弃并记录原因', () => {
    const bundle = {
      routes: { routes: [{ id: 'a', tool: 'example.com.list-items' }, { id: 'b', tool: 'other.org.list' }] },
      aliases: { aliases: [{ id: 'c', tool: 'other.org.list' }] },
      shortcuts: { shortcuts: [{ id: 'd', tool: 'example.com.search' }] },
      patterns: { configs: { 'example.com.x': {}, 'other.org.y': {} } },
      plans: { plans: [{ id: 'e', adapterId: 'other.org' }] },
      planTerminals: { adapters: { 'example.com': {}, 'other.org': {} } },
      scenarioRoutes: { routes: [{ adapter: 'example.com', scenarioId: 's1', tool: 'example.com.list-items' }] },
    }

    const scoped = applyRouterConfigScope(bundle, new Set(['example.com']))
    expect(scoped.bundle.routes.routes?.map((entry) => entry.id)).toEqual(['a'])
    expect(scoped.bundle.aliases.aliases).toEqual([])
    expect(scoped.bundle.shortcuts.shortcuts?.map((entry) => entry.id)).toEqual(['d'])
    expect(Object.keys(scoped.bundle.patterns.configs ?? {})).toEqual(['example.com.x'])
    expect(scoped.bundle.plans.plans).toEqual([])
    expect(Object.keys(scoped.bundle.planTerminals.adapters ?? {})).toEqual(['example.com'])
    expect(scoped.bundle.scenarioRoutes.routes).toHaveLength(1)
    expect(scoped.dropped.length).toBeGreaterThanOrEqual(5)
  })

  it('plan 里任一 resolver/terminal 工具越界即整条丢弃', () => {
    const scoped = applyRouterConfigScope(
      {
        routes: {},
        aliases: {},
        shortcuts: {},
        patterns: {},
        plans: {
          plans: [
            {
              id: 'mixed',
              adapterId: 'example.com',
              resolvers: [{ produces: 'id', tool: 'example.com.list-items' }],
              terminals: [{ key: 'detail', needs: ['id'], tool: 'other.org.detail' }],
            },
          ],
        },
        planTerminals: {},
        scenarioRoutes: {},
      },
      new Set(['example.com']),
    )
    expect(scoped.bundle.plans.plans).toEqual([])
    expect(scoped.dropped.some((entry) => entry.includes('other.org.detail'))).toBe(true)
  })

  it('getScopedRouterConfig 保留 manifest 与 sources，只替换逐条目层', () => {
    const defaults = makeTempDir('defaults')
    const user = makeTempDir('user')
    writeJson(defaults, 'aliases.json', {
      aliases: [{ id: 'a', tool: 'example.com.list-items', examples: ['!a'] }],
    })

    const result = getScopedRouterConfig(new Set(['example.com']), {
      defaultsDir: defaults,
      userDir: user,
      log: silentLog(),
    })
    expect(result.bundle.aliases.aliases?.map((entry) => entry.id)).toEqual(['a'])
    expect(result.bundle.sources.length).toBeGreaterThan(0)
    expect(result.bundle.renderers).toEqual({ schemas: {} })
    expect(result.dropped).toEqual([])
  })
})

describe('router-config 校验器', () => {
  it('shortcuts 校验指出具体出错的下标与字段', () => {
    const errors = validateShortcutsFile({
      shortcuts: [
        { id: 'ok', tool: 'example.com.list-items' },
        { id: 'bad', tool: 'example.com.list-items', extract: [{ regex: '[', arg: 'q' }], priority: 'high' },
      ],
    })
    expect(errors.some((error) => error.includes('shortcuts[1].extract[0].regex'))).toBe(true)
    expect(errors.some((error) => error.includes('shortcuts[1].priority'))).toBe(true)
  })

  it('plan terminal 依赖不存在的锚点被判为配置错', () => {
    const errors = validatePlansFile({
      plans: [
        {
          id: 'broken-link',
          resolvers: [{ produces: 'itemId', tool: 'example.com.list-items' }],
          terminals: [{ key: 'detail', needs: ['missingAnchor'], tool: 'example.com.get-item' }],
        },
      ],
    })
    expect(errors.some((error) => error.includes('missingAnchor'))).toBe(true)
  })

  it('scenario 路由必须三选一声明 tool / plan / optout', () => {
    expect(
      validateScenarioRoutesFile({ routes: [{ adapter: 'example.com', scenarioId: 'empty' }] }),
    ).toContain('routes[0] must declare exactly one of tool / plan / optout')
    expect(
      validateScenarioRoutesFile({ routes: [{ adapter: 'example.com', scenarioId: 'ok', tool: 'example.com.list-items' }] }),
    ).toEqual([])
  })

  it('manifest 的 schema 版本高于支持范围时拒绝', () => {
    expect(validateManifestFile({ schemaVersion: 99 })).toHaveLength(1)
    expect(validateManifestFile({ schemaVersion: 1, layers: { routes: 'yes' } })).not.toEqual([])
  })
})

function silentLog() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}
