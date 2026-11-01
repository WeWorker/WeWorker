/**
 * 第 4 层决策矩阵：触发契约 × 站点覆盖 × 急停 × 回滚。
 *
 * 这张矩阵是这次改动的验收主体。两个不变量：
 *   ① 不是显式探索指令 → 一定不转交（普通对话贴链接属于此类）；
 *   ② 站点已被 adapter / 探索固化的 toolkit 覆盖 → 一定不转交（重探会覆盖已有工具）。
 * `!explore` 是唯一豁免 ② 的入口，且必须由用户亲手写出。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { SiteGateResult } from '../site-gate.js'
import {
  collectSiteCoverage,
  isHostCovered,
  siteKey,
} from '../exploration-coverage.js'
import {
  decideExplorationDispatch,
  type ExplorationDispatchInput,
} from '../tier4-dispatch.js'
import {
  EXPLORATION_PROVIDERS,
  validateExplorationProviders,
  type ExplorationProvider,
} from '../exploration-providers.js'

const MISS: SiteGateResult = { adapterId: null, reason: 'miss', signals: [] }
const HIT: SiteGateResult = { adapterId: 'known.example.com', reason: 'hit-domain', signals: ['example.com'] }

function decide(overrides: Partial<ExplorationDispatchInput> & { message: string }) {
  return decideExplorationDispatch({
    siteGate: MISS,
    coverage: { hosts: new Map() },
    env: {},
    ...overrides,
  })
}

const ADAPTERS = [
  { match: ['Example.COM', 'www.shop.example.org'] },
  { match: ['*.wild.example.net'] },
  { match: ['https://with.scheme.example.io/base'] },
]
const TOOLKITS = [{ hosts: ['Toolkit.Example.CN'] }]

describe('站点覆盖集', () => {
  it('siteKey 归一化：大小写、端口、www、通配、scheme 一律抹平', () => {
    expect(siteKey('Example.COM')).toBe('example.com')
    expect(siteKey('www.example.com:8443')).toBe('example.com')
    expect(siteKey('https://www.Example.com/a?b=1')).toBe('example.com')
    expect(siteKey('*.example.com')).toBe('example.com')
    expect(siteKey('')).toBe('')
  })

  it('adapter 与 toolkit 都进入覆盖集', () => {
    const coverage = collectSiteCoverage({ adapters: ADAPTERS, toolkitSkills: TOOLKITS })
    expect(coverage.hosts.get('example.com')).toContain('adapter')
    expect(coverage.hosts.get('toolkit.example.cn')).toContain('toolkit')
  })

  it('子域、父域、www 互相视为已覆盖（宁可漏判，不可重复探索）', () => {
    const coverage = collectSiteCoverage({ adapters: ADAPTERS, toolkitSkills: TOOLKITS })
    expect(isHostCovered('https://shop.example.com/a', coverage).covered).toBe(true) // 子域
    expect(isHostCovered('https://www.example.com/a', coverage).covered).toBe(true) // www
    expect(isHostCovered('https://example.com', coverage).covered).toBe(true) // 恰好命中
    // 覆盖项是子域（`shop.example.org`）时，父域也算已覆盖：用户十有八九指的是同一站点。
    expect(isHostCovered('https://example.org', coverage)).toEqual({ covered: true, by: 'adapter' })
    expect(isHostCovered('https://unrelated.test/a', coverage).covered).toBe(false) // 无关域名
  })

  it('通配 match 与带 scheme 的 match 也能覆盖（旧实现会静默丢弃）', () => {
    const coverage = collectSiteCoverage({ adapters: ADAPTERS })
    expect(isHostCovered('https://a.b.wild.example.net/x', coverage).by).toBe('adapter')
    expect(isHostCovered('https://with.scheme.example.io/base/deep', coverage).by).toBe('adapter')
  })

  it('探索固化的 toolkit 站点被识别为已覆盖', () => {
    const coverage = collectSiteCoverage({ toolkitSkills: TOOLKITS })
    expect(isHostCovered('https://www.toolkit.example.cn/x', coverage)).toEqual({ covered: true, by: 'toolkit' })
  })
})

describe('严格模式：只有显式接口才转交', () => {
  it('命中并抽出问题正文', () => {
    expect(decide({ message: '网站 https://new.example.org/a 直接查询：价格' })).toMatchObject({
      dispatch: true,
      providerId: 'webwright',
      startUrl: 'https://new.example.org/a',
      query: '价格',
      force: false,
      reason: 'explicit-trigger',
    })
  })

  it('普通对话里贴未注册链接：不转交（旧行为会整轮顶掉）', () => {
    expect(decide({ message: '帮我看看 https://new.example.org/a 有什么' })).toMatchObject({
      dispatch: false,
      reason: 'not-site-command',
    })
  })

  it('站点已被 adapter 覆盖：不转交', () => {
    const coverage = collectSiteCoverage({ adapters: ADAPTERS })
    expect(decide({ message: '网站 https://www.example.com/a 直接查询：价格', coverage })).toMatchObject({
      dispatch: false,
      reason: 'covered-by-adapter',
    })
  })

  it('站点已被探索固化的 toolkit 覆盖：不转交', () => {
    const coverage = collectSiteCoverage({ toolkitSkills: TOOLKITS })
    expect(decide({ message: '网站 https://toolkit.example.cn/a 直接查询：价格', coverage })).toMatchObject({
      dispatch: false,
      reason: 'covered-by-toolkit',
    })
  })

  it('siteGate 已命中站点：不转交（确定性层优先）', () => {
    expect(decide({ message: '网站 https://new.example.org/a 直接查询：价格', siteGate: HIT })).toMatchObject({
      dispatch: false,
      reason: 'sitegate-hit-domain',
    })
  })

  it('URL 边界残片：不转交，且给出专用原因', () => {
    expect(decide({ message: '网站 http://example.org/查询公告 直接查询：标题' })).toMatchObject({
      dispatch: false,
      reason: 'ambiguous-url-boundary',
    })
  })

  it('急停 WEWORKER_TIER4=0 仍优先于触发契约', () => {
    expect(
      decide({ message: '网站 https://new.example.org/a 直接查询：价格', env: { WEWORKER_TIER4: '0' } }),
    ).toMatchObject({ dispatch: false, reason: 'env-off' })
  })
})

describe('强制档 !explore', () => {
  it('跳过覆盖校验，仍带 force 标记', () => {
    const coverage = collectSiteCoverage({ adapters: ADAPTERS, toolkitSkills: TOOLKITS })
    expect(decide({ message: '!explore https://www.example.com/a 价格', coverage })).toMatchObject({
      dispatch: true,
      force: true,
      reason: 'force-trigger',
      startUrl: 'https://www.example.com/a',
      query: '价格',
    })
  })

  it('仍然受总急停约束', () => {
    expect(
      decide({ message: '!explore https://www.example.com/a 价格', env: { WEWORKER_TIER4: '0' } }),
    ).toMatchObject({ dispatch: false, reason: 'env-off' })
  })
})

describe('回滚路径 legacy（改动前的启发式）', () => {
  it('未注册链接照旧转交，且整条消息作为指令', () => {
    expect(
      decide({ message: '帮我看看 https://new.example.org/a 有什么', mode: 'legacy' }),
    ).toMatchObject({
      dispatch: true,
      reason: 'legacy-unknown-site',
      startUrl: 'https://new.example.org/a',
      query: '帮我看看 https://new.example.org/a 有什么',
    })
  })

  it('已注册 host 不转交', () => {
    expect(
      decide({
        message: '帮我看看 https://example.com/a 有什么',
        mode: 'legacy',
        knownHosts: new Set(['example.com']),
      }),
    ).toMatchObject({ dispatch: false, reason: 'no-unknown-site-signal' })
  })

  it('legacy 下中文同样不再进 URL', () => {
    expect(decide({ message: '看看 http://example.org/查询公告', mode: 'legacy' }).startUrl).toBe(
      'http://example.org/',
    )
  })
})

describe('探索工具注册表：互斥是硬约束', () => {
  it('随包默认表通过自检', () => {
    expect(validateExplorationProviders()).toEqual([])
  })

  it('两个 provider 认同一句话 → 报错（后接入的工具不得吃掉前一个）', () => {
    const intruder: ExplorationProvider = {
      ...EXPLORATION_PROVIDERS[0],
      id: 'intruder',
      priority: 100,
      killSwitchEnv: 'WEWORKER_INTRUDER',
      dispatch: 'webwright-task',
    }
    const errors = validateExplorationProviders([EXPLORATION_PROVIDERS[0], intruder])
    expect(errors.some((error) => error.includes('触发式重叠'))).toBe(true)
    expect(errors.some((error) => error.includes('priority'))).toBe(true)
  })

  it('缺 examples / negativeExamples / 急停开关 → 报错', () => {
    const broken: ExplorationProvider = {
      id: 'broken',
      enabled: true,
      priority: 7,
      trigger: { siteTokens: ['网站'], queryTokens: ['直接查询'], allowBang: true },
      killSwitchEnv: '',
      dispatch: 'webwright-task',
      examples: [],
      negativeExamples: [],
    }
    const errors = validateExplorationProviders([broken])
    expect(errors.some((error) => error.includes('examples'))).toBe(true)
    expect(errors.some((error) => error.includes('negativeExamples'))).toBe(true)
    expect(errors.some((error) => error.includes('急停'))).toBe(true)
  })
})

describe('第 4 层接线（架构守卫）', () => {
  // 判定再完善，没接到 /chat 上也等于没改——旧版本就是「模块 + 测试都在，运行时仍在跑启发式」。
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const server = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8')

  it('server 用 decideExplorationDispatch，不再直接调用旧的 decideTier4', () => {
    expect(server).toContain('decideExplorationDispatch({')
    expect(server).not.toContain('decideTier4(')
  })

  it('接线同时看 adapter 与 toolkit 覆盖，并把解析出的 query 交给执行器', () => {
    expect(server).toContain('collectSiteCoverage({ adapters: allAdapters.values(), toolkitSkills })')
    expect(server).toContain('message: exploration.query ?? message')
    expect(server).toContain('startUrl: exploration.startUrl')
  })
})
