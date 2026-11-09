import { tool, createSdkMcpServer, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getUserDirectory } from './config.js'
import { listFiles } from './file-tools.js'
import { assertPathInsideUserDirectory } from './user-directory-guard.js'
import type { ChannelPermissionMode } from './channels/channel-permissions.js'
import { runWithWorkspaceDirectory } from './workspace-access-context.js'
import * as store from './works-store.js'
import { scheduler, Scheduler } from './scheduler.js'
import { channelManager } from './channels/channel-manager.js'
import { getAgent, addAgentWork } from './dedicated-agents/agent-store.js'
import { describeUserFile, NO_FILE_DELIVERY, NO_IMAGE_DELIVERY, readUserImage, type UserMediaSink } from './user-media.js'
import {
  getLatestCacheFile,
  readCacheResult,
  isCacheFresh,
  WEBCLI_RESULT_CACHE_TTL_MS,
} from './webcli-result-cache.js'
import { projectResult } from './webcli-result-project.js'
import { checkFileEncryptionCached } from './encryption-check-cache.js'
import { createLogger } from './logger.js'
import { runWeWorkerPowerShell } from './powershell-runner.js'
import { getCatalog } from './api-query-router/tool-catalog.js'
import { classifyDispatchPayload } from './api-query-router/route-dispatch.js'
import { runWebcliCall } from './webcli-runner.js'
import { issueReadQueryReceipt, READ_QUERY_RECEIPT_FIELD, type ReadQueryScope } from './read-query-receipts.js'

const log = createLogger('tools')

// ── ask_user pending requests（实现见 ask-user-pending.ts，此处 re-export 保留既有导入路径）──
import {
  requestUserChoice,
  setPendingAskUser,
  resolvePendingAskUser,
  hasPendingAskUser,
  getPendingAskUser,
  type AskUserRequest,
} from './ask-user-pending.js'
export {
  setPendingAskUser,
  resolvePendingAskUser,
  hasPendingAskUser,
  getPendingAskUser,
  type AskUserRequest,
}

type AskUserSSECallback = (event: { type: string; id: string; question: string; options: Array<{ label: string; description?: string }> }) => void
type ChannelAskUserHandler = (question: string, options: Array<{ label: string; description?: string }>) => Promise<string>

/**
 * 鸭子类型：聊天 MCP 工具只依赖 ExplorationAgentCoordinator 的公开方法子集，
 * 避免 tools.ts → exploration-agent.ts → agent.ts → tools.ts 的模块环。
 */
interface ExplorationCoordinatorToolTarget {
  list(): Array<Record<string, unknown>>
  listTabs(): Promise<Array<{ id: number, title: string, url: string }>>
  startFromTabId(goal: string, tabId: number): Promise<unknown>
  get(taskId: string): unknown
  startGeneration(taskId: string, goal?: string, mode?: 'auto' | 'agent' | 'classic' | 'quick'): Promise<unknown>
  resumeGeneration(taskId: string, answer: string): Promise<unknown>
  publishGeneration(taskId: string): Promise<unknown>
}

let explorationCoordinatorProvider: (() => ExplorationCoordinatorToolTarget | null) | null = null

export function registerExplorationCoordinator(provider: () => ExplorationCoordinatorToolTarget | null): void {
  explorationCoordinatorProvider = provider
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function toolText(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] }
}

function generationSummaryView(run: unknown): Record<string, unknown> {
  const source = asRecord(run)
  const generation = asRecord(source.generationRun)
  const artifacts = asRecord(generation.artifacts)
  const draft = asRecord(artifacts.draft)
  const pendingQuestion = asRecord(generation.pendingQuestion || asRecord(artifacts.pendingQuestion))
  const blocker = asRecord(asRecord(artifacts.blockerNote))
  const attribution = asRecord(generation.failureAttribution)
  return {
    taskId: source.taskId || '',
    status: generation.status || '',
    currentAction: generation.currentAction || '',
    toolNames: Array.isArray(draft.toolNames) ? draft.toolNames : [],
    staticValidationPassed: asRecord(artifacts.staticValidation).passed === true,
    runtimeValidationPassed: asRecord(artifacts.runtimeValidation).passed === true,
    pendingQuestion: typeof pendingQuestion.question === 'string' && pendingQuestion.question
      ? { question: pendingQuestion.question, context: typeof pendingQuestion.context === 'string' ? pendingQuestion.context : '' }
      : null,
    blockerQuestion: typeof blocker.question === 'string' ? blocker.question : '',
    failureSummary: typeof attribution.summary === 'string' ? attribution.summary : '',
    lastErrorCode: asRecord(generation.lastError).code || '',
  }
}

