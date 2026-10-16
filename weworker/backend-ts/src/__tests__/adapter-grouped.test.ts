import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { expandAdapterGroupedField, expandAdapterGroupedRecordField } from '../router-config/adapter-grouped.js'
import { loadRouterConfig, resetRouterConfigCacheForTests } from '../router-config/index.js'

/**
 * 「按 Adapter 分节」归一化的正确性。
 *
 * 这里钉两件事：
 *   1. **旧形态零影响**——分节只是新增的书写方式，扁平数组必须逐字照旧通过，
 *      否则外部注入配置与历史覆盖层会集体失效；
 *   2. **错位必须报错**——分节 key 与条目自报的 adapter 不符时报错，
 *      这正是「新增 adapter 时把条目写进别的分节」的主要防污染点。
 */

const base = (field: string, value: unknown): Record<string, unknown> => ({ [field]: value })

/**
 * `AdapterGroupedExpansion.raw` 类型是 `unknown`：输入原样透传，非对象输入也照收。
 * 断言展开结果的形状时先收窄到对象，避免 `out.raw.configs` 这类下标访问无类型。
 */
const rawObject = (out: { raw: unknown }): Record<string, unknown> => out.raw as Record<string, unknown>

describe('expandAdapterGroupedField：旧形态兼容', () => {
  it('扁平数组原样返回，且不标记为已展开', () => {
    const raw = base('routes', [{ id: 'a', tool: 'x.com.a' }])
    const out = expandAdapterGroupedField(raw, 'routes')
    expect(out.raw).toBe(raw)
    expect(out.expanded).toBe(false)
    expect(out.errors).toEqual([])
  })

  it('字段缺失 / 非对象 / null 一律不报错，交给 schema 校验去说', () => {
    expect(expandAdapterGroupedField({}, 'routes')).toMatchObject({ errors: [], expanded: false })
    expect(expandAdapterGroupedField(null, 'routes')).toMatchObject({ errors: [], expanded: false })
    expect(expandAdapterGroupedField('nope', 'routes')).toMatchObject({ errors: [], expanded: false })
    expect(expandAdapterGroupedField({ routes: 'nope' }, 'routes').errors).toHaveLength(1)
  })

  it('分节写到顶层（层字段缺席）必须报错，不能静默当成「本层没配条目」', () => {
    // 真实事故形态：`{ "wikipedia.org": [ … ] }` 少了一层嵌套。
    // 若不拦，各层校验器都按「字段缺席」放行 → 整层静默失效、路由悄悄退回 LLM，无任何日志。
    const out = expandAdapterGroupedField(
      { 'wikipedia.org': [{ id: 'wiki', tool: 'wikipedia.org.random' }] },
      'routes',
    )
    expect(out.expanded).toBe(false)
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0]).toContain('"routes" is missing')
    expect(out.errors[0]).toContain('"wikipedia.org"')
    expect(out.errors[0]).toContain('one level too high')
  })

  it('顶层元信息键不会被误判成放错位置的分节', () => {
    expect(expandAdapterGroupedField({ version: 1, note: '说明', layers: {} }, 'routes').errors).toEqual([])
    // 值不是「对象数组」也不算分节
    expect(expandAdapterGroupedField({ 'wikipedia.org': [] }, 'routes').errors).toEqual([])
    expect(expandAdapterGroupedField({ 'wikipedia.org': ['裸字符串'] }, 'routes').errors).toEqual([])
  })
})

