import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { BridgeRpcClient } from '../bridge-rpc-client.js'

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING
  sent: string[] = []

  open(): void {
    this.readyState = WebSocket.OPEN
    this.emit('open')
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = WebSocket.CLOSED
    this.emit('close')
  }

  receive(message: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(message)))
  }
}

function createHarness() {
  const socket = new FakeSocket()
  const client = new BridgeRpcClient('ws://test', () => socket as unknown as WebSocket)
  client.start()
  socket.open()
  return { client, socket }
}

describe('BridgeRpcClient', () => {
  it('tracks extension capabilities and correlates tab-list responses', async () => {
    const { client, socket } = createHarness()
    socket.receive({
      type: 'extension_connected',
      version: '0.2.6',
      capabilities: ['passive_exploration_v1', 'passive_exploration_v1'],
    })

    expect(client.getCapabilities()).toEqual({
      bridgeConnected: true,
      extensionConnected: true,
      extensionVersion: '0.2.6',
      capabilities: ['passive_exploration_v1'],
    })

    const tabsPromise = client.listExplorableTabs()
    const request = JSON.parse(socket.sent.at(-1) || '{}')
    expect(request.type).toBe('exploration_list_tabs')
    socket.receive({
      type: 'call_tool_result',
      id: request.id,
      result: {
        tabs: [
          { id: 9, title: 'Todo', url: 'https://todo.example.com/list', active: true, windowId: 2 },
          {
            id: 11,
            title: 'Ticket',
            url: 'https://ticket.example.com/#/list?tmploginticket=raw-ticket&page=1',
            active: false,
            windowId: 2,
          },
          { id: null, url: 'chrome://settings' },
        ],
      },
    })

    await expect(tabsPromise).resolves.toEqual([
      { id: 9, title: 'Todo', url: 'https://todo.example.com/list', active: true, windowId: 2 },
      {
        id: 11,
        title: 'Ticket',
        url: 'https://ticket.example.com/#/list?tmploginticket=%5Bredacted%5D&page=1',
        active: false,
        windowId: 2,
      },
    ])
    client.stop()
  })

  it('rejects pending requests when the extension disconnects', async () => {
    const { client, socket } = createHarness()
    socket.receive({ type: 'extension_connected', capabilities: ['passive_exploration_v1'] })
    const request = client.runPassiveExploration(3)
    expect(JSON.parse(socket.sent.at(-1) || '{}').type).toBe('exploration_capture_passive')
    socket.receive({ type: 'extension_disconnected' })
    await expect(request).rejects.toThrow('EXTENSION_DISCONNECTED')
    client.stop()
  })

  it('correlates client action capture start, stop and state requests', async () => {
    const { client, socket } = createHarness()
    socket.receive({ type: 'extension_connected', capabilities: ['passive_exploration_v1', 'action_capture_v1'] })

    const startPromise = client.startActionCapture({
      tabId: 7,
      siteKey: 'todo.example.com',
      actionName: 'search_projects',
      mode: 'intercept',
      timeoutSeconds: 60,
      modelConfig: { provider: 'custom', protocol: 'anthropic', model: 'glm-5.3', api_key: 'fake-test-key', base_url: 'https://model.example.com' },
    })
    const startRequest = JSON.parse(socket.sent.at(-1) || '{}')
    expect(startRequest.modelConfig).toEqual({ provider: 'custom', protocol: 'anthropic', model: 'glm-5.3', api_key: 'fake-test-key', base_url: 'https://model.example.com' })
    expect(startRequest).toMatchObject({
      type: 'client_action_capture_start',
      tabId: 7,
      siteKey: 'todo.example.com',
      actionName: 'search_projects',
    })
    socket.receive({ type: 'call_tool_result', id: startRequest.id, result: { type: 'action_capture_loading', started: true } })
    await expect(startPromise).resolves.toMatchObject({ type: 'action_capture_loading' })

    const stopPromise = client.stopActionCapture({ tabId: 7, siteKey: 'todo.example.com', actionName: 'search_projects' })
    const stopRequest = JSON.parse(socket.sent.at(-1) || '{}')
    expect(stopRequest.type).toBe('exploration_action_capture_stop')
    socket.receive({ type: 'call_tool_result', id: stopRequest.id, result: { type: 'action_capture_stopping', stopping: true } })
    await expect(stopPromise).resolves.toMatchObject({ type: 'action_capture_stopping' })

    const retryPromise = client.retryActionCaptureAnalysis({ tabId: 7, siteKey: 'todo.example.com', actionName: 'search_projects', modelConfig: startRequest.modelConfig })
    const retryRequest = JSON.parse(socket.sent.at(-1) || '{}')
    expect(retryRequest).toMatchObject({ type: 'client_action_capture_analyze', modelConfig: { model: 'glm-5.3' } })
    socket.receive({ type: 'call_tool_result', id: retryRequest.id, result: { type: 'action_capture_ai_loading' } })
    await expect(retryPromise).resolves.toMatchObject({ type: 'action_capture_ai_loading' })

    const getPromise = client.getActionCapture({ tabId: 7, siteKey: 'todo.example.com' })
    const getRequest = JSON.parse(socket.sent.at(-1) || '{}')
    expect(getRequest.type).toBe('exploration_action_capture_get')
    socket.receive({ type: 'call_tool_result', id: getRequest.id, result: { type: 'action_capture', result: { actionName: 'search_projects' } } })
    await expect(getPromise).resolves.toMatchObject({ type: 'action_capture' })

    const selectPromise = client.selectActionCaptureCandidate({ tabId: 7, siteKey: 'todo.example.com', candidateIndex: 1 })
    const selectRequest = JSON.parse(socket.sent.at(-1) || '{}')
    expect(selectRequest).toMatchObject({ type: 'exploration_action_capture_select', candidateIndex: 1 })
    socket.receive({ type: 'call_tool_result', id: selectRequest.id, result: { type: 'action_capture', selectedCandidateIndex: 1 } })
    await expect(selectPromise).resolves.toMatchObject({ selectedCandidateIndex: 1 })

    const clearPromise = client.clearActionCapture({ tabId: 7, siteKey: 'todo.example.com' })
    const clearRequest = JSON.parse(socket.sent.at(-1) || '{}')
    expect(clearRequest.type).toBe('exploration_action_capture_clear')
    socket.receive({ type: 'call_tool_result', id: clearRequest.id, result: { ok: true, cleared: true } })
    await expect(clearPromise).resolves.toMatchObject({ cleared: true })
    client.stop()
  })

  it('correlates safe API action inspection and Network-delta probes', async () => {
    const { client, socket } = createHarness()
    socket.receive({ type: 'extension_connected', capabilities: ['passive_exploration_v1', 'safe_api_probe_v1'] })

    const inspectPromise = client.inspectSafeApiActions(7)
    const inspectRequest = JSON.parse(socket.sent.at(-1) || '{}')
    expect(inspectRequest).toMatchObject({ type: 'exploration_safe_actions_inspect', tabId: 7 })
    socket.receive({
      type: 'call_tool_result',
      id: inspectRequest.id,
      result: { candidates: [{ id: 'safe-api-1-1', kind: 'search', risk: 'read' }] },
    })
    await expect(inspectPromise).resolves.toMatchObject({ candidates: [{ id: 'safe-api-1-1' }] })

    const runPromise = client.runSafeApiProbe({ tabId: 7, candidateId: 'safe-api-1-1', value: 'alpha' })
    const runRequest = JSON.parse(socket.sent.at(-1) || '{}')
    expect(runRequest).toMatchObject({
      type: 'exploration_safe_probe_run',
      tabId: 7,
      candidateId: 'safe-api-1-1',
      value: 'alpha',
    })
    socket.receive({
      type: 'call_tool_result',
      id: runRequest.id,
      result: { step: 'safe_search', networkDelta: { entries: [] } },
    })
    await expect(runPromise).resolves.toMatchObject({ step: 'safe_search' })

    const replayPromise = client.replayApiCandidate({
      tabId: 7,
      url: 'https://todo.example.com/api/search?q=alpha',
      method: 'GET',
    })
    const replayRequest = JSON.parse(socket.sent.at(-1) || '{}')
    expect(replayRequest).toMatchObject({
      type: 'exploration_replay_candidate',
      tabId: 7,
      url: 'https://todo.example.com/api/search?q=alpha',
      method: 'GET',
    })
    socket.receive({
      type: 'call_tool_result',
      id: replayRequest.id,
      result: { transport: 'browser_page', status: 200, ok: true },
    })
    await expect(replayPromise).resolves.toMatchObject({ transport: 'browser_page', status: 200 })
    client.stop()
  })

  it('correlates v1 generation lifecycle requests and refreshes published adapter tabs', async () => {
    const { client, socket } = createHarness()
    socket.receive({
      type: 'extension_connected',
      capabilities: ['passive_exploration_v1', 'generation_harness_v1'],
    })

    const startPromise = client.startGenerationRun({
      siteKey: 'todo.example.com',
      memory: { siteKey: 'todo.example.com' },
      goal: '生成列表查询工具',
      tabId: 7,
      modelConfig: {
        provider: 'custom',
        protocol: 'anthropic',
        api_key: 'request-only-secret',
        base_url: 'https://models.example.com/anthropic',
        model: 'client-model',
      },
    })
    const startRequest = JSON.parse(socket.sent.at(-1) || '{}')
    expect(startRequest).toMatchObject({
      type: 'start_generation_run',
      siteKey: 'todo.example.com',
      tabId: 7,
      modelConfig: {
        provider: 'custom',
        protocol: 'anthropic',
        api_key: 'request-only-secret',
        base_url: 'https://models.example.com/anthropic',
        model: 'client-model',
      },
    })
    socket.receive({
      type: 'start_generation_run_result',
      id: startRequest.id,
      ok: true,
      run: { id: 'run-1', siteKey: 'todo.example.com', status: 'planning' },
    })
    const started = await startPromise
    expect(started).toMatchObject({ id: 'run-1', status: 'planning' })
    expect(JSON.stringify(started)).not.toContain('request-only-secret')

    const retryPromise = client.startGenerationRun({
      siteKey: 'todo.example.com',
      memory: { siteKey: 'todo.example.com' },
      goal: '生成列表查询工具',
      tabId: 7,
      previousRunId: 'run-1',
    })
    const retryRequest = JSON.parse(socket.sent.at(-1) || '{}')
    expect(retryRequest).toMatchObject({
      type: 'start_generation_run',
      previousRunId: 'run-1',
    })
    socket.receive({
      type: 'start_generation_run_result',
      id: retryRequest.id,
      ok: true,
      run: { id: 'run-2', siteKey: 'todo.example.com', status: 'planning' },
    })
    await expect(retryPromise).resolves.toMatchObject({ id: 'run-2' })

    const agentModePromise = client.startGenerationRun({
      siteKey: 'todo.example.com',
      memory: { siteKey: 'todo.example.com' },
      goal: '生成列表查询工具',
      tabId: 7,
      mode: 'agent',
    })
    const agentModeRequest = JSON.parse(socket.sent.at(-1) || '{}')
    expect(agentModeRequest).toMatchObject({ type: 'start_generation_run', mode: 'agent' })
    socket.receive({
      type: 'start_generation_run_result',
      id: agentModeRequest.id,
      ok: true,
      run: { id: 'run-3', siteKey: 'todo.example.com', status: 'planning' },
    })
    await expect(agentModePromise).resolves.toMatchObject({ id: 'run-3' })

    const resumePromise = client.resumeGenerationRun('run-3', '已重新登录页面')
    const resumeRequest = JSON.parse(socket.sent.at(-1) || '{}')
    expect(resumeRequest).toMatchObject({ type: 'resume_generation_run', runId: 'run-3', answer: '已重新登录页面' })
    socket.receive({
      type: 'resume_generation_run_result',
      id: resumeRequest.id,
      ok: true,
      run: { id: 'run-3', siteKey: 'todo.example.com', status: 'awaiting_approval' },
    })
    await expect(resumePromise).resolves.toMatchObject({ status: 'awaiting_approval' })

    const getPromise = client.getGenerationRun('run-1')
    const getRequest = JSON.parse(socket.sent.at(-1) || '{}')
    expect(getRequest.type).toBe('get_generation_run')
    socket.receive({
      type: 'get_generation_run_result',
      id: getRequest.id,
      ok: true,
      run: { id: 'run-1', siteKey: 'todo.example.com', status: 'awaiting_approval' },
    })
    await expect(getPromise).resolves.toMatchObject({ status: 'awaiting_approval' })

    const publishPromise = client.publishGenerationRun('run-1')
    const publishRequest = JSON.parse(socket.sent.at(-1) || '{}')
    expect(publishRequest.type).toBe('publish_generation_run')
    socket.receive({
      type: 'publish_generation_run_result',
      id: publishRequest.id,
      ok: true,
      run: { id: 'run-1', siteKey: 'todo.example.com', status: 'completed' },
    })
    await expect(publishPromise).resolves.toMatchObject({ status: 'completed' })

    const refreshPromise = client.refreshAdapterTabs('todo.example.com')
    const refreshRequest = JSON.parse(socket.sent.at(-1) || '{}')
    expect(refreshRequest).toMatchObject({ type: 'refresh_adapter_tabs', siteKey: 'todo.example.com' })
    socket.receive({
      type: 'call_tool_result',
      id: refreshRequest.id,
      result: { refreshedTabs: 1, toolCount: 2 },
    })
    await expect(refreshPromise).resolves.toEqual({ refreshedTabs: 1, toolCount: 2 })
    client.stop()
  })
})