function buildExplorationChatTools(coordinator: ExplorationCoordinatorToolTarget) {
  return [
    tool(
      'list_explorable_tabs',
      '列出当前 Chrome 中可进行 API 探索的 HTTP(S) 页面。开始探索前先调用本工具获取 tabId。',
      {},
      async () => {
        try {
          return toolText({ tabs: await coordinator.listTabs() })
        } catch (e) {
          return toolText({ error: e instanceof Error ? e.message : String(e) })
        }
      },
    ),
    tool(
      'start_api_exploration',
      '对一个已打开的页面启动客户端 API 探索（被动捕获 Fetch/XHR 并分析证据）。返回 taskId，完成后可用 start_adapter_generation 生成 Adapter。',
      {
        tabId: z.number().int().describe('目标页面 id，来自 list_explorable_tabs'),
        goal: z.string().min(1).max(2_000).describe('希望分析的 API 能力描述，例如"沉淀会议室查询能力"'),
      },
      async ({ tabId, goal }) => {
        try {
          const run = await coordinator.startFromTabId(goal, tabId)
          const source = asRecord(run)
          return toolText({ taskId: source.taskId, status: source.status, hint: '探索在后台执行，用 list_api_explorations 查询进度' })
        } catch (e) {
          return toolText({ error: e instanceof Error ? e.message : String(e) })
        }
      },
    ),
    tool(
      'list_api_explorations',
      '列出探索任务及各自的生成状态（taskId、站点、状态、是否已保存站点记忆、生成状态）。需要 taskId 时先调用本工具。',
      {},
      async () => {
        try {
          return toolText({ runs: coordinator.list() })
        } catch (e) {
          return toolText({ error: e instanceof Error ? e.message : String(e) })
        }
      },
    ),
    tool(
      'start_adapter_generation',
      '对已完成的探索任务生成并验证 API Adapter。默认 auto：先直接生成并验证，具体错误才限时智能修复一次；agent 用于复杂场景。通过验证后等待安装确认。',
      {
        taskId: z.string().min(1).max(100).describe('探索任务 id，来自 list_api_explorations'),
        goal: z.string().min(1).max(2_000).optional().describe('生成目标描述'),
        mode: z.enum(['auto', 'agent', 'classic', 'quick']).optional().describe('auto=默认生成并验证；quick=仅快速生成；agent=复杂场景智能生成；classic=固定智能流水线'),
      },
      async ({ taskId, goal, mode }) => {
        try {
          const run = await coordinator.startGeneration(taskId, goal, mode)
          return toolText(generationSummaryView(run))
        } catch (e) {
          return toolText({ error: e instanceof Error ? e.message : String(e) })
        }
      },
    ),
    tool(
      'get_adapter_generation',
      '查询生成任务状态：阶段、工具清单、验证结果、等待用户的问题（pendingQuestion）、失败归因（failureSummary）。status=needs_user_input 时必须把 pendingQuestion.question 转述给用户并用 resume_adapter_generation 提交回答。',
      {
        taskId: z.string().min(1).max(100),
      },
      async ({ taskId }) => {
        try {
          return toolText(generationSummaryView(coordinator.get(taskId)))
        } catch (e) {
          return toolText({ error: e instanceof Error ? e.message : String(e) })
        }
      },
    ),
    tool(
      'resume_adapter_generation',
      '提交用户对 pendingQuestion 的回答并从暂停点继续生成（同一对话上下文）。',
      {
        taskId: z.string().min(1).max(100),
        answer: z.string().min(1).max(4_000).describe('用户的回答原文'),
      },
      async ({ taskId, answer }) => {
        try {
          return toolText(generationSummaryView(await coordinator.resumeGeneration(taskId, answer)))
        } catch (e) {
          return toolText({ error: e instanceof Error ? e.message : String(e) })
        }
      },
    ),
    tool(
      'publish_adapter_generation',
      '确认发布：把通过验证的工具安装到本机 Skill 目录并刷新目标页面。仅当生成状态为 awaiting_approval 且用户明确同意后调用。',
      {
        taskId: z.string().min(1).max(100),
      },
      async ({ taskId }) => {
        try {
          const run = await coordinator.publishGeneration(taskId)
          const source = asRecord(run)
          return toolText({
            taskId,
            status: asRecord(source.generationRun).status || '',
            refreshError: typeof source.generationRefreshError === 'string' ? source.generationRefreshError : '',
            published: true,
          })
        } catch (e) {
          return toolText({ error: e instanceof Error ? e.message : String(e) })
        }
      },
    ),
  ]
}