describe('expandAdapterGroupedField：展开结果', () => {
  it('按分节顺序展开为扁平数组，条目内容逐字保留', () => {
    const raw = base('routes', {
      'news.ycombinator.com': [{ id: 'hn', tool: 'news.ycombinator.com.top' }],
      'v2ex.com': [{ id: 'v2ex', tool: 'v2ex.com.hot' }],
    })
    const out = expandAdapterGroupedField(raw, 'routes')
    expect(out.errors).toEqual([])
    expect(out.expanded).toBe(true)
    expect(out.raw).toEqual({
      routes: [
        { id: 'hn', tool: 'news.ycombinator.com.top' },
        { id: 'v2ex', tool: 'v2ex.com.hot' },
      ],
    })
  })

  it('幂等：展开结果再展开不变（读时展开 + 合并后校验依赖这条）', () => {
    const once = expandAdapterGroupedField(base('aliases', { 'a.com': [{ id: 'x', tool: 'a.com.t' }] }), 'aliases')
    const twice = expandAdapterGroupedField(once.raw, 'aliases')
    expect(twice.raw).toEqual(once.raw)
    expect(twice.expanded).toBe(false)
  })

  it('分节值为 null 视为「本次不提供条目」，与空数组等价', () => {
    const out = expandAdapterGroupedField(base('shortcuts', { 'a.com': null, 'b.com': [{ id: 'b', tool: 'b.com.t' }] }), 'shortcuts')
    expect(out.errors).toEqual([])
    expect(out.raw).toEqual({ shortcuts: [{ id: 'b', tool: 'b.com.t' }] })
  })

  it('plans 形态按 adapterId 自报身份', () => {
    const ok = expandAdapterGroupedField(base('plans', { 'wikipedia.org': [{ id: 'p', adapterId: 'wikipedia.org' }] }), 'plans')
    expect(ok.errors).toEqual([])
    const bad = expandAdapterGroupedField(base('plans', { 'wikipedia.org': [{ id: 'p', adapterId: 'weread.qq.com' }] }), 'plans')
    expect(bad.errors).toHaveLength(1)
    expect(bad.errors[0]).toContain('sits under section')
  })
})

describe('expandAdapterGroupedField：错位与畸形', () => {
  it('工具归属与分节 key 不符 → 报错（这是防污染的主闸门）', () => {
    const out = expandAdapterGroupedField(
      base('routes', { 'v2ex.com': [{ id: 'hn', tool: 'news.ycombinator.com.top' }] }),
      'routes',
    )
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0]).toContain('belongs to "news.ycombinator.com"')
  })

  it('同前缀站点不会被误判归属（a.com 与 a.com.cn 互不通用）', () => {
    const out = expandAdapterGroupedField(
      base('routes', { 'a.com': [{ id: 'x', tool: 'a.com.cn.t' }] }),
      'routes',
    )
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0]).toContain('belongs to "a.com.cn"')
  })

  it('既无 adapterId 也无 tool 的条目在分节形态下报错', () => {
    const out = expandAdapterGroupedField(base('routes', { 'a.com': [{ id: 'x' }] }), 'routes')
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0]).toContain('must declare either')
  })

  it('分节不是数组 / 条目不是对象 → 逐项报错且不中断其它分节', () => {
    const out = expandAdapterGroupedField(
      base('routes', { 'a.com': 'nope', 'b.com': ['nope', { id: 'b', tool: 'b.com.t' }] }),
      'routes',
    )
    expect(out.errors).toEqual([
      '"routes.a.com" must be an array of entries',
      'routes.b.com[0] must be an object',
    ])
    // 合法条目仍然展开出来，便于错误信息里两条并列显示
    expect(out.raw).toEqual({ routes: [{ id: 'b', tool: 'b.com.t' }] })
  })
})

// ── 记录型层（patterns 的 configs）：分节形态 ────────────────────────────────
//
// 这一层的两种形态**都是对象**（旧形态 key 是完整工具名，新形态 key 是 adapter id），
// 两边的 key 都带点，靠数点数分不开——只能看值本身的形状。因此这里钉的重点是
// 「形态判定不能把一条配置误当成分节」，那会让条目**静默消失**。

