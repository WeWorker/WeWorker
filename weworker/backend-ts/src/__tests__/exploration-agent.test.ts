import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { streamChat } from '../agent.js'
import type { BridgeRpcClient, ExplorableTab } from '../bridge-rpc-client.js'
import type { Settings } from '../config.js'
import {
  ExplorationAgentCoordinator,
  resolveClientGenerationModelConfig,
  sanitizeExplorationEvidence,
} from '../exploration-agent.js'

function generationSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    active_provider: 'glm',
    api_key: 'client-request-secret',
    base_url: 'https://open.bigmodel.cn/api/anthropic',
    model: 'glm-5.2',
    ...overrides,
  } as Settings
}

const completedAgentStream = (async function* () {
  yield { type: 'text_delta', content: '识别到列表接口。' }
  yield { type: 'done' }
}) as unknown as typeof streamChat

async function waitForCompleted(
  coordinator: ExplorationAgentCoordinator,
  taskId: string,
) {
  let run = coordinator.get(taskId)
  for (let attempt = 0; attempt < 40 && run?.status !== 'completed'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    run = coordinator.get(taskId)
  }
  expect(run?.status).toBe('completed')
  return run
}

describe('sanitizeExplorationEvidence', () => {
  it('redacts credentials while preserving API request evidence', () => {
    const result = sanitizeExplorationEvidence({
      method: 'GET',
      url: 'https://example.com/api/list?page=1&token=abc',
      headers: {
        Authorization: 'Bearer secret',
        Cookie: 'session=secret',
        Accept: 'application/json',
      },
      headerList: [{ name: 'X-Auth-Token', value: 'another-secret' }],
      response: { items: [{ id: 1, title: 'visible' }] },
    })

    expect(result).toEqual({
      method: 'GET',
      url: 'https://example.com/api/list?page=1&token=%5Bredacted%5D',
      headers: {
        Authorization: '[redacted]',
        Cookie: '[redacted]',
        Accept: 'application/json',
      },
      headerList: [{ name: 'X-Auth-Token', value: '[redacted]' }],
      response: { items: [{ id: 1, title: 'visible' }] },
    })
  })

  it('bounds large evidence arrays and response strings', () => {
    const result = sanitizeExplorationEvidence({
      entries: Array.from({ length: 45 }, (_, id) => ({ id })),
      body: 'x'.repeat(4_100),
    }) as { entries: unknown[]; body: string }

    expect(result.entries).toHaveLength(41)
    expect(result.entries.at(-1)).toBe('[truncated 5 items]')
    expect(result.body).toContain('[truncated 100 chars]')
  })
})

