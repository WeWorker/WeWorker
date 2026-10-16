/**
 * page-prep 单测（第17行）。
 *
 * 这层的失败方向必须单向：页面准备只允许「少等」或「不等」，绝不允许把主调用**拖慢或打挂**。
 * 所以每个异常分支都断言「仍然 prepared、仍按预算等待、主调用不受影响」。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  _resetPagePrepCacheForTests,
  _setPagePrepUrlsForTests,
  isPagePrepEnabled,
  navigateBeforeUrls,
  pagePrepareWaitMs,
  runPagePrep,
  type PagePrepDispatch,
} from '../page-prep.js'

const URL_MAP = new Map([['example.com.list', 'https://example.com/list']])

function dispatcher(response: string | Error): { dispatch: PagePrepDispatch; calls: Array<[string, string, string]> } {
  const calls: Array<[string, string, string]> = []
  const dispatch: PagePrepDispatch = async (tool, argsJson, workId) => {
    calls.push([tool, argsJson, workId])
    if (response instanceof Error) throw response
    return response
  }
  return { dispatch, calls }
}

const noSleep = async () => {}

beforeEach(() => {
  delete process.env.WEWORKER_PAGE_PREP
  delete process.env.WEWORKER_PAGE_PREP_WAIT_MS
  _setPagePrepUrlsForTests(URL_MAP)
})

afterEach(() => {
  delete process.env.WEWORKER_PAGE_PREP
  delete process.env.WEWORKER_PAGE_PREP_WAIT_MS
  _resetPagePrepCacheForTests()
})

describe('pagePrepareWaitMs', () => {
  it('默认 5000（对齐第3层「至少 5 秒」约定）', () => {
    expect(pagePrepareWaitMs()).toBe(5000)
  })

  it('非法值回默认，负数归 0', () => {
    process.env.WEWORKER_PAGE_PREP_WAIT_MS = 'abc'
    expect(pagePrepareWaitMs()).toBe(5000)
    process.env.WEWORKER_PAGE_PREP_WAIT_MS = '-500'
    expect(pagePrepareWaitMs()).toBe(0)
  })

  it('合法注入生效（含 0）', () => {
    process.env.WEWORKER_PAGE_PREP_WAIT_MS = '1200'
    expect(pagePrepareWaitMs()).toBe(1200)
    process.env.WEWORKER_PAGE_PREP_WAIT_MS = '0'
    expect(pagePrepareWaitMs()).toBe(0)
  })
})

describe('isPagePrepEnabled', () => {
  it('默认开启；只有 "0" 关闭', () => {
    expect(isPagePrepEnabled()).toBe(true)
    process.env.WEWORKER_PAGE_PREP = '0'
    expect(isPagePrepEnabled()).toBe(false)
    process.env.WEWORKER_PAGE_PREP = 'false'
    expect(isPagePrepEnabled()).toBe(true)
  })
})

describe('navigateBeforeUrls', () => {
  it('注入的表原样返回（测试钩子绕过 catalog 读盘）', () => {
    expect(navigateBeforeUrls().get('example.com.list')).toBe('https://example.com/list')
  })

  it('注入 null → 空表（模拟「目录里没有任何 navigate_before」）', () => {
    _setPagePrepUrlsForTests(null)
    expect(navigateBeforeUrls().size).toBe(0)
  })
})

describe('runPagePrep：不该动手的情况', () => {
  it('急停 WEWORKER_PAGE_PREP=0 → 不准备、不派发', async () => {
    process.env.WEWORKER_PAGE_PREP = '0'
    const { dispatch, calls } = dispatcher('{}')
    expect(await runPagePrep('example.com.list', dispatch, 'w1')).toEqual({
      prepared: false,
      url: '',
      ms: 0,
      toolsReady: false,
    })
    expect(calls).toEqual([])
  })

  it('工具没有 navigate_before → 零行为变化（回到今天盲调）', async () => {
    const { dispatch, calls } = dispatcher('{}')
    expect(await runPagePrep('example.com.other', dispatch, 'w1')).toEqual({
      prepared: false,
      url: '',
      ms: 0,
      toolsReady: false,
    })
    expect(calls).toEqual([])
  })
})

describe('runPagePrep：等待语义', () => {
  it('toolsReady=true → 零等待（bridge 已确认工具就绪）', async () => {
    const waits: number[] = []
    const { dispatch, calls } = dispatcher(JSON.stringify({ toolsReady: true, waitedMs: 120 }))
    const result = await runPagePrep('example.com.list', dispatch, 'w1', {
      waitMs: 5000,
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    expect(result).toEqual({ prepared: true, url: 'https://example.com/list', ms: expect.any(Number), toolsReady: true })
    expect(waits).toEqual([])
    expect(calls).toEqual([['open_browser', JSON.stringify({ url: 'https://example.com/list' }), 'w1']])
  })

  it('bridge 已等过 waitedMs → 只补残余，不叠等', async () => {
    const waits: number[] = []
    const { dispatch } = dispatcher(JSON.stringify({ toolsReady: false, waitedMs: 4000 }))
    await runPagePrep('example.com.list', dispatch, 'w1', {
      waitMs: 5000,
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    expect(waits).toEqual([1000])
  })

  it('waitedMs 超过预算 → 残余归 0（不做负数等待）', async () => {
    const waits: number[] = []
    const { dispatch } = dispatcher(JSON.stringify({ waitedMs: 90_000 }))
    await runPagePrep('example.com.list', dispatch, 'w1', {
      waitMs: 5000,
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    expect(waits).toEqual([])
  })

  it('响应无字段（旧 bridge / 系统命令路径）→ 全额固定等待', async () => {
    const waits: number[] = []
    const { dispatch } = dispatcher('{}')
    await runPagePrep('example.com.list', dispatch, 'w1', {
      waitMs: 5000,
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    expect(waits).toEqual([5000])
  })

  it('响应不是 JSON（旧 bridge 纯文本）→ 全额固定等待，且不抛', async () => {
    const waits: number[] = []
    const { dispatch } = dispatcher('opened: https://example.com/list')
    const result = await runPagePrep('example.com.list', dispatch, 'w1', {
      waitMs: 3000,
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    expect(result.prepared).toBe(true)
    expect(result.toolsReady).toBe(false)
    expect(waits).toEqual([3000])
  })

  it('waitedMs 非法（NaN / 字符串 / 负数）→ 视为无信号，全额等待', async () => {
    for (const waitedMs of [Number.NaN, '4000', -1]) {
      const waits: number[] = []
      const { dispatch } = dispatcher(JSON.stringify({ waitedMs }))
      await runPagePrep('example.com.list', dispatch, 'w1', {
        waitMs: 2000,
        sleep: async (ms) => {
          waits.push(ms)
        },
      })
      expect(waits).toEqual([2000])
    }
  })

  it('open_browser 抛错 → best-effort：仍返回 prepared，仍按预算等待，不把异常抛给主调用', async () => {
    const waits: number[] = []
    const { dispatch } = dispatcher(new Error('bridge down'))
    const result = await runPagePrep('example.com.list', dispatch, 'w1', {
      waitMs: 5000,
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    expect(result).toMatchObject({ prepared: true, url: 'https://example.com/list', toolsReady: false })
    expect(waits).toEqual([5000])
  })

  it('预算为 0 且无就绪信号 → 不调用 sleep（零等待但不假装就绪）', async () => {
    const waits: number[] = []
    const { dispatch } = dispatcher('{}')
    const result = await runPagePrep('example.com.list', dispatch, 'w1', {
      waitMs: 0,
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    expect(waits).toEqual([])
    expect(result).toMatchObject({ prepared: true, toolsReady: false })
  })

  it('ms 用注入的时钟度量（不依赖真实耗时）', async () => {
    let clock = 1000
    const { dispatch } = dispatcher('{}')
    const result = await runPagePrep('example.com.list', dispatch, 'w1', {
      waitMs: 0,
      sleep: async () => {
        clock += 250
      },
      now: () => clock,
    })
    expect(result.ms).toBe(0)
  })
})
