import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketBridge } from '../bridge.js'

vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events')
  return { WebSocketServer: class extends EventEmitter {} }
})

/**
 * ★7 观测：把一次 call_tool 拆成 ① CLI 启动→收单 ② 收单→派发 ③ 派发→扩展返回，
 * 打一行 [Bridge] 分段日志。只写日志，不改变调用与返回的契约。
 */
describe('bridge call_tool segment logging', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function makeBridge({ callTool }) {
    const bridge = Object.create(WebSocketBridge.prototype)
    bridge._callTimings = new Map()
    bridge._pendingRequests = new Map()
    bridge._requestCounter = 0
    bridge._extensionWs = { readyState: 1, send: vi.fn() }
    bridge._reply = vi.fn()
    bridge.callTool = callTool
    return bridge
  }

  function captureStderr() {
    const lines = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk))
      return true
    })
    return lines
  }

  it('reports all three segments once the call settles', async () => {
    const lines = captureStderr()
    const bridge = makeBridge({
      callTool: async () => {
        // 模拟 bridge 把 call_tool 真正写进扩展连接。
        bridge._send({ type: 'call_tool', traceID: 'trace-1', toolName: 'example.com.ping' })
        return { ok: true }
      },
    })

    await bridge._handleClientRequest({
      type: 'call_tool',
      toolName: 'example.com.ping',
      args: {},
      id: 'cli-1',
      traceID: 'trace-1',
      clientStartedAt: Date.now() - 800,
    })

    const segment = lines.find((line) => line.includes('调用分段'))
    expect(segment).toBeTruthy()
    expect(segment).toContain('[trace-1]')
    expect(segment).toMatch(/cli启动→收单=\d+ms/)
    expect(segment).toMatch(/收单→派发=\d+ms/)
    expect(segment).toMatch(/派发→扩展返回=\d+ms/)
    expect(segment).toMatch(/bridge总计=\d+ms/)
    // 观测状态不残留。
    expect(bridge._callTimings.size).toBe(0)
    expect(bridge._reply).toHaveBeenCalledWith(undefined, expect.objectContaining({ type: 'call_tool_result', id: 'cli-1', traceID: 'trace-1' }))
  })

  it('reports the segments for failures too, and never blocks the error path', async () => {
    const lines = captureStderr()
    const bridge = makeBridge({
      callTool: async () => {
        bridge._send({ type: 'call_tool', traceID: 'trace-2', toolName: 'example.com.write' })
        throw new Error('Adapter navigation host is not allowed.')
      },
    })

    await bridge._handleClientRequest({
      type: 'call_tool',
      toolName: 'example.com.write',
      args: {},
      id: 'cli-2',
      traceID: 'trace-2',
    })

    expect(lines.some((line) => line.includes('调用失败'))).toBe(true)
    const segment = lines.find((line) => line.includes('调用分段'))
    expect(segment).toBeTruthy()
    // 没有 clientStartedAt（旧 CLI）时不写 ①，其余两段照常。
    expect(segment).not.toContain('cli启动→收单')
    expect(segment).toMatch(/收单→派发=\d+ms/)
    expect(bridge._callTimings.size).toBe(0)
    expect(bridge._reply).toHaveBeenCalledWith(undefined, expect.objectContaining({ type: 'call_tool_error', id: 'cli-2', error: 'Adapter navigation host is not allowed.' }))
  })

  it('keeps working when the call was never dispatched to the extension', async () => {
    const lines = captureStderr()
    const bridge = makeBridge({
      callTool: async () => {
        // 扩展未连接：_send 返回 false，没有派发时刻。
        bridge._extensionWs.readyState = 3
        expect(bridge._send({ type: 'call_tool', traceID: 'trace-3' })).toBe(false)
        throw new Error('Extension not connected')
      },
    })

    await bridge._handleClientRequest({ type: 'call_tool', toolName: 'example.com.ping', args: {}, id: 'cli-3', traceID: 'trace-3' })

    const segment = lines.find((line) => line.includes('调用分段'))
    expect(segment).toContain('收单→派发=未派发')
    expect(bridge._callTimings.size).toBe(0)
  })

  it('does not add a segment line for calls without a traceID', async () => {
    const lines = captureStderr()
    const bridge = makeBridge({ callTool: async () => ({ ok: true }) })

    await bridge._handleClientRequest({ type: 'call_tool', toolName: 'example.com.ping', args: {}, id: 'cli-4' })

    expect(lines.some((line) => line.includes('调用分段'))).toBe(false)
    expect(bridge._callTimings.size).toBe(0)
  })

  // ★ 对话日志导出：桌面端会话带来的 workId 要随收单/成功/失败日志与 callTool
  // options 一起透传，日志行以 [work:前8位] 标记；无 workId 时不加标记。
  it('tags received/succeeded lines with the work id and forwards it to callTool', async () => {
    const lines = captureStderr()
    const seenOptions = []
    const bridge = makeBridge({ callTool: async (_name, _args, _traceID, _snapshot, options) => {
      seenOptions.push(options)
      return { ok: true }
    } })

    await bridge._handleClientRequest({
      type: 'call_tool', toolName: 'example.com.ping', args: {}, id: 'cli-5',
      workId: '2215049d-1234-5678-9abc-def012345678',
    })

    expect(seenOptions[0]).toMatchObject({ workId: '2215049d-1234-5678-9abc-def012345678' })
    expect(lines.find((line) => line.includes('收到调用'))).toContain('[work:2215049d]')
    expect(lines.find((line) => line.includes('调用成功'))).toContain('[work:2215049d]')

    const plainLines = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { plainLines.push(String(chunk)); return true })
    await bridge._handleClientRequest({ type: 'call_tool', toolName: 'example.com.ping', args: {}, id: 'cli-6' })
    expect(seenOptions[1].workId).toBeUndefined()
    expect(plainLines.find((line) => line.includes('收到调用'))).not.toContain('[work:')
  })
})