describe('ExplorationAgentCoordinator', () => {
  it('maps the active client provider to a request-scoped Harness model config', () => {
    expect(resolveClientGenerationModelConfig(generationSettings())).toEqual({
      provider: 'custom',
      protocol: 'anthropic',
      api_key: 'client-request-secret',
      base_url: 'https://open.bigmodel.cn/api/anthropic',
      model: 'glm-5.2',
    })
  })

  it('captures first and lets the dedicated agent read only the sanitized passive evidence', async () => {
    const bridge = {
      runPassiveExploration: vi.fn().mockResolvedValue({
        pageStateBefore: {
          url: 'https://example.com/list',
          interactiveElements: [{ tag: 'input', text: '用户身份', selector: 'input[name="secret"]' }],
        },
        network: { entries: [{ method: 'GET', url: 'https://example.com/api/list' }] },
        headers: { Authorization: 'Bearer secret' },
        responsePreview: '{"username":"real-user","items":[{"businessName":"real-business-name"}]}',
      }),
    } as unknown as BridgeRpcClient

    const fakeAgentStream = (async function* (
      _messages: unknown,
      _settings: unknown,
      _abortController: unknown,
      options: { mcpServerOverride?: unknown; restrictBuiltInTools?: boolean },
    ) {
      expect(options.restrictBuiltInTools).toBe(true)
      const server = options.mcpServerOverride as {
        instance: { _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }> }
      }
      expect(Object.keys(server.instance._registeredTools)).toEqual([
        'capture_passive_exploration',
        'inspect_safe_api_actions',
        'execute_safe_api_probe',
        'replay_api_candidate',
        'load_api_exploration_skill',
      ])
      const captured = await server.instance._registeredTools.capture_passive_exploration.handler({}) as {
        content: Array<{ type: string; text: string }>
      }
      const agentView = JSON.parse(captured.content[0]?.text || '{}') as Record<string, unknown>
      expect(JSON.stringify(agentView)).toContain('GET /api/list')
      expect(JSON.stringify(agentView)).not.toContain('selector')
      expect(JSON.stringify(agentView)).not.toContain('real-user')
      expect(JSON.stringify(agentView)).not.toContain('real-business-name')
      expect(captured.content[0]?.text.length || 0).toBeLessThan(25_000)
      const skillResult = await server.instance._registeredTools.load_api_exploration_skill.handler({ name: 'usage' })
      expect(JSON.stringify(skillResult)).toContain('WeWorker API exploration usage')
      expect(JSON.stringify(skillResult)).toContain('Apache-2.0')
      yield { type: 'text_delta', content: '识别到一个只读列表接口。' }
      yield { type: 'done' }
    }) as unknown as typeof streamChat

    const coordinator = new ExplorationAgentCoordinator(
      bridge,
      fakeAgentStream,
      () => ({ model: 'test' }) as Settings,
    )
    const tab: ExplorableTab = {
      id: 7,
      title: 'Example',
      url: 'https://example.com/list',
      active: true,
      windowId: 1,
    }
    const started = coordinator.start('分析列表能力', tab)

    let completed = coordinator.get(started.taskId)
    for (let attempt = 0; attempt < 20 && completed?.status === 'preparing'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      completed = coordinator.get(started.taskId)
    }
    for (let attempt = 0; attempt < 20 && completed?.status === 'running'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      completed = coordinator.get(started.taskId)
    }

    expect(bridge.runPassiveExploration).toHaveBeenCalledWith(7)
    expect(bridge.runPassiveExploration).toHaveBeenCalledTimes(1)
    expect(completed?.status).toBe('completed')
    expect(completed?.summary).toContain('只读列表接口')
    expect(JSON.stringify(completed?.evidence)).not.toContain('secret')
    expect(JSON.stringify(completed?.evidence)).not.toContain('selector')
    expect(JSON.stringify(completed?.evidence)).not.toContain('real-user')
    expect(completed?.evidence).toMatchObject({
      analysisV2: {
        schemaVersion: 2,
        candidates: [expect.objectContaining({ endpointFamily: 'GET /api/list' })],
      },
    })
  })

  it('lets the dedicated agent run a bounded safe read probe and folds its Network delta into analysisV2', async () => {
    const bridge = {
      runPassiveExploration: vi.fn().mockResolvedValue({
        pageStateBefore: { url: 'https://example.com/projects' },
        pageStateAfter: { url: 'https://example.com/projects' },
        network: { entries: [] },
      }),
      inspectSafeApiActions: vi.fn().mockResolvedValue({
        candidates: [{ id: 'safe-api-1-1', kind: 'search', label: '搜索项目', risk: 'read' }],
      }),
      runSafeApiProbe: vi.fn().mockResolvedValue({
        step: 'safe_search',
        result: { executed: true, kind: 'search' },
        networkDelta: {
          entries: [{
            method: 'GET',
            url: 'https://example.com/api/projects?query=alpha&page=1',
            status: 200,
            responseContentType: 'application/json',
            responsePreview: '{"items":[{"id":"P-1","name":"Alpha"}]}',
          }],
        },
      }),
    } as unknown as BridgeRpcClient

    const fakeAgentStream = (async function* (
      _messages: unknown,
      _settings: unknown,
      _abortController: unknown,
      options: { mcpServerOverride?: unknown },
    ) {
      const server = options.mcpServerOverride as {
        instance: { _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }> }
      }
      await server.instance._registeredTools.capture_passive_exploration.handler({})
      await server.instance._registeredTools.inspect_safe_api_actions.handler({})
      await server.instance._registeredTools.execute_safe_api_probe.handler({ candidateId: 'safe-api-1-1', value: 'alpha' })
      yield { type: 'text_delta', content: '通过安全搜索探针识别到项目 API。' }
      yield { type: 'done' }
    }) as unknown as typeof streamChat

    const coordinator = new ExplorationAgentCoordinator(
      bridge,
      fakeAgentStream,
      () => ({ model: 'test' }) as Settings,
    )
    const started = coordinator.start('搜索项目', {
      id: 8,
      title: 'Projects',
      url: 'https://example.com/projects',
      active: true,
      windowId: 1,
    })
    const completed = await waitForCompleted(coordinator, started.taskId)

    expect(bridge.inspectSafeApiActions).toHaveBeenCalledWith(8)
    expect(bridge.runSafeApiProbe).toHaveBeenCalledWith({ tabId: 8, candidateId: 'safe-api-1-1', value: 'alpha' })
    const persistedActions = Array.isArray(completed?.evidence?.actions)
      ? completed.evidence.actions as Record<string, unknown>[]
      : []
    const persistedAction = persistedActions[0]
    expect(persistedAction?.step).toBe('safe_search')
    expect((persistedAction?.networkDeltaSummary as Record<string, unknown>)?.entryCount).toBe(1)
    expect(completed?.evidence?.analysisV2).toMatchObject({
      schemaVersion: 2,
      likelyDataCount: 1,
      recommendedNextProbe: 'replay_top_candidate',
    })
    expect(JSON.stringify(completed?.evidence)).not.toContain('Alpha')
    expect(JSON.stringify(completed?.evidence)).not.toContain('responsePreview')
  })

  it('keeps a raw captured URL only in memory for page replay while exposing and persisting only redacted evidence', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const bridge = {
        runPassiveExploration: vi.fn().mockResolvedValue({
          network: {
            entries: [{
              method: 'GET',
              url: 'https://example.com/api/projects?token=raw-secret&page=1',
              status: 200,
              responseContentType: 'application/json',
              responsePreview: '{"items":[{"id":"P-1"}]}',
            }],
          },
        }),
        replayApiCandidate: vi.fn().mockResolvedValue({
          transport: 'browser_page',
          status: 200,
          ok: true,
          contentType: 'application/json',
          responsePreview: '{"items":[{"id":"P-1"}]}',
          durationMs: 3,
          errorCode: '',
        }),
      } as unknown as BridgeRpcClient
      const fakeAgentStream = (async function* (
        _messages: unknown,
        _settings: unknown,
        _abortController: unknown,
        options: { mcpServerOverride?: unknown },
      ) {
        const server = options.mcpServerOverride as {
          instance: { _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }> }
        }
        await server.instance._registeredTools.replay_api_candidate.handler({ evidenceId: 'GET /api/projects?page' })
        yield { type: 'text_delta', content: '页面态重放验证成功。' }
        yield { type: 'done' }
      }) as unknown as typeof streamChat
      const coordinator = new ExplorationAgentCoordinator(
        bridge,
        fakeAgentStream,
        () => ({ model: 'test' }) as Settings,
      )
      const started = coordinator.start('验证项目接口', {
        id: 9,
        title: 'Projects',
        url: 'https://example.com/projects',
        active: true,
        windowId: 1,
      })
      const completed = await waitForCompleted(coordinator, started.taskId)

      expect(String(fetchMock.mock.calls[0]?.[0])).toContain('token=%5Bredacted%5D')
      expect(bridge.replayApiCandidate).toHaveBeenCalledWith(expect.objectContaining({
        url: 'https://example.com/api/projects?token=raw-secret&page=1',
      }))
      expect(JSON.stringify(completed?.evidence)).not.toContain('raw-secret')
      expect(completed?.evidence).toMatchObject({
        analysisV2: {
          candidates: [expect.objectContaining({
            strategyNote: expect.objectContaining({ replayStatus: 'verified', strategy: 'PAGE_FETCH' }),
          })],
        },
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('saves passive evidence into v1 Site Memory and drives the Generation Harness lifecycle', async () => {
    const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-client-exploration-'))
    const previousMemoryFile = process.env.WEWORKER_SITE_MEMORY_FILE
    process.env.WEWORKER_SITE_MEMORY_FILE = path.join(memoryDir, 'site-memory.json')
    try {
      const bridge = {
        runPassiveExploration: vi.fn().mockResolvedValue({
          tabId: 7,
          pageStateBefore: { url: 'https://todo.example.com/list' },
          resultPageState: { url: 'https://todo.example.com/list', listCandidates: 3, paginationCandidates: 1 },
          pageStateAfter: { url: 'https://todo.example.com/list' },
          network: { entries: [{ method: 'GET', url: 'https://todo.example.com/api/list?page=1' }] },
          workflow: { version: 'opencli-like-v13' },
        }),
        startGenerationRun: vi.fn().mockResolvedValue({ id: 'generation-1', siteKey: 'todo.example.com', status: 'planning' }),
        getGenerationRun: vi.fn().mockResolvedValue({ id: 'generation-1', siteKey: 'todo.example.com', status: 'awaiting_approval' }),
        cancelGenerationRun: vi.fn().mockResolvedValue({ id: 'generation-1', siteKey: 'todo.example.com', status: 'cancelled' }),
        publishGenerationRun: vi.fn().mockResolvedValue({ id: 'generation-1', siteKey: 'todo.example.com', status: 'completed' }),
        refreshAdapterTabs: vi.fn().mockResolvedValue({ refreshedTabs: 1, toolCount: 1 }),
      } as unknown as BridgeRpcClient
      const fakeAgentStream = (async function* (
        _messages: unknown,
        _settings: unknown,
        _abortController: unknown,
        options: { mcpServerOverride?: unknown },
      ) {
        const server = options.mcpServerOverride as {
          instance: { _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }> }
        }
        await server.instance._registeredTools.capture_passive_exploration.handler({})
        yield { type: 'text_delta', content: '识别到列表接口。' }
        yield { type: 'done' }
      }) as unknown as typeof streamChat

      const coordinator = new ExplorationAgentCoordinator(
        bridge,
        fakeAgentStream,
        () => generationSettings(),
      )
      const started = coordinator.start('生成列表查询工具', {
        id: 7,
        title: 'Todo',
        url: 'https://todo.example.com/list',
        active: true,
        windowId: 1,
      })

      let completed = coordinator.get(started.taskId)
      for (let attempt = 0; attempt < 40 && completed?.status !== 'completed'; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        completed = coordinator.get(started.taskId)
      }
      expect(completed?.status).toBe('completed')

      const saved = coordinator.saveMemory(started.taskId)
      expect(saved.siteMemory?.siteKey).toBe('todo.example.com')
      expect(fs.existsSync(path.join(memoryDir, 'site-memory.json'))).toBe(true)

      const generation = await coordinator.startGeneration(started.taskId)
      expect(generation.generationRunId).toBe('generation-1')
      expect(bridge.startGenerationRun).toHaveBeenCalledWith(expect.objectContaining({
        siteKey: 'todo.example.com',
        tabId: 7,
        modelConfig: {
          provider: 'custom',
          protocol: 'anthropic',
          api_key: 'client-request-secret',
          base_url: 'https://open.bigmodel.cn/api/anthropic',
          model: 'glm-5.2',
        },
      }))
      expect(JSON.stringify(generation)).not.toContain('client-request-secret')

      const awaiting = await coordinator.getGeneration(started.taskId)
      expect(awaiting.generationRun?.status).toBe('awaiting_approval')
      const cancelled = await coordinator.cancelGeneration(started.taskId)
      expect(cancelled.generationRun?.status).toBe('cancelled')
      const published = await coordinator.publishGeneration(started.taskId)
      expect(published.generationRun?.status).toBe('completed')
      expect(published.generationRefresh).toEqual({ refreshedTabs: 1, toolCount: 1 })
    } finally {
      if (previousMemoryFile === undefined) delete process.env.WEWORKER_SITE_MEMORY_FILE
      else process.env.WEWORKER_SITE_MEMORY_FILE = previousMemoryFile
      fs.rmSync(memoryDir, { recursive: true, force: true })
    }
  })

  it('carries the failed generation run id into the retry request', async () => {
    const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-client-exploration-retry-'))
    const previousMemoryFile = process.env.WEWORKER_SITE_MEMORY_FILE
    process.env.WEWORKER_SITE_MEMORY_FILE = path.join(memoryDir, 'site-memory.json')
    try {
      const bridge = {
        runPassiveExploration: vi.fn().mockResolvedValue({
          tabId: 7,
          pageStateBefore: { url: 'https://todo.example.com/list' },
          resultPageState: { url: 'https://todo.example.com/list', listCandidates: 1, paginationCandidates: 0 },
          pageStateAfter: { url: 'https://todo.example.com/list' },
          network: { entries: [{ method: 'GET', url: 'https://todo.example.com/api/list?page=1' }] },
          workflow: { version: 'opencli-like-v13' },
        }),
        startGenerationRun: vi.fn()
          .mockResolvedValueOnce({ id: 'generation-1', siteKey: 'todo.example.com', status: 'planning' })
          .mockResolvedValueOnce({ id: 'generation-2', siteKey: 'todo.example.com', status: 'planning' })
          .mockResolvedValue({
            id: 'generation-3',
            siteKey: 'todo.example.com',
            status: 'needs_user_input',
            pendingQuestion: { question: '目标页面需要登录，请处理后继续', context: 'LOGIN_REQUIRED' },
          }),
        getGenerationRun: vi.fn()
          .mockResolvedValueOnce({ id: 'generation-1', siteKey: 'todo.example.com', status: 'failed', lastError: { code: 'TOOL_LOOP_MAX_STEPS' } })
          .mockResolvedValueOnce({ id: 'generation-2', siteKey: 'todo.example.com', status: 'cancelled' })
          .mockResolvedValue({ id: 'generation-3', siteKey: 'todo.example.com', status: 'needs_user_input' }),
        resumeGenerationRun: vi.fn().mockResolvedValue({ id: 'generation-3', siteKey: 'todo.example.com', status: 'awaiting_approval' }),
        listExplorableTabs: vi.fn().mockResolvedValue([{ id: 7, title: 'Todo', url: 'https://todo.example.com/list', active: true, windowId: 1 }]),
      } as unknown as BridgeRpcClient
      const fakeAgentStream = (async function* (
        _messages: unknown,
        _settings: unknown,
        _abortController: unknown,
        options: { mcpServerOverride?: unknown },
      ) {
        const server = options.mcpServerOverride as {
          instance: { _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }> }
        }
        await server.instance._registeredTools.capture_passive_exploration.handler({})
        yield { type: 'text_delta', content: '识别到列表接口。' }
        yield { type: 'done' }
      }) as unknown as typeof streamChat

      const coordinator = new ExplorationAgentCoordinator(
        bridge,
        fakeAgentStream,
        () => generationSettings(),
      )
      const started = coordinator.start('生成列表查询工具', {
        id: 7,
        title: 'Todo',
        url: 'https://todo.example.com/list',
        active: true,
        windowId: 1,
      })
      let completed = coordinator.get(started.taskId)
      for (let attempt = 0; attempt < 40 && completed?.status !== 'completed'; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        completed = coordinator.get(started.taskId)
      }
      expect(completed?.status).toBe('completed')
      const first = await coordinator.startGeneration(started.taskId)
      expect(first.generationRunId).toBe('generation-1')

      const retried = await coordinator.startGeneration(started.taskId)
      expect(retried.generationRunId).toBe('generation-2')
      expect(bridge.startGenerationRun).toHaveBeenLastCalledWith(expect.objectContaining({
        previousRunId: 'generation-1',
      }))

      await coordinator.startGeneration(started.taskId)
      expect(bridge.startGenerationRun).toHaveBeenLastCalledWith(expect.not.objectContaining({
        previousRunId: expect.anything(),
      }))

      const agentModeRun = await coordinator.startGeneration(started.taskId, undefined, 'agent')
      expect(agentModeRun.generationRunId).toBe('generation-3')
      expect(bridge.startGenerationRun).toHaveBeenLastCalledWith(expect.objectContaining({
        mode: 'agent',
      }))
      expect(agentModeRun.generationRun).toMatchObject({ status: 'needs_user_input' })

      const resumed = await coordinator.resumeGeneration(started.taskId, '已重新登录页面')
      expect(bridge.resumeGenerationRun).toHaveBeenCalledWith(
        'generation-3',
        '已重新登录页面',
        expect.objectContaining({ model: 'glm-5.2' }),
      )
      expect(resumed.generationRun).toMatchObject({ status: 'awaiting_approval' })

      const listed = coordinator.list()
      expect(listed).toEqual([expect.objectContaining({ taskId: started.taskId, hasSiteMemory: true, generationStatus: 'awaiting_approval' })])
      expect(await coordinator.listTabs()).toEqual([{ id: 7, title: 'Todo', url: 'https://todo.example.com/list' }])
      const second = await coordinator.startFromTabId('再探索一次待办能力', 7)
      expect(second.taskId).not.toBe(started.taskId)
      let secondRun = coordinator.get(second.taskId)
      for (let attempt = 0; attempt < 40 && secondRun?.status !== 'completed'; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        secondRun = coordinator.get(second.taskId)
      }
      expect(secondRun?.status).toBe('completed')
    } finally {
      if (previousMemoryFile === undefined) delete process.env.WEWORKER_SITE_MEMORY_FILE
      else process.env.WEWORKER_SITE_MEMORY_FILE = previousMemoryFile
      fs.rmSync(memoryDir, { recursive: true, force: true })
    }
  })

  it('marks restored captures and rehydrates action evidence from site memory on restart', () => {
    const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-restore-capture-'))
    const previousMemoryFile = process.env.WEWORKER_SITE_MEMORY_FILE
    process.env.WEWORKER_SITE_MEMORY_FILE = path.join(memoryDir, 'site-memory.json')
    try {
      fs.writeFileSync(process.env.WEWORKER_SITE_MEMORY_FILE, JSON.stringify({
        sites: {
          'todo.example.com': {
            siteKey: 'todo.example.com',
            siteHost: 'todo.example.com',
            updatedAt: '2026-09-14T08:00:00.000Z',
            actionApiCandidates: [{ actionName: '提交审批', method: 'POST', url: 'https://todo.example.com/api/todo/submit', toolName: 'todo.example.com.submit_todo_draft' }],
            actionCaptureHistory: [{
              actionName: '提交审批',
              method: 'POST',
              url: 'https://todo.example.com/api/todo/submit',
              toolName: 'todo.example.com.submit_todo',
            }],
          },
        },
      }))
      const runStoreFile = path.join(memoryDir, 'exploration-runs.json')
      fs.writeFileSync(runStoreFile, JSON.stringify({
        version: 1,
        runs: [{
          taskId: 'task-restored',
          status: 'completed',
          phase: 'completed',
          goal: '生成列表查询工具',
          createdAt: '2026-09-14T07:00:00.000Z',
          updatedAt: '2026-09-14T07:30:00.000Z',
          tab: { id: 7, title: 'Todo', url: 'https://todo.example.com/list', active: true, windowId: 1 },
          events: [],
          actionCapture: {
            type: 'action_capture',
            actionName: '提交审批',
            result: { capturedActions: [{ url: 'https://todo.example.com/api/todo/submit' }] },
          },
          siteMemory: {
            siteKey: 'todo.example.com',
            siteHost: 'todo.example.com',
            actionCaptureHistory: [],
          },
        }],
      }))

      const coordinator = new ExplorationAgentCoordinator(
        {} as unknown as BridgeRpcClient,
        (async function* () {}) as unknown as typeof streamChat,
        () => generationSettings(),
        runStoreFile,
      )
      const restored = coordinator.get('task-restored')

      expect(restored?.actionCapture).toMatchObject({ type: 'action_capture_restored', actionName: '提交审批' })
      expect((restored?.actionCapture as Record<string, unknown> | undefined)?.result ?? null).toBeNull()
      expect(restored?.siteMemory?.actionApiCandidates?.map((c) => c.toolName)).toEqual(['todo.example.com.submit_todo'])
      expect(restored?.siteMemory?.actionCaptureHistory).toEqual([expect.objectContaining({
        actionName: '提交审批',
        toolName: 'todo.example.com.submit_todo',
      })])
    } finally {
      if (previousMemoryFile === undefined) delete process.env.WEWORKER_SITE_MEMORY_FILE
      else process.env.WEWORKER_SITE_MEMORY_FILE = previousMemoryFile
      fs.rmSync(memoryDir, { recursive: true, force: true })
    }
  })
  it('merges a completed client action capture into the v1 Site Memory', async () => {
    const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-client-action-capture-'))
    const previousMemoryFile = process.env.WEWORKER_SITE_MEMORY_FILE
    process.env.WEWORKER_SITE_MEMORY_FILE = path.join(memoryDir, 'site-memory.json')
    try {
      const bridge = {
        runPassiveExploration: vi.fn().mockResolvedValue({
          pageStateBefore: { url: 'https://todo.example.com/list' },
          network: { entries: [{ method: 'GET', url: 'https://todo.example.com/api/list' }] },
        }),
        startActionCapture: vi.fn().mockImplementation(async (input: { actionName: string }) => ({
          type: 'action_capture_loading',
          started: true,
          actionName: input.actionName,
        })),
        stopActionCapture: vi.fn().mockResolvedValue({ type: 'action_capture_stopping', stopping: true }),
        getActionCapture: vi.fn()
          .mockResolvedValueOnce({
          type: 'action_capture',
          result: {
            site: 'todo.example.com',
            actionName: 'search_projects',
            workflow: { version: 'opencli-action-capture-v1' },
            capturedActions: [{
              url: 'https://todo.example.com/api/projects/search',
              method: 'GET',
              requestBodyPreview: '',
              responsePreview: '{"items":[]}',
              responseContentType: 'application/json',
            }, {
              url: 'https://todo.example.com/api/projects/search/detail',
              method: 'GET',
              responsePreview: '{"item":{"id":"P-1"}}',
              responseContentType: 'application/json',
            }],
            recommendation: { toolName: 'todo.example.com.search_projects' },
          },
          })
          .mockResolvedValueOnce({
            type: 'action_capture',
            result: {
              site: 'todo.example.com',
              actionName: 'open_project',
              workflow: { version: 'opencli-action-capture-v1' },
              capturedActions: [{
                url: 'https://todo.example.com/api/projects/P-2',
                method: 'GET',
                responsePreview: '{"item":{"id":"P-2"}}',
                responseContentType: 'application/json',
              }],
              recommendation: { toolName: 'todo.example.com.open_project' },
            },
          }),
        selectActionCaptureCandidate: vi.fn().mockResolvedValue({
          type: 'action_capture',
          selectedCandidateIndex: 1,
          result: {
            site: 'todo.example.com',
            actionName: 'search_projects',
            workflow: { version: 'opencli-action-capture-v1' },
            capturedActions: [{
              url: 'https://todo.example.com/api/projects/search',
              method: 'GET',
              responsePreview: '{"items":[]}',
            }, {
              url: 'https://todo.example.com/api/projects/search/detail',
              method: 'GET',
              responsePreview: '{"item":{"id":"P-1"}}',
              userSelectedPrimary: true,
            }],
            recommendation: { toolName: 'todo.example.com.search_projects' },
          },
        }),
        clearActionCapture: vi.fn().mockResolvedValue({ ok: true, cleared: true }),
      } as unknown as BridgeRpcClient
      const fakeAgentStream = (async function* () {
        yield { type: 'text_delta', content: '需要补录搜索操作。' }
        yield { type: 'done' }
      }) as unknown as typeof streamChat
      const coordinator = new ExplorationAgentCoordinator(
        bridge,
        fakeAgentStream,
        () => generationSettings({ model: 'glm-5.3' }),
      )
      const started = coordinator.start('分析列表能力', {
        id: 7,
        title: 'Todo',
        url: 'https://todo.example.com/list',
        active: true,
        windowId: 1,
      })
      let completed = coordinator.get(started.taskId)
      for (let attempt = 0; attempt < 40 && completed?.status !== 'completed'; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        completed = coordinator.get(started.taskId)
      }
      expect(completed?.status).toBe('completed')

      const capturing = await coordinator.startActionCapture(started.taskId, {
        actionName: 'search_projects',
        mode: 'intercept',
        timeoutSeconds: 60,
      })
      expect(capturing.actionCapture).toMatchObject({ type: 'action_capture_loading' })
      expect(bridge.startActionCapture).toHaveBeenCalledWith(expect.objectContaining({
        modelConfig: resolveClientGenerationModelConfig(generationSettings({ model: 'glm-5.3' })),
      }))
      expect(JSON.stringify(capturing)).not.toContain('client-request-secret')
      expect(JSON.stringify(capturing)).not.toContain('modelConfig')
      const stopping = await coordinator.stopActionCapture(started.taskId)
      expect(stopping.actionCapture).toMatchObject({ type: 'action_capture_stopping' })
      const finished = await coordinator.getActionCapture(started.taskId)
      expect(finished.actionCapture).toMatchObject({ type: 'action_capture' })
      expect(finished.siteMemory?.actionCaptureHistory?.[0]).toMatchObject({
        actionName: 'search_projects',
        url: 'https://todo.example.com/api/projects/search',
      })
      const selected = await coordinator.selectActionCaptureCandidate(started.taskId, 1)
      expect(selected.actionCapture).toMatchObject({ selectedCandidateIndex: 1 })
      expect(selected.siteMemory?.actionCaptureHistory?.some((candidate) => (
        candidate.url === 'https://todo.example.com/api/projects/search/detail'
        && candidate.primarySelection === 'user'
      ))).toBe(true)
      const cleared = await coordinator.clearActionCapture(started.taskId)
      expect(cleared.actionCapture).toBeNull()
      expect(cleared.siteMemory?.actionCaptureHistory?.length).toBeGreaterThan(0)

      await coordinator.startActionCapture(started.taskId, { actionName: 'open_project' })
      await coordinator.stopActionCapture(started.taskId)
      const secondCapture = await coordinator.getActionCapture(started.taskId)
      expect(secondCapture.siteMemory?.actionCaptureHistory).toEqual(expect.arrayContaining([
        expect.objectContaining({ actionName: 'search_projects' }),
        expect.objectContaining({ actionName: 'open_project' }),
      ]))
      expect(bridge.startActionCapture).toHaveBeenCalledWith(expect.objectContaining({ tabId: 7, siteKey: 'todo.example.com' }))
      expect(bridge.startActionCapture).toHaveBeenCalledTimes(2)
      expect(bridge.stopActionCapture).toHaveBeenCalledTimes(2)
      expect(bridge.selectActionCaptureCandidate).toHaveBeenCalledWith(expect.objectContaining({ candidateIndex: 1 }))
      expect(bridge.clearActionCapture).toHaveBeenCalledWith(expect.objectContaining({ tabId: 7 }))
    } finally {
      if (previousMemoryFile === undefined) delete process.env.WEWORKER_SITE_MEMORY_FILE
      else process.env.WEWORKER_SITE_MEMORY_FILE = previousMemoryFile
      fs.rmSync(memoryDir, { recursive: true, force: true })
    }
  })

  it('retries stored capture analysis with current settings, persists improved memory and never recaptures', async () => {
    const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-analysis-retry-'))
    const previousMemoryFile = process.env.WEWORKER_SITE_MEMORY_FILE
    process.env.WEWORKER_SITE_MEMORY_FILE = path.join(memoryDir, 'memory.json')
    try {
      const capture = {
        type: 'action_capture', tabId: 7, actionName: 'like_article', result: {
          tabId: 7, site: 'example.com', actionName: 'like_article', finishedAt: '2026-01-01T00:00:00Z',
          capturedActions: [{ method: 'POST', url: 'https://example.com/api/like' }],
          actionAnalysis: { analysisSource: 'heuristic', aiError: 'fixture output limit' },
        },
      }
      const bridge = {
        runPassiveExploration: vi.fn().mockResolvedValue({ pageStateBefore: { url: 'https://example.com/list' }, network: { entries: [] } }),
        getActionCapture: vi.fn().mockResolvedValue(capture),
        startActionCapture: vi.fn(),
        retryActionCaptureAnalysis: vi.fn().mockResolvedValue({ ...capture, type: 'action_capture_ai_loading' }),
      } as unknown as BridgeRpcClient
      const coordinator = new ExplorationAgentCoordinator(bridge, completedAgentStream, () => generationSettings({ model: 'glm-5.3' }))
      const started = coordinator.start('fixture exploration', { id: 7, title: 'Example', url: 'https://example.com/list', active: true, windowId: 1 })
      await waitForCompleted(coordinator, started.taskId)
      await coordinator.getActionCapture(started.taskId)
      const retried = await coordinator.retryActionCaptureAnalysis(started.taskId)
      expect(retried.actionCapture?.type).toBe('action_capture_ai_loading')
      expect(bridge.retryActionCaptureAnalysis).toHaveBeenCalledWith(expect.objectContaining({ tabId: 7, actionName: 'like_article', modelConfig: { provider: 'custom', protocol: 'anthropic', api_key: 'client-request-secret', base_url: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-5.3' } }))
      expect(bridge.startActionCapture).not.toHaveBeenCalled()
      expect(JSON.stringify(retried)).not.toContain('client-request-secret')
      vi.mocked(bridge.getActionCapture).mockResolvedValue({ ...capture, result: { ...capture.result, actionAnalysis: { analysisSource: 'ai', model: 'glm-5.3' } } })
      const finished = await coordinator.getActionCapture(started.taskId)
      expect((finished.actionCapture?.result as Record<string, unknown>).actionAnalysis).toMatchObject({ analysisSource: 'ai' })
      expect(finished.siteMemory?.actionCaptureHistory?.length).toBeGreaterThan(0)
      vi.mocked(bridge.getActionCapture).mockResolvedValue(null)
      await expect(coordinator.retryActionCaptureAnalysis(started.taskId)).rejects.toThrow('已无可分析的捕获证据')
      vi.mocked(bridge.getActionCapture).mockResolvedValue({ ...capture, type: 'action_capture_ai_loading' })
      await expect(coordinator.retryActionCaptureAnalysis(started.taskId)).rejects.toThrow('仍在进行中')
      expect(bridge.retryActionCaptureAnalysis).toHaveBeenCalledTimes(1)
    } finally {
      if (previousMemoryFile === undefined) delete process.env.WEWORKER_SITE_MEMORY_FILE
      else process.env.WEWORKER_SITE_MEMORY_FILE = previousMemoryFile
      fs.rmSync(memoryDir, { recursive: true, force: true })
    }
  })

  it('keeps captured evidence usable when Agent analysis is temporarily unavailable', async () => {
    const bridge = {
      runPassiveExploration: vi.fn().mockResolvedValue({
        pageStateBefore: { url: 'https://fallback.example.com/list' },
        network: { entries: [{ method: 'GET', url: 'https://fallback.example.com/api/list' }] },
      }),
    } as unknown as BridgeRpcClient
    const fakeAgentStream = (async function* () {
      yield { type: 'error', content: 'model temporarily unavailable' }
    }) as unknown as typeof streamChat
    const coordinator = new ExplorationAgentCoordinator(
      bridge,
      fakeAgentStream,
      () => ({ model: 'test' }) as Settings,
    )
    const started = coordinator.start('分析列表能力', {
      id: 8,
      title: 'Fallback',
      url: 'https://fallback.example.com/list',
      active: true,
      windowId: 1,
    })

    let completed = coordinator.get(started.taskId)
    for (let attempt = 0; attempt < 40 && completed?.status !== 'completed'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      completed = coordinator.get(started.taskId)
    }

    expect(completed?.status).toBe('completed')
    expect(completed?.analysisError).toBe('model temporarily unavailable')
    expect(completed?.summary).toContain('仍可保存结果')
    expect(JSON.stringify(completed?.evidence)).not.toContain('network":{"entries')
    expect(completed?.evidence).toMatchObject({
      analysisV2: {
        schemaVersion: 2,
        candidates: [expect.objectContaining({ endpointFamily: 'GET /api/list' })],
      },
    })
  })

  it('restores a completed task and its Generation Harness run after Backend reconstruction', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-exploration-run-store-'))
    const runStoreFile = path.join(tempDir, 'runs.json')
    const siteMemoryFile = path.join(tempDir, 'site-memory.json')
    const previousMemoryFile = process.env.WEWORKER_SITE_MEMORY_FILE
    process.env.WEWORKER_SITE_MEMORY_FILE = siteMemoryFile
    try {
      const firstBridge = {
        runPassiveExploration: vi.fn().mockResolvedValue({
          pageStateBefore: {
            url: 'https://restore.example.com/list?keyword=ExampleUser&building=ExampleBuilding&token=raw-secret#/view?owner=Bob',
          },
          network: {
            entries: [{
              method: 'GET',
              url: 'https://restore.example.com/api/list?api_key=raw-secret',
              headers: { Authorization: 'Bearer raw-secret' },
            }],
          },
        }),
        startGenerationRun: vi.fn().mockResolvedValue({
          id: 'generation-restored',
          siteKey: 'restore.example.com',
          status: 'planning',
        }),
      } as unknown as BridgeRpcClient
      const first = new ExplorationAgentCoordinator(
        firstBridge,
        completedAgentStream,
        () => generationSettings(),
        runStoreFile,
      )
      const started = first.start('生成列表查询工具', {
        id: 71,
        title: 'Restore',
        url: 'https://restore.example.com/list?keyword=ExampleUser&token=tab-secret',
        active: true,
        windowId: 1,
      })
      await waitForCompleted(first, started.taskId)
      first.saveMemory(started.taskId)
      await first.startGeneration(started.taskId)

      const persisted = fs.readFileSync(runStoreFile, 'utf8')
      expect(persisted).not.toContain('raw-secret')
      expect(persisted).not.toContain('tab-secret')
      expect(persisted).not.toContain('client-request-secret')
      expect(persisted).not.toContain('ExampleUser')
      expect(persisted).not.toContain('ExampleBuilding')
      expect(persisted).not.toContain('Bob')
      expect(persisted).toContain('keyword=%3Avalue')
      expect(persisted).toContain('owner=%3Avalue')
      const persistedMemory = fs.readFileSync(siteMemoryFile, 'utf8')
      expect(persistedMemory).not.toContain('ExampleUser')
      expect(persistedMemory).not.toContain('ExampleBuilding')
      expect(persistedMemory).not.toContain('Bob')
      expect(persistedMemory).toContain('keyword=%3Avalue')
      expect(persistedMemory).toContain('owner=%3Avalue')
      if (process.platform !== 'win32') {
        expect(fs.statSync(runStoreFile).mode & 0o077).toBe(0)
      }

      const restoredBridge = {
        getGenerationRun: vi.fn().mockResolvedValue({
          id: 'generation-restored',
          siteKey: 'restore.example.com',
          status: 'awaiting_approval',
        }),
      } as unknown as BridgeRpcClient
      const restored = new ExplorationAgentCoordinator(
        restoredBridge,
        completedAgentStream,
        () => generationSettings(),
        runStoreFile,
      )
      expect(restored.get(started.taskId)).toMatchObject({
        status: 'completed',
        generationRunId: 'generation-restored',
        generationRun: { status: 'planning' },
      })
      const resumed = await restored.getGeneration(started.taskId)
      expect(resumed.generationRun).toMatchObject({ status: 'awaiting_approval' })
      expect(restoredBridge.getGenerationRun).toHaveBeenCalledWith('generation-restored')
    } finally {
      if (previousMemoryFile === undefined) delete process.env.WEWORKER_SITE_MEMORY_FILE
      else process.env.WEWORKER_SITE_MEMORY_FILE = previousMemoryFile
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('marks an interrupted passive exploration as failed after Backend reconstruction', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-exploration-interrupted-'))
    const runStoreFile = path.join(tempDir, 'runs.json')
    try {
      const now = new Date().toISOString()
      fs.writeFileSync(runStoreFile, JSON.stringify({
        version: 1,
        runs: [{
          taskId: 'interrupted-task',
          goal: '分析 API',
          tab: { id: 72, title: 'Interrupted', url: 'https://interrupted.example.com', active: true, windowId: 1 },
          status: 'running',
          phase: 'exploring',
          createdAt: now,
          updatedAt: now,
          summary: '',
          evidence: null,
          siteMemory: null,
          generationRunId: null,
          generationRun: null,
          generationRefresh: null,
          generationRefreshError: null,
          scaffoldResult: null,
          actionCapture: null,
          analysisError: null,
          error: null,
          events: [],
        }],
      }))

      const restored = new ExplorationAgentCoordinator(
        {} as BridgeRpcClient,
        completedAgentStream,
        () => generationSettings(),
        runStoreFile,
      )
      expect(restored.get('interrupted-task')).toMatchObject({
        status: 'failed',
        phase: 'failed',
        error: '客户端服务在 API 探索过程中重启，请重新开始探索。',
      })
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('restores an active action capture and reconciles its final result', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-action-capture-restore-'))
    const runStoreFile = path.join(tempDir, 'runs.json')
    const previousMemoryFile = process.env.WEWORKER_SITE_MEMORY_FILE
    process.env.WEWORKER_SITE_MEMORY_FILE = path.join(tempDir, 'site-memory.json')
    try {
      const firstBridge = {
        runPassiveExploration: vi.fn().mockResolvedValue({
          pageStateBefore: { url: 'https://capture.example.com/list' },
          network: { entries: [{ method: 'GET', url: 'https://capture.example.com/api/list' }] },
        }),
        startActionCapture: vi.fn().mockResolvedValue({
          type: 'action_capture_loading',
          actionName: 'search_items',
          tabId: 73,
        }),
      } as unknown as BridgeRpcClient
      const first = new ExplorationAgentCoordinator(
        firstBridge,
        completedAgentStream,
        () => generationSettings(),
        runStoreFile,
      )
      const started = first.start('分析搜索接口', {
        id: 73,
        title: 'Capture',
        url: 'https://capture.example.com/list',
        active: true,
        windowId: 1,
      })
      await waitForCompleted(first, started.taskId)
      await first.startActionCapture(started.taskId, { actionName: 'search_items' })

      const restoredBridge = {
        getActionCapture: vi.fn().mockResolvedValue({
          type: 'action_capture',
          result: {
            site: 'capture.example.com',
            actionName: 'search_items',
            finishedAt: new Date().toISOString(),
            workflow: { version: 'opencli-action-capture-v1' },
            capturedActions: [{
              method: 'GET',
              url: 'https://capture.example.com/api/search?q=test',
              responsePreview: '{"items":[]}',
            }],
          },
        }),
      } as unknown as BridgeRpcClient
      const restored = new ExplorationAgentCoordinator(
        restoredBridge,
        completedAgentStream,
        () => generationSettings(),
        runStoreFile,
      )
      expect(restored.get(started.taskId)?.actionCapture).toMatchObject({ type: 'action_capture_loading' })
      const reconciled = await restored.getActionCapture(started.taskId)
      expect(reconciled.actionCapture).toMatchObject({ type: 'action_capture' })
      expect(reconciled.siteMemory?.actionCaptureHistory?.[0]).toMatchObject({ actionName: 'search_items' })
    } finally {
      if (previousMemoryFile === undefined) delete process.env.WEWORKER_SITE_MEMORY_FILE
      else process.env.WEWORKER_SITE_MEMORY_FILE = previousMemoryFile
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('turns a missing restored action capture into a recoverable terminal state', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-action-capture-missing-'))
    const runStoreFile = path.join(tempDir, 'runs.json')
    const previousMemoryFile = process.env.WEWORKER_SITE_MEMORY_FILE
    process.env.WEWORKER_SITE_MEMORY_FILE = path.join(tempDir, 'site-memory.json')
    try {
      const bridge = {
        runPassiveExploration: vi.fn().mockResolvedValue({
          pageStateBefore: { url: 'https://missing.example.com/list' },
          network: { entries: [{ method: 'GET', url: 'https://missing.example.com/api/list' }] },
        }),
        startActionCapture: vi.fn().mockResolvedValue({
          type: 'action_capture_loading',
          actionName: 'search_items',
          tabId: 74,
        }),
        getActionCapture: vi.fn().mockResolvedValue(null),
      } as unknown as BridgeRpcClient
      const first = new ExplorationAgentCoordinator(
        bridge,
        completedAgentStream,
        () => generationSettings(),
        runStoreFile,
      )
      const started = first.start('分析搜索接口', {
        id: 74,
        title: 'Missing',
        url: 'https://missing.example.com/list',
        active: true,
        windowId: 1,
      })
      await waitForCompleted(first, started.taskId)
      await first.startActionCapture(started.taskId, { actionName: 'search_items' })

      const restored = new ExplorationAgentCoordinator(
        bridge,
        completedAgentStream,
        () => generationSettings(),
        runStoreFile,
      )
      const reconciled = await restored.getActionCapture(started.taskId)
      expect(reconciled.actionCapture).toMatchObject({
        type: 'action_capture_error',
        code: 'ACTION_CAPTURE_SESSION_LOST',
        recoverable: true,
      })
      expect(reconciled.actionCapture?.error).toContain('重新录制')
    } finally {
      if (previousMemoryFile === undefined) delete process.env.WEWORKER_SITE_MEMORY_FILE
      else process.env.WEWORKER_SITE_MEMORY_FILE = previousMemoryFile
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
