/**
 * 第4层分流判定矩阵 + 任务事件流映射单测（第15行）。
 *
 * 判定的代价结构：**漏判免费**（落到第3层 = 今天的行为），**误判致命**（把普通聊天转交给
 * 网站探索agent去开浏览器）。所以矩阵的每一格「不该转发」的原因都单独断言。
 * 事件流部分用注入的 fetch stub，不发真实请求、不依赖 8766。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildKnownHosts,
  buildTier4Instruction,
  decideTier4,
  extractUnknownSiteUrl,
  isTier4Enabled,
  runWebwrightTaskTurn,
  tier4TimeoutMs,
} from '../tier4-dispatch.js'
import type { SiteGateResult } from '../site-gate.js'
import type { ParsedAdapter } from '../adapter-parser.js'
import type { FetchLike } from '../webwright-client.js'

const MISS: SiteGateResult = { adapterId: null, reason: 'miss', signals: [] }

function adapter(id: string, match: string[]): ParsedAdapter {
  return {
    id,
    name: id,
    description: '',
    detailDescription: '',
    match,
    gateAliases: [],
    homepageUrl: `https://${match[0]}/`,
    tools: [],
    testPrompts: [],
    requiresAuth: false,
    authCheckTool: null,
    hidden: false,
    defaultEnabled: true,
    registryScenarios: [],
    icon: 'globe',
    promptVarDisplay: {},
  }
}

const ADAPTERS = new Map([
  ['example.com', adapter('example.com', ['example.com'])],
])

beforeEach(() => {
  delete process.env.WEWORKER_TIER4
  delete process.env.WEWORKER_TIER4_TIMEOUT_MS
  delete process.env.WEWORKER_TIER4_ALLOW_WRITES
})

afterEach(() => {
  delete process.env.WEWORKER_TIER4
  delete process.env.WEWORKER_TIER4_TIMEOUT_MS
  delete process.env.WEWORKER_TIER4_ALLOW_WRITES
})

describe('extractUnknownSiteUrl：站点信号提取', () => {
  const known = buildKnownHosts(ADAPTERS)

  it('已注册站点不算未知站点信号（否则每次提到自家站点都会转交）', () => {
    expect(extractUnknownSiteUrl('去 example.com 看看', known)).toBeNull()
  })

  it('未注册域名 → 归一化为含 scheme 的 start_url', () => {
    expect(extractUnknownSiteUrl('帮我看看 shop.example.org 的价格', known)).toBe('https://shop.example.org')
  })

  it('完整 URL 保留路径与 scheme', () => {
    expect(extractUnknownSiteUrl('打开 https://news.example.org/a/b?c=1 看看', known)).toBe(
      'https://news.example.org/a/b?c=1',
    )
  })

  it('中文标点紧贴域名时被剥掉（否则 URL 会带上「，」而 404）', () => {
    expect(extractUnknownSiteUrl('看看 shop.example.org，然后告诉我', known)).toBe('https://shop.example.org')
  })

  it('文件扩展名 TLD 不算站点信号（防「下载 v1.2.zip」误判）', () => {
    expect(extractUnknownSiteUrl('帮我下载 report.pdf', known)).toBeNull()
    expect(extractUnknownSiteUrl('这个 v1.2.zip 解不开', known)).toBeNull()
  })

  it('未知域名的优先级按出现顺序，取第一个', () => {
    expect(extractUnknownSiteUrl('先 a.example.org 再 b.example.org', known)).toBe('https://a.example.org')
  })

  it('只认消息里的**第一个**站点信号：首个是已知站点即视为「用户在说这个站点」，不转发', () => {
    // 这条是「首信号优先」的**刻意**口径，不是漏网：考虑后续域名会扩大第4层转发面，
    // 而多站点并提时首个才是用户当下指向的那个（代价是漏判，属设计允许的方向）。
    expect(extractUnknownSiteUrl('example.com 和 shop.example.org', known)).toBeNull()
  })

  it('纯中文、无域名 → null', () => {
    expect(extractUnknownSiteUrl('帮我把这件事记下来', known)).toBeNull()
  })
})

describe('decideTier4：分流判定矩阵', () => {
  it('急停 WEWORKER_TIER4=0 → 不转发（即使其它条件全部成立）', () => {
    process.env.WEWORKER_TIER4 = '0'
    expect(isTier4Enabled()).toBe(false)
    expect(decideTier4('看看 shop.example.org', MISS, ADAPTERS)).toEqual({
      dispatch: false,
      startUrl: null,
      reason: 'env-off',
    })
  })

  it('siteGate 已命中唯一站点 → 不转发（那一轮走第3层预注入）', () => {
    const hit: SiteGateResult = { adapterId: 'example.com', reason: 'hit-domain', signals: ['example.com'] }
    expect(decideTier4('example.com 和 shop.example.org', hit, ADAPTERS)).toEqual({
      dispatch: false,
      startUrl: null,
      reason: 'sitegate-hit-domain',
    })
  })

  it('siteGate 歧义 → 不转发（歧义时连第3层预注入都没做，更不该转交第4层）', () => {
    const ambiguous: SiteGateResult = { adapterId: null, reason: 'ambiguous', signals: ['a(b)', 'c(d)'] }
    expect(decideTier4('随便', ambiguous, ADAPTERS).reason).toBe('sitegate-ambiguous')
  })

  it('siteGate 被急停关掉 → 不转发（不能绕过第3层开关）', () => {
    const disabled: SiteGateResult = { adapterId: null, reason: 'disabled', signals: [] }
    expect(decideTier4('看看 shop.example.org', disabled, ADAPTERS).reason).toBe('sitegate-disabled')
  })

  it('miss 但没有未知站点信号 → 不转发', () => {
    expect(decideTier4('帮我写个周报', MISS, ADAPTERS)).toEqual({
      dispatch: false,
      startUrl: null,
      reason: 'no-unknown-site-signal',
    })
  })

  it('miss + 未注册站点 URL → 转发，并带上 startUrl', () => {
    expect(decideTier4('帮我去 shop.example.org 查一下价格', MISS, ADAPTERS)).toEqual({
      dispatch: true,
      startUrl: 'https://shop.example.org',
      reason: 'unknown-site',
    })
  })

  it('用户禁用的站点不得绕道第4层复活（已知站点集合含禁用项）', () => {
    expect(decideTier4('看看 example.com', MISS, ADAPTERS).dispatch).toBe(false)
  })
})

describe('tier4TimeoutMs', () => {
  it('默认 10 分钟', () => {
    expect(tier4TimeoutMs()).toBe(600_000)
  })

  it('低于 30 秒的注入被忽略（避免测试误配把生产回合秒杀）', () => {
    process.env.WEWORKER_TIER4_TIMEOUT_MS = '1000'
    expect(tier4TimeoutMs()).toBe(600_000)
  })

  it('合法注入生效', () => {
    process.env.WEWORKER_TIER4_TIMEOUT_MS = '120000'
    expect(tier4TimeoutMs()).toBe(120_000)
  })

  it('非法值回默认', () => {
    process.env.WEWORKER_TIER4_TIMEOUT_MS = 'abc'
    expect(tier4TimeoutMs()).toBe(600_000)
  })
})

describe('buildTier4Instruction：只读护栏', () => {
  it('默认追加只读护栏（第4层是自动转交，写入必须交回用户）', () => {
    expect(buildTier4Instruction('去下单')).toContain('不要执行提交、下单、发送、删除等写入操作')
  })

  it('WEWORKER_TIER4_ALLOW_WRITES=1 时原样透传', () => {
    process.env.WEWORKER_TIER4_ALLOW_WRITES = '1'
    expect(buildTier4Instruction('去下单')).toBe('去下单')
  })
})

// ─── 事件流映射（注入 fetch stub）────────────────────────────────────────────

const enc = new TextEncoder()

function sseBody(frames: string[][]): AsyncIterable<Uint8Array> {
  const text = frames.map(([event, data]) => `event: ${event}\ndata: ${data}\n\n`).join('')
  return (async function* () {
    yield enc.encode(text)
  })()
}

function stubFetch(options: {
  taskView?: Record<string, unknown>
  frames?: string[][]
  eventsStatus?: number
}): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = []
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url)
    if (url.endsWith('/events')) {
      const status = options.eventsStatus ?? 200
      return {
        ok: status === 200,
        status,
        json: async () => ({}),
        body: status === 200 ? sseBody(options.frames ?? []) : null,
      }
    }
    return { ok: true, status: 200, json: async () => options.taskView ?? {} }
  }
  return { fetchImpl, calls }
}

async function collect(gen: AsyncGenerator<{ type: string; content?: string }>): Promise<string> {
  let text = ''
  for await (const ev of gen) text += ev.content ?? ''
  return text
}

describe('runWebwrightTaskTurn：任务事件 → chat SSEEvent', () => {
  it('成功路径：task_started → step_finished → task_succeeded 带出 final_response', async () => {
    const { fetchImpl } = stubFetch({
      taskView: { task_id: 't1', status: 'succeeded', current_step: 4, final_response: '价格是 ¥99' },
      frames: [
        ['task_started', '{}'],
        ['step_finished', '{"step":1}'],
        ['step_finished', '{"step":2}'],
        ['task_succeeded', '{}'],
      ],
    })
    const text = await collect(
      runWebwrightTaskTurn({ taskId: 't1', startUrl: 'https://shop.example.org', deps: { fetchImpl } }),
    )
    expect(text).toContain('转交网站探索agent执行本次请求')
    expect(text).toContain('[执行] 浏览器已启动')
    expect(text).toContain('[执行] 步骤 2 完成')
    expect(text).toContain('价格是 ¥99')
    expect(text).toContain('共 4 步')
  })

  it('重复/回退的 step 号不重复播报步骤', async () => {
    const { fetchImpl } = stubFetch({
      taskView: { task_id: 't1', status: 'succeeded', current_step: 2, final_response: 'ok' },
      frames: [['step_finished', '{"step":1}'], ['step_finished', '{"step":1}'], ['task_succeeded', '{}']],
    })
    const text = await collect(
      runWebwrightTaskTurn({ taskId: 't1', startUrl: 'https://shop.example.org', deps: { fetchImpl } }),
    )
    expect(text.match(/步骤 1 完成/g)).toHaveLength(1)
  })

  it('waiting_for_user → 暂停提示并结束本轮（不是错误）', async () => {
    const { fetchImpl } = stubFetch({ frames: [['waiting_for_user', '{}']] })
    const text = await collect(
      runWebwrightTaskTurn({ taskId: 't1', startUrl: 'https://shop.example.org', deps: { fetchImpl } }),
    )
    expect(text).toContain('任务已暂停，等待人工接管')
    expect(text).not.toContain('任务未完成')
  })

  it('task_failed → 带出任务 error 文案', async () => {
    const { fetchImpl } = stubFetch({
      taskView: { task_id: 't1', status: 'failed', error: '登录态失效' },
      frames: [['task_failed', '{}']],
    })
    const text = await collect(
      runWebwrightTaskTurn({ taskId: 't1', startUrl: 'https://shop.example.org', deps: { fetchImpl } }),
    )
    expect(text).toContain('任务未完成（登录态失效）')
  })

  it('事件流打开失败 → 提示并请求取消', async () => {
    const { fetchImpl, calls } = stubFetch({ eventsStatus: 500 })
    const text = await collect(
      runWebwrightTaskTurn({ taskId: 't1', startUrl: 'https://shop.example.org', deps: { fetchImpl } }),
    )
    expect(text).toContain('任务事件流打开失败（events-http-500），已取消本次任务')
    expect(calls.some((url) => url.endsWith('/api/tasks/t1/cancel'))).toBe(true)
  })

  it('事件流意外关闭且未收到停态 → 拉一次任务视图定性并按状态收尾', async () => {
    const { fetchImpl } = stubFetch({
      taskView: { task_id: 't1', status: 'succeeded', final_response: 'done' },
      frames: [['step_finished', '{"step":1}']],
    })
    const text = await collect(
      runWebwrightTaskTurn({ taskId: 't1', startUrl: 'https://shop.example.org', deps: { fetchImpl } }),
    )
    expect(text).toContain('done')
  })

  it('超时 → 请求取消并提示时限', async () => {
    process.env.WEWORKER_TIER4_TIMEOUT_MS = '30000'
    let clock = 0
    const { fetchImpl, calls } = stubFetch({
      frames: [['task_started', '{}'], ['step_finished', '{"step":1}']],
    })
    const text = await collect(
      runWebwrightTaskTurn({
        taskId: 't1',
        startUrl: 'https://shop.example.org',
        deps: { fetchImpl },
        // 每次取时推进超过 30s，触发第二次循环的超时分支。
        now: () => (clock += 20_000),
      }),
    )
    expect(text).toContain('任务超过时限（1 分钟），已请求取消')
    expect(calls.some((url) => url.endsWith('/api/tasks/t1/cancel'))).toBe(true)
  })

  it('用户中止 → 静默结束且尽力取消远端任务', async () => {
    const controller = new AbortController()
    controller.abort()
    const { fetchImpl, calls } = stubFetch({ frames: [['task_started', '{}']] })
    const text = await collect(
      runWebwrightTaskTurn({
        taskId: 't1',
        startUrl: 'https://shop.example.org',
        abortSignal: controller.signal,
        deps: { fetchImpl },
      }),
    )
    expect(text).not.toContain('[执行] 浏览器已启动')
    expect(calls.some((url) => url.endsWith('/api/tasks/t1/cancel'))).toBe(true)
  })

  it('入口链接独立成行（URL 不与中文相邻，否则被链接器吞成 404）', async () => {
    const { fetchImpl } = stubFetch({
      taskView: { task_id: 't1', status: 'succeeded', final_response: 'x' },
      frames: [['task_succeeded', '{}']],
    })
    const text = await collect(
      runWebwrightTaskTurn({ taskId: 't1', startUrl: 'https://shop.example.org', deps: { fetchImpl } }),
    )
    expect(text).toContain('\nhttp://127.0.0.1:8766/ui\n')
  })
})

it('keeps explicit WebCLI exploration in chat with Tier4 enabled',()=>{
 for(const message of ['使用webcli的api探索工具 https://unknown.example.org','use WebCLI to explore https://unknown.example.org','使用 exploration.start 探索 https://unknown.example.org'])
 expect(decideTier4(message,MISS,ADAPTERS)).toMatchObject({dispatch:false,reason:'explicit-webcli'});
 expect(decideTier4('探索 https://unknown.example.org',MISS,ADAPTERS).dispatch).toBe(true);
});