describe('expandAdapterGroupedRecordField：形态判定', () => {
  const entry = { priority: 10, patterns: [{ type: 'keyword' as const, keywords: ['x'], examples: ['x'] }] }

  it('旧形态（key = 完整工具名）原样返回，不标记为已展开', () => {
    const raw = base('configs', { 'a.com.search': entry })
    const out = expandAdapterGroupedRecordField(raw, 'configs')
    expect(out.raw).toBe(raw)
    expect(out.expanded).toBe(false)
    expect(out.errors).toEqual([])
  })

  it('分节形态展开为「完整工具名 → 配置」的扁平记录，条目内容逐字保留', () => {
    const out = expandAdapterGroupedRecordField(
      base('configs', { 'a.com': { 'a.com.search': entry, 'a.com.read': entry }, 'b.com': { 'b.com.hot': entry } }),
      'configs',
    )
    expect(out.errors).toEqual([])
    expect(out.expanded).toBe(true)
    expect(Object.keys(rawObject(out).configs as object)).toEqual(['a.com.search', 'a.com.read', 'b.com.hot'])
    expect((rawObject(out).configs as Record<string, unknown>)['a.com.search']).toBe(entry)
  })

  it('幂等：展开结果再展开不变（读时展开 + 合并后校验依赖这条）', () => {
    const once = expandAdapterGroupedRecordField(base('configs', { 'a.com': { 'a.com.search': entry } }), 'configs')
    const twice = expandAdapterGroupedRecordField(once.raw, 'configs')
    expect(twice.raw).toEqual(once.raw)
    expect(twice.expanded).toBe(false)
  })

  it('只写了 default_args 的条目不会被误判成分节（成员全是对象，最像分节的那条）', () => {
    const out = expandAdapterGroupedRecordField(base('configs', { 'a.com.search': { default_args: { limit: 5 } } }), 'configs')
    expect(out.expanded).toBe(false)
    expect(out.errors).toEqual([])
    expect(Object.keys(rawObject(out).configs as object)).toEqual(['a.com.search'])
  })

  it('两种形态可逐条混写（用户覆盖层在分节基线上补一条扁平条目）', () => {
    const out = expandAdapterGroupedRecordField(
      base('configs', { 'a.com': { 'a.com.search': entry }, 'b.com.hot': entry }),
      'configs',
    )
    expect(out.errors).toEqual([])
    expect(Object.keys(rawObject(out).configs as object)).toEqual(['a.com.search', 'b.com.hot'])
  })

  it('分节里的 null 保留为删除标记，交给合并逻辑消费', () => {
    const out = expandAdapterGroupedRecordField(base('configs', { 'a.com': { 'a.com.search': null } }), 'configs')
    expect(out.errors).toEqual([])
    expect(rawObject(out).configs).toEqual({ 'a.com.search': null })
  })

  it('既不像条目也不像分节 → 报错，而不是悄悄丢掉', () => {
    // `{ "pattern": [...] }` 是把手写成了 pattern（漏了 s）：不报错的话这条配置会**静默消失**。
    const out = expandAdapterGroupedRecordField(base('configs', { 'a.com.search': { pattern: [] } }), 'configs')
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0]).toContain('neither a config entry')
    expect(out.errors[0]).toContain('configs.a.com.search')
  })

  it('空对象条目报错（说明不了任何事，别猜）', () => {
    const out = expandAdapterGroupedRecordField(base('configs', { 'a.com.search': {} }), 'configs')
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0]).toContain('neither a config entry')
  })

  it('工具名与分节 key 不符 → 报错（同前缀站点也不通用）', () => {
    const bad = expandAdapterGroupedRecordField(base('configs', { 'v2ex.com': { 'a.com.search': entry } }), 'configs')
    expect(bad.errors).toHaveLength(1)
    expect(bad.errors[0]).toContain('belongs to "a.com"')
    expect(bad.errors[0]).toContain('not to section "v2ex.com"')

    const prefix = expandAdapterGroupedRecordField(base('configs', { 'a.com': { 'a.com.cn.t': entry } }), 'configs')
    expect(prefix.errors[0]).toContain('belongs to "a.com.cn"')
  })

  it('同一工具被配了两遍 → 报错（先命中者赢，另一条永远拿不到）', () => {
    const out = expandAdapterGroupedRecordField(
      base('configs', { 'a.com': { 'a.com.search': entry }, 'a.com.other': { 'a.com.search': entry } }),
      'configs',
    )
    expect(out.errors.some((e) => e.includes('configured more than once'))).toBe(true)
  })

  it('分节写到顶层（configs 缺席）必须报错，不能静默当成「本层没配条目」', () => {
    const out = expandAdapterGroupedRecordField({ 'a.com': { 'a.com.search': entry } }, 'configs')
    expect(out.expanded).toBe(false)
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0]).toContain('"configs" is missing')
    expect(out.errors[0]).toContain('one level too high')
  })

  it('顶层元信息键与非法值不会被误判', () => {
    expect(expandAdapterGroupedRecordField({ version: '1', global: {}, configs: {} }, 'configs').errors).toEqual([])
    expect(expandAdapterGroupedRecordField({ configs: 'nope' }, 'configs').errors).toHaveLength(1)
    expect(expandAdapterGroupedRecordField({ a: 1 }, 'configs').errors).toEqual([])
  })
})

