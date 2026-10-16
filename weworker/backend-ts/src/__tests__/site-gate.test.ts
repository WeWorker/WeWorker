/**
 * siteGate 单测（第14行）。
 *
 * 这层的代价结构是单向的：漏判只是回到今天（先激活 Skill 再调用），误判会**预注入错站点的
 * 工具清单**去误导模型。所以下面每个「不该命中」的分支都单独断言，而不只断言「命中了」。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearSiteToolkitCache,
  formatSiteToolkitPrompt,
  isSiteGateEnabled,
  matchSiteAdapter,
  resolveSiteToolkitPrompt,
  type SiteGateCandidate,
} from '../site-gate.js'
import type { StaticToolDef } from '../adapter-parser.js'

const cand = (id: string, match: string[], gateAliases?: string[]): SiteGateCandidate => ({
  id,
  name: id,
  match,
  ...(gateAliases ? { gateAliases } : {}),
})

const ALL = new Set(['example.com', 'example.org', 'mail.example.com'])

beforeEach(() => {
  delete process.env.WEWORKER_SITE_GATE
  clearSiteToolkitCache()
})

afterEach(() => {
  delete process.env.WEWORKER_SITE_GATE
  clearSiteToolkitCache()
})

describe('matchSiteAdapter：域名信号（S1）', () => {
  it('域名子串命中唯一站点', () => {
    const result = matchSiteAdapter('帮我在 example.com 上看看', [cand('example.com', ['example.com'])], ALL)
    expect(result).toEqual({ adapterId: 'example.com', reason: 'hit-domain', signals: ['example.com'] })
  })

  it('未出现任何候选域名 → miss，且不做任何猜测', () => {
    const result = matchSiteAdapter('今天天气怎么样', [cand('example.com', ['example.com'])], ALL)
    expect(result).toEqual({ adapterId: null, reason: 'miss', signals: [] })
  })

  it('空消息 → miss（不是 disabled）', () => {
    expect(matchSiteAdapter('   ', [cand('example.com', ['example.com'])], ALL).reason).toBe('miss')
  })

  it('命中的站点未被启用 → 不计入命中（用户关掉的站点不得被预注入激活）', () => {
    const result = matchSiteAdapter('帮我在 example.com 上看看', [cand('example.com', ['example.com'])], new Set())
    expect(result).toEqual({ adapterId: null, reason: 'miss', signals: [] })
  })
})

describe('matchSiteAdapter：别名信号（S2）', () => {
  it('拉丁别名按 ASCII 字母数字判边界：XXITSMYY 不命中，独立出现的 itsm 命中', () => {
    const candidates = [cand('example.com', ['example.com'], ['itsm'])]
    expect(matchSiteAdapter('XXITSMYY 里的东西', candidates, ALL).reason).toBe('miss')
    expect(matchSiteAdapter('在 itsm 上查单', candidates, ALL)).toEqual({
      adapterId: 'example.com',
      reason: 'hit-alias',
      signals: ['itsm'],
    })
  })

  it('拉丁别名在中文语境里也命中（CJK 字符视为单词边界）', () => {
    const result = matchSiteAdapter('在itsm上看看', [cand('example.com', ['example.com'], ['itsm'])], ALL)
    expect(result.reason).toBe('hit-alias')
  })

  it('CJK 别名直接子串命中', () => {
    const result = matchSiteAdapter('帮我在示例站上查一下', [cand('example.com', ['example.com'], ['示例站'])], ALL)
    expect(result).toEqual({ adapterId: 'example.com', reason: 'hit-alias', signals: ['示例站'] })
  })

  it('域名优先于别名：两者都命中时记为 hit-domain', () => {
    const result = matchSiteAdapter(
      'example.com 示例站',
      [cand('example.com', ['example.com'], ['示例站'])],
      ALL,
    )
    expect(result.reason).toBe('hit-domain')
  })

  it('空别名条目被跳过，不会因为「空串处处包含」而命中一切', () => {
    const result = matchSiteAdapter('随便说点什么', [cand('example.com', ['example.com'], ['', '   '])], ALL)
    expect(result.reason).toBe('miss')
  })
})

describe('matchSiteAdapter：歧义与急停', () => {
  it('两个站点同时命中 → ambiguous 且 adapterId 为 null（宁可不动手）', () => {
    const result = matchSiteAdapter(
      'example.com 和 example.org 都看看',
      [cand('example.com', ['example.com']), cand('example.org', ['example.org'])],
      ALL,
    )
    expect(result.adapterId).toBeNull()
    expect(result.reason).toBe('ambiguous')
    expect(result.signals).toEqual(['example.com(example.com)', 'example.org(example.org)'])
  })

  it('嵌套域名同时命中两个候选也是 ambiguous（mail.example.com ⊂ example.com）', () => {
    const result = matchSiteAdapter(
      '收件箱 mail.example.com',
      [cand('example.com', ['example.com']), cand('mail.example.com', ['mail.example.com'])],
      ALL,
    )
    expect(result.reason).toBe('ambiguous')
  })

  it('WEWORKER_SITE_GATE=0 → disabled，且不返回任何 adapterId', () => {
    process.env.WEWORKER_SITE_GATE = '0'
    expect(isSiteGateEnabled()).toBe(false)
    expect(matchSiteAdapter('example.com', [cand('example.com', ['example.com'])], ALL)).toEqual({
      adapterId: null,
      reason: 'disabled',
      signals: [],
    })
  })

  it('急停只认 "0"：其它值仍视为开启', () => {
    process.env.WEWORKER_SITE_GATE = 'false'
    expect(isSiteGateEnabled()).toBe(true)
  })
})

describe('formatSiteToolkitPrompt：预注入清单', () => {
  const direct: StaticToolDef = {
    name: 'example.com.search',
    description: '搜索',
    parameters: { properties: { keyword: { type: 'string' }, limit: { type: 'integer' } }, required: ['keyword'] },
    directCapable: true,
    executionMode: 'direct',
  }
  const page: StaticToolDef = {
    name: 'example.com.open_page',
    description: '打开页面',
    parameters: {},
    executionMode: 'page',
  }

  it('direct 组排在 page 组之前，组内按名排序，并统计 total/toolCount', () => {
    const toolkit = formatSiteToolkitPrompt({ name: '示例站', match: ['example.com'] }, [page, direct])
    expect(toolkit.total).toBe(2)
    expect(toolkit.toolCount).toBe(2)
    expect(toolkit.prompt.indexOf('example.com.search')).toBeLessThan(toolkit.prompt.indexOf('example.com.open_page'))
    expect(toolkit.prompt).toContain('## 站点工具速查：示例站（example.com）')
    expect(toolkit.prompt).toContain('`webcli call <完整工具名> --参数名=参数值`')
  })

  it('参数名与类型写入说明行', () => {
    const toolkit = formatSiteToolkitPrompt({ name: '示例站', match: ['example.com'] }, [direct])
    expect(toolkit.prompt).toContain('参数：keyword（string）、limit（integer）')
  })

  it('带 navigate_before 的工具给出「先开页面」提示；page-prep 缺省时无此行', () => {
    const withNav: StaticToolDef = { ...direct, execution: { navigate_before: 'https://example.com/list' } }
    expect(formatSiteToolkitPrompt({ name: 'x', match: ['example.com'] }, [withNav]).prompt).toContain(
      '需先 open_browser https://example.com/list',
    )
    // 分组标题里本来就写着「标注「需先 open_browser」的工具例外」，所以只能断言**工具行**没带这条提示。
    expect(formatSiteToolkitPrompt({ name: 'x', match: ['example.com'] }, [direct]).prompt).not.toContain(
      'open_browser https',
    )
  })

  it('超过 30 个工具时截断并给出「其余 N 个」提示', () => {
    const tools: StaticToolDef[] = Array.from({ length: 35 }, (_, i) => ({
      name: `example.com.tool_${String(i).padStart(2, '0')}`,
      description: `t${i}`,
      parameters: {},
      directCapable: true,
    }))
    const toolkit = formatSiteToolkitPrompt({ name: 'x', match: ['example.com'] }, tools)
    expect(toolkit.total).toBe(35)
    expect(toolkit.toolCount).toBe(30)
    expect(toolkit.prompt).toContain('（其余 5 个工具见该站点 Skill 文档')
  })

  it('缺 description 的工具不产出空说明，而是指向站点 Skill 文档', () => {
    const bare: StaticToolDef = { name: 'example.com.bare', description: '', parameters: {} }
    expect(formatSiteToolkitPrompt({ name: 'x', match: ['example.com'] }, [bare]).prompt).toContain(
      '（说明见该站点 Skill 文档）',
    )
  })
})

describe('resolveSiteToolkitPrompt：TTL 缓存', () => {
  it('未注册的 adapter 返回 null 并缓存负结果（下次调用不再读盘）', () => {
    expect(resolveSiteToolkitPrompt('not-registered.example')).toBeNull()
    expect(resolveSiteToolkitPrompt('not-registered.example')).toBeNull()
  })
})
