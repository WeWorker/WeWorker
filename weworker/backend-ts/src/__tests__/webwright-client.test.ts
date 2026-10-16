/**
 * 网站探索agent 8766 客户端单测：SSE 帧解析 + health 缓存 + 任务 CRUD 的错误映射。
 *
 * 端上 HTTP 与事件流全部注入 stub：不发真实请求、不依赖 8766 在跑、不碰任何真实站点。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cancelWebwrightTask,
  checkWebwrightHealth,
  clearWebwrightHealthCache,
  createWebwrightTask,
  fetchWebwrightTask,
  getWebwrightBaseUrl,
  openWebwrightTaskEvents,
  readWebwrightSse,
  type FetchLike,
  type WebwrightTaskEvent,
} from '../webwright-client.js'

const enc = new TextEncoder()

function bodyOf(...chunks: string[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (const chunk of chunks) yield enc.encode(chunk)
  })()
}

async function drain(gen: AsyncGenerator<WebwrightTaskEvent>): Promise<WebwrightTaskEvent[]> {
  const out: WebwrightTaskEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(() => {
  clearWebwrightHealthCache()
  delete process.env.WEWORKER_WEBWRIGHT_URL
})

afterEach(() => {
  clearWebwrightHealthCache()
  delete process.env.WEWORKER_WEBWRIGHT_URL
})

describe('readWebwrightSse：帧解析', () => {
  it('一个 chunk 里的多帧全部解析出来', async () => {
    const events = await drain(
      readWebwrightSse(
        bodyOf('event: task_started\ndata: {"a":1}\n\n', 'event: step_finished\ndata: {"step":2}\n\n'),
      ),
    )
    expect(events).toEqual([
      { event: 'task_started', data: { a: 1 } },
      { event: 'step_finished', data: { step: 2 } },
    ])
  })

  it('帧被切成两个 chunk（网络分片）时仍算一帧，不重复不丢失', async () => {
    const events = await drain(
      readWebwrightSse(bodyOf('event: step_fin', 'ished\ndata: {"step":', '3}\n\n')),
    )
    expect(events).toEqual([{ event: 'step_finished', data: { step: 3 } }])
  })

  it('多行 data 拼接后再解析', async () => {
    const events = await drain(readWebwrightSse(bodyOf('event: x\ndata: {"a":\ndata: 1}\n\n')))
    expect(events).toEqual([{ event: 'x', data: { a: 1 } }])
  })

  it('data 不是合法 JSON → 事件名保留、data 退化为空对象（不吞掉整帧）', async () => {
    const events = await drain(readWebwrightSse(bodyOf('event: broken\ndata: {not json\n\n')))
    expect(events).toEqual([{ event: 'broken', data: {} }])
  })

  it('data 是合法 JSON 但不是对象 → 同样退化为空对象', async () => {
    expect(await drain(readWebwrightSse(bodyOf('event: n\ndata: 123\n\n')))).toEqual([{ event: 'n', data: {} }])
  })

  it('缺 event 名的帧被丢弃（心跳/注释行不得变成事件）', async () => {
    expect(await drain(readWebwrightSse(bodyOf('data: {"a":1}\n\n', 'event: ok\ndata: {}\n\n')))).toEqual([
      { event: 'ok', data: {} },
    ])
  })

  it('末尾未闭合的半帧不产出（等下一个 chunk）', async () => {
    expect(await drain(readWebwrightSse(bodyOf('event: half\ndata: {"a":1}')))).toEqual([])
  })

  it('signal 已中止时不再产出', async () => {
    const controller = new AbortController()
    controller.abort()
    const events = await drain(
      readWebwrightSse(bodyOf('event: x\ndata: {}\n\n', 'event: y\ndata: {}\n\n'), controller.signal),
    )
    expect(events).toEqual([])
  })
})

describe('openWebwrightTaskEvents', () => {
  it('建连超时**只覆盖响应头**：响应到达后长连接不再被该超时中止', async () => {
    // 回归门：若把 AbortSignal.timeout() 留在请求上，连接定时器会在 connectTimeoutMs 后
    // 中止响应体，分钟级任务永远收不到停态（实测表现为第 10 秒静默中断）。
    const fetchImpl: FetchLike = async (_url, init) => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      body: (async function* () {
        await sleep(60)
        if (init?.signal?.aborted) throw new Error('body aborted by connect timeout')
        yield enc.encode('event: task_started\ndata: {}\n\n')
      })(),
    })

    const opened = await openWebwrightTaskEvents('t1', { fetchImpl, connectTimeoutMs: 20 })
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    expect(await drain(opened.events)).toEqual([{ event: 'task_started', data: {} }])
  })

  it('非 200 → {ok:false} 并带状态码（调用方据此落回）', async () => {
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}), body: bodyOf() })
    expect(await openWebwrightTaskEvents('t1', { fetchImpl })).toEqual({ ok: false, reason: 'events-http-500' })
  })

  it('200 但没有响应体 → {ok:false}', async () => {
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({}), body: null })
    expect(await openWebwrightTaskEvents('t1', { fetchImpl })).toEqual({ ok: false, reason: 'events-http-200' })
  })

  it('建连抛错 → {ok:false, reason: 错误信息}', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('connect ECONNREFUSED')
    }
    expect(await openWebwrightTaskEvents('t1', { fetchImpl })).toEqual({ ok: false, reason: 'connect ECONNREFUSED' })
  })

  it('请求地址指向固定 loopback 的 /api/tasks/<id>/events', async () => {
    const urls: string[] = []
    const fetchImpl: FetchLike = async (url) => {
      urls.push(url)
      return { ok: true, status: 200, json: async () => ({}), body: bodyOf() }
    }
    await openWebwrightTaskEvents('t 1/2', { fetchImpl })
    expect(urls[0]).toBe('http://127.0.0.1:8766/api/tasks/t%201%2F2/events')
  })
})

describe('checkWebwrightHealth', () => {
  it('200 → ok，并命中 TTL 缓存（只发一次请求）', async () => {
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls += 1
      return { ok: true, status: 200, json: async () => ({ status: 'ok' }) }
    }
    expect(await checkWebwrightHealth({ fetchImpl })).toEqual({ ok: true, reason: '' })
    expect(await checkWebwrightHealth({ fetchImpl })).toEqual({ ok: true, reason: '' })
    expect(calls).toBe(1)
  })

  it('非 200 → 不健康，原因 health-non-200（不可达时不抛异常）', async () => {
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 503, json: async () => ({}) })
    expect(await checkWebwrightHealth({ fetchImpl })).toEqual({ ok: false, reason: 'health-non-200' })
  })

  it('网络异常 → 不健康，并带上错误信息（负缓存同样生效）', async () => {
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls += 1
      throw new Error('ECONNREFUSED')
    }
    expect(await checkWebwrightHealth({ fetchImpl })).toEqual({ ok: false, reason: 'ECONNREFUSED' })
    expect(await checkWebwrightHealth({ fetchImpl })).toEqual({ ok: false, reason: 'ECONNREFUSED' })
    expect(calls).toBe(1)
  })
})

describe('createWebwrightTask', () => {
  const okFetch = (body: unknown, status = 200): FetchLike => async () => ({
    ok: status < 400,
    status,
    json: async () => body,
  })

  it('成功返回 taskId，并把 instruction / start_url 送出去', async () => {
    let seen: string | undefined
    const fetchImpl: FetchLike = async (_url, init) => {
      seen = String(init?.body ?? '')
      return { ok: true, status: 200, json: async () => ({ task_id: 't1' }) }
    }
    expect(await createWebwrightTask({ instruction: 'i', startUrl: 'https://shop.example.org' }, { fetchImpl })).toEqual({
      ok: true,
      taskId: 't1',
    })
    expect(JSON.parse(seen!)).toEqual({ instruction: 'i', start_url: 'https://shop.example.org' })
  })

  it('409 busy → 带出服务端 error.code（单活动 worker 的既有语义）', async () => {
    const fetchImpl = okFetch({ error: { code: 'busy', message: '已有任务在跑' } }, 409)
    expect(await createWebwrightTask({ instruction: 'i', startUrl: 'https://x.example.org' }, { fetchImpl })).toEqual({
      ok: false,
      status: 409,
      code: 'busy',
      message: '已有任务在跑',
    })
  })

  it('非 2xx 且没有结构化 error → code 退化为 http-<status>', async () => {
    const fetchImpl = okFetch({}, 502)
    expect(await createWebwrightTask({ instruction: 'i', startUrl: 'https://x.example.org' }, { fetchImpl })).toEqual({
      ok: false,
      status: 502,
      code: 'http-502',
      message: '',
    })
  })

  it('200 但缺 task_id → 明确报错（不能拿空 id 去轮询）', async () => {
    const fetchImpl = okFetch({})
    expect(await createWebwrightTask({ instruction: 'i', startUrl: 'https://x.example.org' }, { fetchImpl })).toEqual({
      ok: false,
      status: 200,
      code: 'missing-task-id',
      message: '响应缺少 task_id',
    })
  })

  it('网络异常 → code network，不抛给调用方', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('ECONNREFUSED')
    }
    const result = await createWebwrightTask({ instruction: 'i', startUrl: 'https://x.example.org' }, { fetchImpl })
    expect(result).toMatchObject({ ok: false, status: 0, code: 'network' })
  })
})

describe('fetchWebwrightTask / cancelWebwrightTask', () => {
  it('GET 非 2xx → null（调用方按「查不到状态」处理）', async () => {
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 404, json: async () => ({}) })
    expect(await fetchWebwrightTask('t1', { fetchImpl })).toBeNull()
  })

  it('GET 抛错 → null', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('boom')
    }
    expect(await fetchWebwrightTask('t1', { fetchImpl })).toBeNull()
  })

  it('GET 成功 → 返回任务视图', async () => {
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ task_id: 't1', status: 'running' }) })
    expect(await fetchWebwrightTask('t1', { fetchImpl })).toMatchObject({ status: 'running' })
  })

  it('取消失败被吞掉（尽力而为，不影响回合收尾）', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('boom')
    }
    await expect(cancelWebwrightTask('t1', { fetchImpl })).resolves.toBeUndefined()
  })

  it('取消走 POST /cancel', async () => {
    const urls: string[] = []
    let method = ''
    const fetchImpl: FetchLike = async (url, init) => {
      urls.push(url)
      method = String(init?.method ?? '')
      return { ok: true, status: 200, json: async () => ({}) }
    }
    await cancelWebwrightTask('t1', { fetchImpl })
    expect(urls[0]).toBe('http://127.0.0.1:8766/api/tasks/t1/cancel')
    expect(method).toBe('POST')
  })
})

describe('getWebwrightBaseUrl', () => {
  it('默认指向固定 loopback 8766（Renderer 无法影响这个地址）', () => {
    expect(getWebwrightBaseUrl()).toBe('http://127.0.0.1:8766')
  })

  it('WEWORKER_WEBWRIGHT_URL 可覆盖（仅供测试指向本地 stub）', () => {
    process.env.WEWORKER_WEBWRIGHT_URL = 'http://127.0.0.1:12345'
    expect(getWebwrightBaseUrl()).toBe('http://127.0.0.1:12345')
  })
})