interface McpServerContext {
  workspaceDirectory?: string
  platform?: NodeJS.Platform
  channelPermissionMode?: ChannelPermissionMode
  workId?: string | null
  /**
   * Work resolved at tool-call time. A pre-started chat session is created
   * before its work is known and is bound to the work on its first turn.
   */
  workIdRef?: { current: string | null }
  abortSignal?: AbortSignal | null
  askUserSSECallback?: AskUserSSECallback | null
  channelAskUserHandler?: ChannelAskUserHandler | null
  /**
   * Where send_image_to_user / send_file_to_user deliver: the current turn's
   * conversation, resolved at call time (a reused session rebinds it per turn).
   */
  userMedia?: () => UserMediaSink | null
  /** Dedicated Agent identity comes from the trusted runtime, never model input. */
  dedicatedAgent?: { agentId: string; ownerUserId: string; actorUserId?: string; taskId?: string }
  /** Trusted per-turn binding; never populated from model-supplied arguments. */
  readQueryScope?: () => ReadQueryScope | null
}

/** Names only: used by the context inspector, never sent as an extra prompt. */
export function getMcpToolDefinitionSummary(mode: ChannelPermissionMode = 'full'): string {
  if (mode === 'qa_only') return ''
  const names = [
    'webcli_result',
    'weworker_read_query',
    'weworker_powershell',
    'ask_user',
    'create_scheduled_task',
    'list_scheduled_tasks',
    'list_files',
    'send_file_to_user',
    'send_image_to_user',
  ]
  if (process.platform === 'win32') names.push('check_file_encryption', 'decrypt_file')
  return names.join('\n')
}

export function resolveToolDisplayName(sdkName: string): string {
  return sdkName.replace(/^mcp__weworker__/, '')
}

// ── File decrypt helpers (Windows only) ───────────────────────────────────────

