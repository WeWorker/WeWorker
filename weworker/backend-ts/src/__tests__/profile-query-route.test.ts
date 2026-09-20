import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  registerBackendProfileQueryRouteConfig,
  registerBackendProfileQueryRoute,
  resetBackendProfileQueryRouteForTests,
  tryBackendProfileQueryRoute,
} from '../profile-query-route.js'

describe('backend profile query route', () => {
  beforeEach(() => {
    resetBackendProfileQueryRouteForTests()
  })

  it('falls through until a profile registers a route', async () => {
    const context = { message: 'hello' }
    expect(await tryBackendProfileQueryRoute(context as any)).toBe(false)

    const route = vi.fn(async () => true)
    registerBackendProfileQueryRoute(route)
    expect(await tryBackendProfileQueryRoute(context as any)).toBe(true)
    expect(route).toHaveBeenCalledWith(context)
  })

  it('registers a configured route', async () => {
    const send = vi.fn()
    const dispatch = vi.fn(async () => JSON.stringify({ ok: true, count: 2 }))
    const persistAssistantMessage = vi.fn()
    registerBackendProfileQueryRouteConfig({
      routes: [
        {
          id: 'mail-search',
          tool: 'mail.example.com.search',
          match: { aliases: ['/mail'], keywords: ['查邮件'] },
          args: { limit: 5 },
          title: '邮件查询',
        },
      ],
    }, {
      listCatalogTools: () => [
        { adapterId: 'mail.example.com', toolName: 'mail.example.com.search', directCapable: true },
      ],
      dispatch,
      persistAssistantMessage,
      now: () => 1000,
    })

    const handled = await tryBackendProfileQueryRoute({
      message: '请帮我查邮件',
      workId: 'w1',
      turnId: 't1',
      chatStartTime: 900,
      send,
    })

    expect(handled).toBe(true)
    expect(dispatch).toHaveBeenCalledWith('mail.example.com.search', JSON.stringify({ limit: 5 }), 'w1')
    expect(send).toHaveBeenCalledWith({ type: 'turn_start', turnId: 't1', workId: 'w1' })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'text_delta', content: expect.stringContaining('邮件查询') }))
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'turn_end', llmMs: 0, steps: 1 }))
    expect(persistAssistantMessage).toHaveBeenCalled()
  })

  it('does not route unavailable or non-direct tools', async () => {
    const dispatch = vi.fn(async () => '{}')
    registerBackendProfileQueryRouteConfig({
      routes: [
        { id: 'missing', tool: 'mail.example.com.search', match: { keywords: ['邮件'] } },
      ],
    }, {
      listCatalogTools: () => [
        { adapterId: 'mail.example.com', toolName: 'mail.example.com.search', directCapable: false },
      ],
      dispatch,
    })

    expect(await tryBackendProfileQueryRoute({
      message: '查邮件',
      workId: 'w1',
      turnId: 't1',
      chatStartTime: 0,
      send: vi.fn(),
    })).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
  })
})