// ── loader 端到端：分节形态真正被加载，错位会被拒绝并回退 ────────────────────

const tmpRoots: string[] = []
function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-grouped-'))
  tmpRoots.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tmpRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // 临时目录清理失败不影响结论
    }
  }
})

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never

describe('loader：分节形态的加载与拒绝', () => {
  it('bundled 用分节书写时，条目展开进 bundle', () => {
    const dir = makeDir()
    fs.writeFileSync(
      path.join(dir, 'routes.json'),
      JSON.stringify({
        routes: {
          'news.ycombinator.com': [{ id: 'hn', tool: 'news.ycombinator.com.top', examples: ['hn'] }],
          'v2ex.com': [{ id: 'v2ex', tool: 'v2ex.com.hot', examples: ['v2ex'] }],
        },
      }),
      'utf-8',
    )
    resetRouterConfigCacheForTests()
    const { bundle } = loadRouterConfig({ defaultsDir: dir, userDir: path.join(dir, 'user'), log: silent })
    expect(bundle.routes.routes!.map((entry) => entry.id)).toEqual(['hn', 'v2ex'])
  })

  it('用户层错位 → 该层回退到 bundled，其它层不受影响', () => {
    const defaults = makeDir()
    const user = makeDir()
    fs.writeFileSync(
      path.join(defaults, 'routes.json'),
      JSON.stringify({ routes: [{ id: 'hn', tool: 'news.ycombinator.com.top', examples: ['hn'] }] }),
      'utf-8',
    )
    fs.writeFileSync(
      path.join(user, 'routes.json'),
      JSON.stringify({
        routes: { 'v2ex.com': [{ id: 'hn2', tool: 'news.ycombinator.com.top', examples: ['hn2'] }] },
      }),
      'utf-8',
    )
    resetRouterConfigCacheForTests()
    const { bundle } = loadRouterConfig({ defaultsDir: defaults, userDir: user, log: silent })
    // 用户层被整体拒绝 → 仍是 bundled 的那一份，且没有半截混入
    expect(bundle.routes.routes!.map((entry) => entry.id)).toEqual(['hn'])
  })

  it('用户层分节合法时按 id 覆盖 bundled（合并语义逐字不变）', () => {
    const defaults = makeDir()
    const user = makeDir()
    fs.writeFileSync(
      path.join(defaults, 'routes.json'),
      JSON.stringify({ routes: [{ id: 'hn', tool: 'news.ycombinator.com.top', title: '旧', examples: ['hn'] }] }),
      'utf-8',
    )
    fs.writeFileSync(
      path.join(user, 'routes.json'),
      JSON.stringify({
        routes: {
          'news.ycombinator.com': [{ id: 'hn', tool: 'news.ycombinator.com.top', title: '新', examples: ['hn'] }],
        },
      }),
      'utf-8',
    )
    resetRouterConfigCacheForTests()
    const { bundle } = loadRouterConfig({ defaultsDir: defaults, userDir: user, log: silent })
    expect(bundle.routes.routes!).toHaveLength(1)
    expect(bundle.routes.routes![0]?.title).toBe('新')
  })

  it('patterns 用分节书写时，configs 被展开成「完整工具名 → 配置」', () => {
    const dir = makeDir()
    // 用真实存在且只读可直调的公开工具：作用域过滤会把不存在的工具丢掉，那样测的就不是分节了
    const rule = (term: string) => ({ type: 'keyword', keywords: [term], examples: [`${term} x`] })
    fs.writeFileSync(
      path.join(dir, 'patterns.json'),
      JSON.stringify({
        configs: {
          'wikipedia.org': { 'wikipedia.org.search': { priority: 20, patterns: [rule('查词条甲')] } },
          'news.ycombinator.com': { 'news.ycombinator.com.search': { priority: 10, patterns: [rule('查帖子乙')] } },
        },
      }),
      'utf-8',
    )
    resetRouterConfigCacheForTests()
    const { bundle } = loadRouterConfig({ defaultsDir: dir, userDir: path.join(dir, 'user'), log: silent })
    expect(Object.keys(bundle.patterns.configs!).sort()).toEqual(['news.ycombinator.com.search', 'wikipedia.org.search'])
    expect(bundle.patterns.configs!['wikipedia.org.search']?.priority).toBe(20)
  })

  it('patterns 用户层错位 → 该层回退到 bundled，不半截混入', () => {
    const defaults = makeDir()
    const user = makeDir()
    const rule = (term: string) => ({ type: 'keyword', keywords: [term], examples: [`${term} x`] })
    fs.writeFileSync(
      path.join(defaults, 'patterns.json'),
      JSON.stringify({ configs: { 'wikipedia.org.search': { priority: 20, patterns: [rule('查词条甲')] } } }),
      'utf-8',
    )
    fs.writeFileSync(
      path.join(user, 'patterns.json'),
      JSON.stringify({
        // 把 wikipedia.org 的条目写进了 news.ycombinator.com 的分节
        configs: {
          'news.ycombinator.com': { 'wikipedia.org.search': { priority: 10, patterns: [rule('查词条甲')] } },
        },
      }),
      'utf-8',
    )
    resetRouterConfigCacheForTests()
    const { bundle } = loadRouterConfig({ defaultsDir: defaults, userDir: user, log: silent })
    expect(Object.keys(bundle.patterns.configs!)).toEqual(['wikipedia.org.search'])
    expect(bundle.patterns.configs!['wikipedia.org.search']?.priority).toBe(20)
  })

  it('patterns 用户层分节里的 null 仍然删除该工具（覆盖层语义逐字不变）', () => {
    const defaults = makeDir()
    const user = makeDir()
    const rule = (term: string) => ({ type: 'keyword', keywords: [term], examples: [`${term} x`] })
    fs.writeFileSync(
      path.join(defaults, 'patterns.json'),
      JSON.stringify({
        configs: {
          'wikipedia.org.search': { priority: 20, patterns: [rule('查词条甲')] },
          'wikipedia.org.summary': { priority: 10, patterns: [rule('查简介乙')] },
        },
      }),
      'utf-8',
    )
    fs.writeFileSync(
      path.join(user, 'patterns.json'),
      JSON.stringify({ configs: { 'wikipedia.org': { 'wikipedia.org.summary': null } } }),
      'utf-8',
    )
    resetRouterConfigCacheForTests()
    const { bundle } = loadRouterConfig({ defaultsDir: defaults, userDir: user, log: silent })
    expect(Object.keys(bundle.patterns.configs!)).toEqual(['wikipedia.org.search'])
  })
})