function _findDecryptExe(): string | null {
  const resourcesPath = process.env.WEWORKER_RESOURCES_PATH || ''
  const candidates = [
    ...(resourcesPath ? [path.join(resourcesPath, 'tools', 'sd_decrypt.exe')] : []),
    path.join(process.cwd(), '..', 'build', 'decrypt-dist', 'sd_decrypt.exe'),
    path.join(process.cwd(), 'build', 'decrypt-dist', 'sd_decrypt.exe'),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return null
}

// ── Encryption check cache (work-scoped, keyed by path + mtime) ────────────────
// Avoids re-spawning sd_decrypt.exe for an unchanged file within a work.
// Implementation + TTL in ./encryption-check-cache.ts; mtime in the key means
// decrypt_file rewriting the file auto-invalidates the cached result.

// ── MCP Server (weworker-specific tools only) ─────────────────────────────────

export function buildMcpServer(opts?: McpServerContext) {
  const fixedWorkId = opts?.workId ?? null
  const currentWorkId = (): string | null => (opts?.workIdRef ? opts.workIdRef.current : fixedWorkId)
  const abortSignal = opts?.abortSignal ?? null
  const askUserSSECallback = opts?.askUserSSECallback ?? null
  const channelAskUserHandler = opts?.channelAskUserHandler ?? null
  const currentUserMedia = (): UserMediaSink | null => opts?.userMedia?.() ?? null
  const channelPermissionMode = opts?.channelPermissionMode ?? 'full'
  const dedicatedAgent = opts?.dedicatedAgent
  const dedicatedChannelKey = dedicatedAgent ? `agent:${dedicatedAgent.agentId}` : ''
  const isDedicatedOwner = !!dedicatedAgent?.ownerUserId
    && (!dedicatedAgent.actorUserId || dedicatedAgent.actorUserId === dedicatedAgent.ownerUserId)
  const platform = opts?.platform ?? process.platform
  const toolDirectory = opts?.workspaceDirectory || getUserDirectory()
  const fileToolDescription = channelPermissionMode === 'workspace'
    ? `文件操作限制在工作区 ${toolDirectory} 内，并遵循文件黑名单。`
    : channelPermissionMode === 'ask'
      ? '每次文件操作都需要用户确认；确认后可访问任意路径。'
      : channelPermissionMode === 'full'
        ? '文件操作不受工作区、白名单或黑名单限制。'
        : '文件操作范围由当前权限模式决定。'
  const shellToolDescription = channelPermissionMode === 'workspace'
    ? 'Commands must follow workspace path, blacklist, and site allowlist rules.'
    : channelPermissionMode === 'ask'
      ? 'Every command requires user confirmation; after approval it may access any path or site.'
      : channelPermissionMode === 'full'
        ? 'Commands are unrestricted by workspace, allowlist, or blacklist settings.'
        : 'Commands follow the active permission mode.'
  const shellPathDescription = channelPermissionMode === 'workspace'
    ? 'Commands must comply with the bound workspace and file blacklist.'
    : channelPermissionMode === 'ask'
      ? 'Commands require user confirmation before execution and may access any path after approval.'
      : channelPermissionMode === 'full'
        ? 'Commands may access any path without workspace, allowlist, or blacklist restrictions.'
        : 'Commands must comply with WeWorker user-directory restrictions.'
  const shellCwdDescription = channelPermissionMode === 'workspace'
    ? 'Defaults to the bound workspace and must remain inside it.'
    : channelPermissionMode === 'ask'
      ? 'Defaults to the configured user directory; any working directory requires user confirmation.'
      : channelPermissionMode === 'full'
        ? 'Defaults to the configured user directory; any working directory is allowed.'
        : 'Defaults to the configured user directory and must stay inside it.'

  if (opts?.channelPermissionMode === 'qa_only') {
    return createSdkMcpServer({
      name: 'weworker-tools',
      version: '1.0.0',
      tools: [],
    })
  }

  const readQueryTool = (channelPermissionMode === 'full' || channelPermissionMode === 'workspace')
    && !dedicatedAgent && opts?.readQueryScope
    ? [tool(
      'weworker_read_query',
      '执行已启用 Adapter 的只读直调查询（非 Shell）。只传完整工具名及符合当前工具 JSON Schema 的 args；查询成功会返回可信回执供后端学习。其他 WebCLI 命令仍使用原生命令工具。',
      {
        name: z.string().min(3).max(200).describe('当前已启用 Adapter 的完整工具名，例如 public.example.list'),
        args: z.record(z.string(), z.unknown()).describe('工具的 JSON 对象参数，不接受命令行字符串'),
      },
      async ({ name, args }) => {
        const scope = opts.readQueryScope?.()
        if (!scope?.workId || !scope.turnId || currentWorkId() !== scope.workId || abortSignal?.aborted) {
          return toolText({ error: 'Read query is not available for this turn' })
        }
        const selected = getCatalog().byName.get(name)
        if (!selected || !selected.direct || selected.safety !== 'read' || selected.requiresConfirmation
          || selected.navigateBefore || !getCatalog().adapterIds.has(selected.adapterId)) {
          return toolText({ error: 'Tool is not an enabled read-only direct query' })
        }
        // Fail closed for incomplete/unsupported JSON schemas; do not coerce values,
        // remove unknown keys, or accept flags that could override WebCLI options.
        const schema = selected.parameters
        if (schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object'
          || Array.isArray(schema.properties) || schema.additionalProperties !== false
          || !args || typeof args !== 'object' || Array.isArray(args)
          || Object.keys(args).some((key) => key.startsWith('-') || key === '__proto__' || key === 'constructor' || key === 'prototype')) {
          return toolText({ error: 'Unsupported query arguments schema' })
        }
        let validator: z.ZodType
        try { validator = z.fromJSONSchema(schema) } catch { return toolText({ error: 'Unsupported query arguments schema' }) }
        const valid = validator.safeParse(args)
        if (!valid.success) return toolText({ error: 'Query arguments do not match current tool schema' })
        // No results or args ever enter the receipt. Keep only primitive, bounded,
        // explicitly declared fields and discard potential secrets/identifiers.
        const fixedArgs: Record<string, string | number | boolean> = {}
        const properties = schema.properties as Record<string, unknown>
        let learnableArgs = true
        for (const [key, value] of Object.entries(args)) {
          const field = properties[key] as Record<string, unknown> | undefined
          const isSafeNumber = typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1000
            && /^(page|pageSize|limit|offset|size|count|perPage)$/i.test(key)
          const isSafeBoolean = typeof value === 'boolean' && /^(ascending|descending|includeArchived|includeClosed)$/i.test(key)
          if (!field || (!isSafeNumber && !isSafeBoolean)) { learnableArgs = false; break }
          fixedArgs[key] = value as number | boolean
        }
        try {
          const raw = await runWebcliCall(name, JSON.stringify(args), scope.workId, { timeoutMs: 30_000 })
          if (abortSignal?.aborted || opts.readQueryScope?.()?.turnId !== scope.turnId || currentWorkId() !== scope.workId) {
            return toolText({ error: 'Read query turn expired' })
          }
          // Shell exit code is not business success. Reject any uncertain shape,
          // including cached large-output pointers and ambiguous empty arrays.
          let parsed: unknown
          try { parsed = JSON.parse(raw) } catch { return toolText({ error: 'Read query returned non-JSON output' }) }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
            || (parsed as Record<string, unknown>).type === 'large_output'
            || classifyDispatchPayload(raw)) return toolText({ result: parsed ?? raw })
          const record = parsed as Record<string, unknown>
          if (record.error || record.ok === false || record.success === false
            || ('code' in record && record.code !== 200 && record.code !== '200')
            || ('status' in record && record.status !== 200 && record.status !== '200')
            || (record.ok !== true && record.success !== true && record.code !== 200 && record.code !== '200'
              && record.status !== 200 && record.status !== '200')) return toolText({ result: parsed })
          // The learner must never replay an incomplete args subset or a bare
          // success flag with no actual data. An ordinary query can still answer
          // the Agent when it isn't safely reusable for learning.
          const hasData = ['data', 'result', 'items', 'list', 'records', 'rows', 'tickets'].some((key) => {
            const value = record[key]
            return Array.isArray(value) ? value.length > 0 : value != null && typeof value === 'object' && Object.keys(value).length > 0
          })
          if (!learnableArgs || !hasData) return toolText({ result: parsed })
          const token = issueReadQueryReceipt(scope, { tool: name, fixedArgs })
          if (!token) return toolText({ result: parsed })
          return toolText({ result: parsed, [READ_QUERY_RECEIPT_FIELD]: token })
        } catch {
          return toolText({ error: 'Read query failed' })
        }
      },
    )] : []

  const systemTools = [
    ...readQueryTool,
    tool(
      'webcli_result',
      `读取 webcli 工具落盘的大结果（large_output 指针）并按需投影成精简文本，避免大模型直接读取超大 JSON。当 webcli 工具返回 type="large_output" 的指针时，用本工具查具体内容。缓存有 ${Math.round(WEBCLI_RESULT_CACHE_TTL_MS / 60000)} 分钟有效期，过期会提示重新调用原查询刷新。`,
      {
        file: z.string().optional().describe('缓存文件绝对路径（来自 large_output 指针的 file 字段）。省略时取本会话最近一次大结果。'),
        mode: z.enum(['summary', 'keys', 'page', 'pick', 'item']).optional().describe('summary=可读总览(默认,剥raw)；keys=查看结构；page=分页(剥raw)；pick=挑字段；item=取单条(可选含raw)。'),
        fields: z.string().optional().describe('pick 模式：逗号分隔字段名(支持 a.b 路径)。'),
        keyword: z.string().optional().describe('page 模式：按关键字过滤数组项(匹配任意字段)。'),
        index: z.number().int().optional().describe('item 模式：数组下标(0 起)。'),
        page: z.number().int().optional().describe('page 模式：页码(默认 1)。'),
        pageSize: z.number().int().optional().describe('page 模式：每页条数(默认 20)。'),
        includeRaw: z.boolean().optional().describe('item 模式：是否包含原始 raw 字段(默认 false)。'),
      },
      async ({ file, mode, fields, keyword, index, page, pageSize, includeRaw }) => {
        try {
          let resolved = file ? assertPathInsideUserDirectory(file, 'file') : getLatestCacheFile(currentWorkId())
          if (!resolved) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  type: 'no_cached_result',
                  hint: '没有可读取的缓存结果。请先调用原 webcli 工具，再用返回的 large_output 指针里的 file 路径读取。',
                }),
              }],
            }
          }
          if (!isCacheFresh(resolved)) {
            const mtimeMs = (() => { try { return fs.statSync(resolved).mtimeMs } catch { return null } })()
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  type: 'cache_expired',
                  file: resolved,
                  savedAt: mtimeMs ? new Date(mtimeMs).toISOString() : null,
                  ttlMs: WEBCLI_RESULT_CACHE_TTL_MS,
                  hint: '缓存已过期，请重新调用原 webcli 工具刷新后再读取，避免给出陈旧结果。',
                }),
              }],
            }
          }
          const obj = readCacheResult(resolved)
          const text = projectResult(obj, {
            mode: mode ?? 'summary',
            fields,
            keyword,
            index,
            page,
            pageSize,
            includeRaw,
          })
          return { content: [{ type: 'text' as const, text }] }
        } catch (e) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) }] }
        }
      },
    ),
    tool(
      'weworker_powershell',
      `Run a local command through WeWorker Shell with live output visible in the terminal panel. ${shellToolDescription}`,
      {
        command: z.string().describe(`Shell command to run. ${shellPathDescription}`),
        cwd: z.string().optional().describe(`Working directory. ${shellCwdDescription}`),
        shell: z.enum(['bash', 'powershell']).optional().describe('Shell to use. Defaults to PowerShell on Windows and bash elsewhere.'),
        outputEncoding: z.string().optional().describe('Terminal stdout/stderr decoding label. Defaults to utf-8, and Windows native commands such as xcopy/copy/dir are auto-decoded as gbk unless explicitly set.'),
      },
      async ({ command, cwd, shell, outputEncoding }) => {
        try {
          const result = await runWeWorkerPowerShell({
            command,
            cwd,
            shell,
            outputEncoding,
            source: 'ai',
            workId: currentWorkId(),
            signal: abortSignal,
          })
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: result.exitCode === 0,
                sessionId: result.sessionId,
                shell: result.shell,
                outputEncoding: result.outputEncoding,
                exitCode: result.exitCode,
                signal: result.signal,
                cwd: result.cwd,
                output: result.output,
              }, null, 2),
            }],
          }
        } catch (e) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
            }],
          }
        }
      },
    ),
    tool(
      'ask_user',
      '向用户提出选择题，等待用户回答后返回结果。当操作涉及用户偏好决策时使用（如支付方式、商品选择、收货地址等）。选项应尽量来自前一步工具返回的真实数据。',
      {
        question: z.string().describe('要问用户的问题'),
        options: z.array(z.object({
          label: z.string().describe('选项标签（用户看到的文字）'),
          description: z.string().optional().describe('选项的补充说明'),
        })).describe('可选项列表（2-6个）'),
      },
      async ({ question, options }) => {
        if (channelAskUserHandler) {
          const answer = await channelAskUserHandler(question, options)
          return { content: [{ type: 'text' as const, text: JSON.stringify({ answer }) }] }
        }
        const workId = currentWorkId()
        if (!workId) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No active work context' }) }] }
        }

        const toolCallId = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

        if (!askUserSSECallback) return toolText({ error: '当前会话无法显示用户问题' })
        const answer = await requestUserChoice({
          workId, toolCallId, question, options,
          onChoice: askUserSSECallback, signal: abortSignal ?? undefined,
        })

        return { content: [{ type: 'text' as const, text: JSON.stringify({ answer }) }] }
      }
    ),

    tool(
      'list_agent_notification_targets',
      '列出当前WeWorker Bot 已观察到、可由主人授权给定时任务的企业微信单聊或群聊目标。只能选择此列表中的 target_id，不能猜测或填写其他群/用户。',
      {},
      async () => {
        if (!dedicatedAgent) return toolText({ error: '此工具仅供WeWorker Bot 使用' })
        if (!isDedicatedOwner) return toolText({ error: '只有WeWorker Bot 的主人可以查看或配置通知目标' })
        const targets = store.listChannelNotifyTargets(dedicatedChannelKey).flatMap((entry) => {
          const chatType = Number(entry.extra.chat_type)
          if (chatType !== 1 && chatType !== 2) return []
          return [{ target_id: entry.user_id, kind: chatType === 2 ? 'group' : 'direct', observed_at: entry.updated_at }]
        })
        return toolText({ targets, hint: '群聊必须先有成员与该机器人对话，才会出现在此列表中。' })
      },
    ),
    tool(
      'create_agent_scheduled_task',
      '创建当前WeWorker Bot 的定时任务。仅在主人已通过对话明确确认任务内容、执行频率和通知目标后调用。任务运行时由 Agent 自行决定是否调用 send_agent_message；未调用就不会发送消息。',
      {
        title: z.string().min(1).max(80),
        cron_expression: z.string().min(1).max(100),
        prompt_template: z.string().min(1).max(4000),
        target_ids: z.array(z.string().min(1).max(256)).min(1).max(10).describe('来自 list_agent_notification_targets 的 target_id'),
        confirmed: z.literal(true).describe('仅在主人已明确确认后传 true'),
      },
      async ({ title, cron_expression, prompt_template, target_ids }) => {
        if (!dedicatedAgent) return toolText({ error: '此工具仅供WeWorker Bot 使用' })
        if (!isDedicatedOwner) return toolText({ error: '只有WeWorker Bot 的主人可以创建定时任务' })
        const validation = Scheduler.validateCron(cron_expression)
        if (!validation.valid) return toolText({ error: `无效的 cron 表达式: ${validation.error}` })
        const agent = getAgent(dedicatedAgent.agentId)
        if (!agent || !agent.enabled) return toolText({ error: 'WeWorker Bot 不存在或已停用' })
        const observed = store.listChannelNotifyTargets(dedicatedChannelKey)
        const selected = [...new Set(target_ids)].map((id) => observed.find((entry) => entry.user_id === id)).filter(Boolean)
        if (selected.length !== new Set(target_ids).size) return toolText({ error: '通知目标不在该WeWorker Bot 已观察到的企业微信会话中' })
        const targets = selected.map((entry) => ({
          id: entry!.user_id,
          chat_type: Number(entry!.extra.chat_type) as 1 | 2,
          observed_user_id: entry!.extra.user_id || '',
          observed_at: entry!.updated_at,
        }))
        if (targets.some((target) => target.chat_type !== 1 && target.chat_type !== 2)) return toolText({ error: '通知目标类型无效' })
        const contextWork = store.createWork(`【定时】${title}`, agent.project_id ?? null)
        addAgentWork(agent.id, contextWork.id)
        const task = store.createScheduledTask({
          title, cron_expression, prompt_template, enabled: true, notify_channels: [],
          agent_id: agent.id, owner_user_id: agent.owner_user_id,
          notification_targets: targets, context_work_id: contextWork.id,
        })
        scheduler.register(task.id, task.cron_expression)
        return toolText({ success: true, task, next_run: Scheduler.getNextRun(task.cron_expression)?.toISOString() ?? null })
      },
    ),
    tool(
      'send_agent_message',
      '向当前定时任务已授权的企业微信单聊或群聊主动发送消息。是否调用由你根据任务说明和本轮检查结果自主决定；未调用则不会推送。不得向未授权目标发送。',
      {
        target_id: z.string().min(1).max(256),
        message: z.string().min(1).max(6000),
      },
      async ({ target_id, message }) => {
        if (!dedicatedAgent?.taskId) return toolText({ success: false, error: '主动消息仅能在WeWorker Bot 定时任务运行中发送' })
        const task = store.getScheduledTask(dedicatedAgent.taskId)
        if (!task || task.agent_id !== dedicatedAgent.agentId || !task.enabled) return toolText({ success: false, error: '定时任务不存在、未授权或已停用' })
        const target = (task.notification_targets ?? []).find((entry) => entry.id === target_id)
        if (!target) return toolText({ success: false, error: '目标不在此任务的授权通知列表中' })
        const channel = channelManager.getChannel(dedicatedChannelKey)
        if (!channel?.sendNotificationToTarget) return toolText({ success: false, error: '企业微信机器人当前未连接或不支持主动消息' })
        try {
          await channel.sendNotificationToTarget({ id: target.id, chatType: target.chat_type }, message)
          return toolText({ success: true, target_id, delivered: true })
        } catch (error) {
          return toolText({ success: false, target_id, error: error instanceof Error ? error.message : String(error) })
        }
      },
    ),
    tool(
      'create_scheduled_task',
      '创建一个定时任务。定时任务会按照 cron 表达式周期性执行指定的 AI 任务。创建后任务默认启用，会立即注册到调度器。',
      {
        title: z.string().describe('任务标题，简要描述任务内容'),
        cron_expression: z.string().describe('Cron 表达式，例如 "0 9 * * *" 表示每天9点'),
        prompt_template: z.string().describe('任务描述/提示词，AI 执行时会收到这段文字作为指令'),
        notify_channels: z.array(z.string()).optional().describe('通知通道列表，可选值: "qq", "weixin"'),
      },
      async ({ title, cron_expression, prompt_template, notify_channels }) => {
        const validation = Scheduler.validateCron(cron_expression)
        if (!validation.valid) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `无效的 cron 表达式: ${validation.error}` }) }] }
        }
        const task = store.createScheduledTask({
          title, cron_expression, prompt_template, enabled: true,
          notify_channels: notify_channels ?? [],
        })
        scheduler.register(task.id, task.cron_expression)
        const nextRun = Scheduler.getNextRun(cron_expression)
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true, task,
              next_run: nextRun?.toISOString() ?? null,
              message: `定时任务「${title}」已创建并启用，下次执行时间: ${nextRun ? nextRun.toLocaleString('zh-CN') : '未知'}`,
            }, null, 2),
          }],
        }
      }
    ),

    tool(
      'list_scheduled_tasks',
      '列出所有定时任务及其最近一次执行状态。',
      {},
      async () => {
        const tasks = store.listScheduledTasks()
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              total: tasks.length,
              tasks: tasks.map(t => ({
                ...t,
                next_run: t.enabled ? Scheduler.getNextRun(t.cron_expression)?.toISOString() ?? null : null,
              })),
            }, null, 2),
          }],
        }
      }
    ),

    tool(
      'list_files',
      `列出文件。${fileToolDescription}按修改时间倒序排列。`,
      {
        directory: z.string().optional().describe(`目录路径（默认 ${toolDirectory}）`),
        keyword: z.string().optional().describe('按文件名关键词过滤'),
        limit: z.number().optional().describe('最大返回数量（默认 50）'),
      },
      async ({ directory, keyword, limit }) => {
        try {
          const result = listFiles(directory, keyword, limit)
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
        } catch (e) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) }] }
        }
      }
    ),

    tool(
      'send_file_to_user',
      '把用户目录中的文件发给当前对话的用户：桌面端对话里显示为可打开的附件，机器人对话里发到该机器人会话。只发给当前对话，不会发到其他对话或机器人。',
      {
        file_path: z.string().describe('文件的绝对路径（必须在用户目录内）'),
      },
      async ({ file_path }) => {
        try {
          const resolved = assertPathInsideUserDirectory(file_path, 'file_path')
          const sink = currentUserMedia()
          if (!sink?.file) return toolText({ success: false, error: NO_FILE_DELIVERY, file_path: resolved })
          const file = describeUserFile(resolved)
          await sink.file(file)
          return toolText({ success: true, delivered_to: 'current_conversation', name: file.name })
        } catch (e) {
          return toolText({ success: false, error: e instanceof Error ? e.message : String(e) })
        }
      }
    ),

    tool(
      'send_image_to_user',
      '把用户目录中的图片（如截图、支付二维码）发给当前对话的用户：桌面端对话里直接显示图片，机器人对话里发到该机器人会话。只发给当前对话，不会发到其他对话或机器人。',
      {
        file_path: z.string().describe('图片文件的绝对路径（必须在用户目录内）'),
      },
      async ({ file_path }) => {
        try {
          const resolved = assertPathInsideUserDirectory(file_path, 'file_path')
          const sink = currentUserMedia()
          if (!sink?.image) return toolText({ success: false, error: NO_IMAGE_DELIVERY, file_path: resolved })
          const image = readUserImage(resolved)
          await sink.image(image)
          return toolText({ success: true, delivered_to: 'current_conversation', name: image.name })
        } catch (e) {
          return toolText({ success: false, error: e instanceof Error ? e.message : String(e) })
        }
      }
    ),

    ...(process.platform === 'win32' ? [
      tool(
        'check_file_encryption',
        '检查文件是否被公司 DLP 系统加密（仅 Windows）。',
        { file_path: z.string().describe('文件的绝对路径') },
        async ({ file_path }) => {
          try {
            const resolved = assertPathInsideUserDirectory(file_path, 'file_path')
            let mtimeMs = 0
            try { mtimeMs = fs.statSync(resolved).mtimeMs } catch {}
            const exePath = _findDecryptExe()
            if (!exePath) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: '未找到 sd_decrypt.exe' }) }] }
            const execFileAsync = promisify(execFile)
            const { text } = await checkFileEncryptionCached(currentWorkId(), resolved, mtimeMs, async () => {
              const { stdout } = await execFileAsync(exePath, ['--check', '--json', resolved], { timeout: 15000 })
              return stdout.trim()
            })
            return { content: [{ type: 'text' as const, text }] }
          } catch (e: any) {
            const output = e.stdout?.trim() || ''
            if (output) return { content: [{ type: 'text' as const, text: output }] }
            return { content: [{ type: 'text' as const, text: JSON.stringify({ error: e.message }) }] }
          }
        }
      ),
      tool(
        'decrypt_file',
        '解密被公司 DLP 系统加密的文件（仅 Windows）。',
        {
          file_path: z.string().describe('文件或文件夹的绝对路径（必须在用户目录内）'),
          extensions: z.array(z.string()).optional().describe('文件扩展名过滤，如 [".pdf", ".docx"]'),
        },
        async ({ file_path, extensions }) => {
          try {
            const resolved = assertPathInsideUserDirectory(file_path, 'file_path')
            const exePath = _findDecryptExe()
            if (!exePath) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: '未找到 sd_decrypt.exe' }) }] }
            const args = ['--json', resolved]
            if (extensions) { for (const ext of extensions) { args.splice(1, 0, '--ext', ext) } }
            const execFileAsync = promisify(execFile)
            const { stdout } = await execFileAsync(exePath, args, { timeout: 60000 })
            return { content: [{ type: 'text' as const, text: stdout.trim() }] }
          } catch (e: any) {
            const output = e.stdout?.trim() || ''
            if (output) return { content: [{ type: 'text' as const, text: output }] }
            return { content: [{ type: 'text' as const, text: JSON.stringify({ error: e.message }) }] }
          }
        }
      ),
    ] : []),
  ]

  return createSdkMcpServer({
    name: 'weworker-tools',
    version: '1.0.0',
    tools: systemTools.map((definition: SdkMcpToolDefinition<any>) => ({
      ...definition,
      handler: (args, extra) => runWithWorkspaceDirectory(opts?.workspaceDirectory, () => definition.handler(args, extra), channelPermissionMode),
    })),
  })
}
