import { query } from '@anthropic-ai/claude-agent-sdk'
import type {
  SDKMessage,
  McpServerConfig,
  SettingSource,
  HookCallback,
  HookJSONOutput,
  SpawnOptions as ClaudeSpawnOptions,
  SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk' // used in mapSdkMessage parameter type
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { execSync } from 'node:child_process'
import type { Settings } from './config.js'
import { getConfigDirectory, getOpenBrowserAllowedOrigins, getSiteEnabled, getUserDirectory, getUserDirectoryBlacklist } from './config.js'
import { formatBlacklistEntry } from './user-directory-blacklist.js'
import type { ChannelPermissionMode } from './channels/channel-permissions.js'
import type { Message } from './works-store.js'
import { buildMcpServer as _buildMcpServer, getMcpToolDefinitionSummary } from './tools.js'
import { parseAllAdapters } from './adapter-parser.js'
import { buildAgentFilesystemSettings, createUnifiedToolGuard } from './user-directory-access.js'
import { createLogger } from './logger.js'
import { resolveWebcliDir } from './webcli-path.js'
import { ASSISTANT_STATUS_PREFIX, normalizeAssistantStatusLine } from './assistant-status.js'
import { composeSystemPromptWithZcf } from './zcf-sync.js'
import { computeUsageMetrics } from './usage-metrics.js'
import { assertAllowedLlmBaseUrl } from './llm-egress.js'
import { buildRuntimeAllowedLlmBaseUrls } from './provider-registry.js'
import { createWeWorkerToolPolicy } from './agent-tool-policy.js'
import { spawnManagedClaudeCodeProcess } from './claude-process.js'
import { waitForAdapterRuntimeReload } from './adapter-runtime-reload.js'
import {
  buildContextAssembly,
  buildEnabledSkillIndex,
  createTurnContextCollector,
  estimateContextTokens,
  recallLongTermMemory,
  type ContextSnapshot,
} from './context-assembly.js'
import {
  buildCompactedConversationPrompt,
  planConversationCompaction,
  takeRecentWithinTokenBudget,
} from './context/conversation-compaction.js'
import type { ConversationCompactionSnapshot } from './context/context-types.js'
import type { MemoryScope } from './memory/memory-types.js'
import type { MemoryUpdateCandidate } from './memory/memory-types.js'
import {
  buildMemoryOutputProtocolPrompt,
  MEMORY_USER_TURN_REMINDER,
  parseAssistantMemoryOutput,
  summarizeAssistantMemoryParse,
  type MemoryParseSummary,
} from './memory/memory-extractor.js'
import { buildAnthropicAuthHeaders, usesAnthropicBearerToken } from './anthropic-auth.js'
import { renderPrompt } from './prompt-loader.js'
import { buildLoadedSkillContext, createSkillContextCollector, type LoadedSkillContext } from './skill-context.js'

const log = createLogger('agent')

const compactedConversationByWork = new Map<string, {
  sourceMessageCount: number
  prompt: string
}>()

function takeStoredCompactedConversation(workId: string | undefined, messageCount: number): { prompt: string; includesCurrent: boolean } | undefined {
  if (!workId) return undefined
  const stored = compactedConversationByWork.get(workId)
  if (!stored) return undefined
  if (messageCount !== stored.sourceMessageCount && messageCount !== stored.sourceMessageCount + 1) {
    if (messageCount > stored.sourceMessageCount + 1) compactedConversationByWork.delete(workId)
    return undefined
  }
  compactedConversationByWork.delete(workId)
  return { prompt: stored.prompt, includesCurrent: messageCount === stored.sourceMessageCount }
}

export function clearStoredConversationCompaction(workId: string): void {
  compactedConversationByWork.delete(workId)
}

const MODEL_AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'CLAUDE_CODE_OAUTH_TOKEN',
]

function ensureIsolatedClaudeConfigDir(platform: NodeJS.Platform = process.platform): string {
  const dir = path.join(getConfigDirectory(), 'claude-config')
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(path.join(dir, 'skills'), { recursive: true })
  const configFile = path.join(dir, '.claude.json')
  let config: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>
    }
  } catch {
    config = {}
  }
  config.env = {}
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2))
  if (platform === 'win32') {
    const settingsFile = path.join(dir, 'settings.json')
    let userSettings: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        userSettings = parsed as Record<string, unknown>
      }
    } catch {
      userSettings = {}
    }
    userSettings.defaultShell = 'powershell'
    fs.writeFileSync(settingsFile, JSON.stringify(userSettings, null, 2))
  }
  return dir
}

export function buildClaudeNativeShellEnv(
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  return platform === 'win32' ? { CLAUDE_CODE_USE_POWERSHELL_TOOL: '1' } : {}
}

export function buildConfiguredModelEnv(
  settings: Pick<Settings, 'api_key' | 'base_url'> & Partial<Pick<Settings, 'active_provider' | 'custom_auth_type'>>,
  extraEnv?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env = { ...process.env, ...buildClaudeNativeShellEnv(), ...extraEnv }
  for (const key of MODEL_AUTH_ENV_KEYS) delete env[key]
  delete env.CLAUDE_CODE_GIT_BASH_PATH
  delete env.WEWORKER_BUNDLED_GIT_BASH
  if (usesAnthropicBearerToken(settings.active_provider, settings.custom_auth_type)) {
    env.ANTHROPIC_AUTH_TOKEN = settings.api_key
  } else {
    env.ANTHROPIC_API_KEY = settings.api_key
  }
  env.CLAUDE_CONFIG_DIR = ensureIsolatedClaudeConfigDir()
  const baseUrl = assertAllowedLlmBaseUrl(settings.base_url, buildRuntimeAllowedLlmBaseUrls(settings.base_url))
  if (baseUrl !== 'https://api.anthropic.com') {
    env.ANTHROPIC_BASE_URL = baseUrl
  } else {
    delete env.ANTHROPIC_BASE_URL
  }
  return env
}

export interface SSEEvent {
  type: 'text_delta' | 'tool_call_start' | 'tool_call_result' | 'tool_call_image' | 'skill_context' | 'user_choice' | 'done' | 'error' | 'usage' | 'context_snapshot' | 'context_compaction_start' | 'context_compaction_end' | 'memory_status' | 'memory_candidate' | 'memory_parse'
  skillContext?: LoadedSkillContext
  content?: string
  id?: string
  name?: string
  args?: unknown
  result?: string
  isError?: boolean
  data?: string
  question?: string
  options?: Array<{ label: string; description?: string }>
  usage?: UsageEvent
  context?: ContextSnapshot
  status?: 'running' | 'done' | 'processing' | 'saved' | 'ignored' | 'duplicate' | 'failed' | 'not_applicable'
  workId?: string
  eventId?: string
  error?: string
  candidate?: MemoryUpdateCandidate
  memoryParse?: MemoryParseSummary
  compaction?: Partial<ConversationCompactionSnapshot> & {
    status?: 'started' | 'completed' | 'skipped' | 'failed'
    reason?: 'no_droppable_history' | 'summary_unavailable' | 'summary_failed'
    error?: string
  }
}

/** Per-turn token & prompt-cache metrics, emitted once per streamChat turn. */
export interface UsageEvent {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  total_input_tokens: number
  cache_hit_rate: number
  total_cost_usd?: number
  duration_ms?: number
  num_turns?: number
  kind?: 'turn' | 'post_compaction_probe'
}

export async function generateAssistantStatusLine(
  replyText: string,
  settings: Pick<Settings, 'api_key' | 'base_url' | 'model' | 'active_provider' | 'custom_auth_type'>,
): Promise<string | null> {
  const trimmedReply = String(replyText ?? '').trim()
  if (!trimmedReply) return null

  const baseUrl = assertAllowedLlmBaseUrl(settings.base_url, buildRuntimeAllowedLlmBaseUrls(settings.base_url))
  const endpoint = `${baseUrl}/v1/messages`
  const prompt = [
    '请基于下面这条 AI 回复，输出一行简短中文状态。',
    `必须只输出一行，格式固定为“${ASSISTANT_STATUS_PREFIX}<状态内容>”。`,
    '不要输出解释、编号、Markdown、引号或多余文本。',
    '',
    '[AI 回复]',
    trimmedReply,
  ].join('\n')

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...buildAnthropicAuthHeaders(settings.api_key, settings.active_provider, settings.custom_auth_type),
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: settings.model,
        max_tokens: 80,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) return null

    const data = await response.json() as {
      content?: Array<{ type?: string; text?: string }>
    }
    const text = (data.content ?? [])
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')

    return normalizeAssistantStatusLine(text)
  } catch {
    return null
  }
}

export function buildSystemPrompt(opts?: {
  channelPermissionMode?: ChannelPermissionMode
  platform?: NodeJS.Platform
  zcfRole?: string | null
  zcfMode?: string | null
  zcfCustomRoles?: import('./zcf-sync.js').ZcfCustomRole[]
  memoryProtocol?: string
}): string {
  const channelPermissionMode = opts?.channelPermissionMode ?? 'full'
  const platform = opts?.platform ?? process.platform
  const nativeCommandTool = platform === 'win32' ? 'PowerShell' : 'Bash'
  const defaultShell = platform === 'win32' ? 'powershell' : 'bash'
  if (channelPermissionMode === 'qa_only') {
    const base = renderPrompt('agent-qa-only', {}).trim()
    return composeSystemPromptWithZcf(`${base}\n\n${opts?.memoryProtocol ?? ''}`.trim(), opts?.zcfRole, opts?.zcfMode, opts?.zcfCustomRoles ?? [])
  }

  const allAdapters = parseAllAdapters()
  const userDirectory = getUserDirectory()
  const blacklistEntries = getUserDirectoryBlacklist()
  const blacklistScope = channelPermissionMode === 'full'
    ? '以下路径黑名单规则由系统对原生文件工具、WeWorker Shell 和带路径参数的 MCP 工具强制校验；不适用于 `full` 模式的 Claude Code 内置 Bash：'
    : '以下路径黑名单规则由系统在工具执行时强制校验：'
  const blacklistNotice = blacklistEntries.length
    ? `
${blacklistScope}
${blacklistEntries.map((entry) => `- ${formatBlacklistEntry(entry)}`).join('\n')}

黑名单说明：
- 每条规则会按“路径精确匹配”或“路径正则匹配”执行。
- 被黑名单命中的路径不可读取、写入、列出、上传、解密或发送。
- 如果工具返回 blocked / blacklist 错误，请明确告知用户该路径已被管理员加入黑名单，无法访问。
`
    : ''

  const adapterExecutionEnabled = channelPermissionMode === 'full'
  const webcliInvokeDesc = `Claude Code 内置 ${nativeCommandTool} 执行 \`webcli call <完整工具名> --参数名=参数值\``
  const openBrowserDesc = `使用 Claude Code 内置 ${nativeCommandTool} 执行 \`webcli call open_browser --url=<url>\``
  const webcliStep2 = `2. 使用 Claude Code 内置 ${nativeCommandTool} 执行 \`webcli call <完整工具名> --参数名=参数值\``
  const openBrowserRule = `用 Claude Code 内置 ${nativeCommandTool} 执行 \`webcli call open_browser --url=...\``
  const bashCapabilityNotice = channelPermissionMode === 'full'
    ? `
## Skill、Adapter 与 ${nativeCommandTool}

优先按已激活的标准 Skill 指令执行。执行 Extension Adapter 或 Toolkit Adapter 时，统一使用 Claude Code 内置 ${nativeCommandTool} 运行 \`webcli call\`，不得使用 \`weworker_powershell\`。
Claude Code 内置 ${nativeCommandTool} 已开放，也可执行构建、测试、git、npm 和其他本地命令。
内置 ${nativeCommandTool} 不受 WeWorker 用户目录白名单、黑名单、绝对路径或命令类型限制。
WebCLI 会按 Adapter 类型分别选择 Chrome 扩展 Bridge 或内嵌 Toolkit Runtime；不要直接调用 Adapter 脚本路径。
`
    : `
## 原生命令工具限制

不要调用 Claude Code 内置 Bash 或 PowerShell 工具。
当前权限模式不能执行 Extension Adapter 或 Toolkit Adapter；不要调用 webcli，也不要尝试用 \`weworker_powershell\` 绕过。
构建、测试、git、npm 或查看命令输出必须使用 \`weworker_powershell\`（WeWorker Shell）。
WeWorker Shell 在当前平台默认使用 ${defaultShell}。
WeWorker Shell 的 stdout/stderr 会实时显示在右侧终端面板中，用户可见执行过程。
`

  const authSites: string[] = []
  for (const [adapterId, adapter] of allAdapters) {
    if (!getSiteEnabled(adapterId, adapter.defaultEnabled)) continue
    if (adapter.requiresAuth) {
      const backgroundApiTools = Object.entries(adapter.toolExecution || {})
        .filter(([, execution]) => execution?.type === 'api' && execution?.runtime === 'background')
        .map(([toolName]) => toolName)
      const directToolSummary = backgroundApiTools.length <= 4
        ? backgroundApiTools.map((name) => `\`${name}\``).join('、')
        : `共 ${backgroundApiTools.length} 个（以该站点 Skill 中的 Execution 标记为准）`
      const authCheckTool = adapter.authCheckTool || `${adapterId}.check_login_status`
      authSites.push(
        backgroundApiTools.length > 0
          ? `- ${adapter.name}（${adapter.match[0]}）：API direct 工具 ${directToolSummary}，必须先直接调用`
          : `- ${adapter.name}（${adapter.match[0]}） -> 检测：\`webcli call ${authCheckTool}\``,
      )
    }
  }

  const windowsEncryptionRules = process.platform === 'win32' ? `
## 文件加密处理规则

在使用任何文件之前（读取内容、上传附件、发送给用户、作为其他工具参数等），必须先调用 \`check_file_encryption\` 工具检查该文件是否被公司 DLP 加密。

按以下步骤处理：
1. 调用 \`check_file_encryption\`，传入 \`file_path\`。
2. 查看返回 JSON 中的 \`encrypted\` 或 \`encryption_status\` 字段。
3. 如果是 encrypted，必须先调用 \`decrypt_file\` 对同一路径解密，确认 success: true 后再继续。
4. 如果未加密，直接继续原定操作。
5. 如果加密检查失败或解密失败（包含未找到 sd_decrypt.exe），当前环境可能为非 OA 环境；直接按原定操作继续，不要阻塞或等待用户确认；在回复中简要说明已跳过加密检查。
` : ''
  const loginDetectionRules = adapterExecutionEnabled && authSites.length > 0 ? `
## 登录检测规则

以下网站需要用户登录后才能操作：

${authSites.join('\n')}

对于这些网站，使用 open_browser 打开后（等待 5 秒后），必须先调用该网站的 check_login_status 工具检测登录状态。
如果返回 \`logged_in: false\`，应立即告知用户需要先在浏览器中登录该网站。
` : ''
  const base = `${renderPrompt('agent', {
    adapter_capability: adapterExecutionEnabled
      ? '你通过 webcli 命令行工具调用 Extension Adapter 与 Toolkit Adapter，能够在网页上执行操作。'
      : '当前权限模式允许使用标准 Skill 和受控文件／Shell 工具，但不能执行 Extension Adapter 或 Toolkit Adapter。',
    adapter_execution_guidance: adapterExecutionEnabled
      ? `所有网站工具通过${webcliInvokeDesc}调用。
对于 Skill 中同时标记为 \`Execution: type=api, runtime=background\` 和 \`Execution: mode=direct\` 的工具，它们是无需 DOM 的 API 工具，必须直接调用，不需要先打开对应网站。旧 Skill 如果只标记了 \`Execution: mode=direct\`，也按同样规则处理。
对于页面/DOM 工具，调用前需要确保对应网站已在 Chrome 中打开。如果未打开，请先${openBrowserDesc}打开该网站。`
      : 'Skill 可用于阅读说明，但不要执行其中的 Adapter 命令。',
    webcli_execution_step: adapterExecutionEnabled
      ? webcliStep2
      : '2. 当前权限模式不能执行 Adapter；需要执行时明确说明需要 full 权限。',
    native_command_capability: bashCapabilityNotice,
    open_browser_guidance: adapterExecutionEnabled
      ? '只有页面/DOM 工具需要先打开网站。`type=api, runtime=background` + `mode=direct` 的 API 工具不要预先打开网站或检测登录；如果这类工具返回需要登录或需要页面上下文，再打开 Skill 文档中的 Homepage URL。'
      : '本节仅在 full 权限可执行；当前不要打开网站或调用 Adapter。',
    open_browser_wait_rule: adapterExecutionEnabled
      ? `${openBrowserRule} 打开一个受支持的网站后，必须等待至少 5 秒再执行任何后续页面/DOM 操作。`
      : '当前权限模式不能调用 open_browser。',
    user_directory: userDirectory,
    directory_boundary_rule: channelPermissionMode === 'full'
      ? `此目录边界不适用于 \`full\` 模式的 Claude Code 内置 ${nativeCommandTool}；内置 ${nativeCommandTool} 可以访问其他绝对路径，也不应用用户目录黑名单。`
      : 'WeWorker Shell 命令（含 cat、type、python 等）与内置文件工具同样受用户目录边界约束，越界请求会被系统拦截。',
    blacklist_notice: blacklistNotice,
    local_command_execution_rule: channelPermissionMode === 'full'
      ? `执行 Extension Adapter 或 Toolkit Adapter 时必须使用 Claude Code 内置 ${nativeCommandTool} 运行 \`webcli call\`，不得使用 \`weworker_powershell\`；其他本地命令、构建、测试、git 或 npm 也可以使用内置 ${nativeCommandTool}。`
      : '当需要执行本地命令、Shell 命令、构建、测试、git、npm 或查看命令输出时，必须调用 `weworker_powershell` 工具，不要调用 Claude Code 内置 Bash 或 PowerShell。',
    default_shell: defaultShell,
    adapter_shell_rule: adapterExecutionEnabled
      ? '网站操作仍按 webcli 规则执行；不要为了调用网站工具而改用 `weworker_powershell`。'
      : '当前权限模式不能执行 Adapter；严禁用 `weworker_powershell` 调用 webcli。',
    windows_encryption_rules: windowsEncryptionRules,
    assistant_status_prefix: ASSISTANT_STATUS_PREFIX,
    login_detection_rules: loginDetectionRules,
  }).trimEnd()}\n`
  return composeSystemPromptWithZcf(`${base}\n\n${opts?.memoryProtocol ?? ''}`.trim(), opts?.zcfRole, opts?.zcfMode, opts?.zcfCustomRoles ?? [])
}
function findClaudeExecutable(): string | undefined {
  try {
    const result = execSync('which claude', {
      shell: process.env.SHELL || '/bin/zsh',
      timeout: 3000,
    }).toString().trim()
    if (result && fs.existsSync(result)) return result
  } catch {}
  const candidates = [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(os.homedir(), '.npm', 'bin', 'claude'),
    path.join(os.homedir(), '.local', 'bin', 'claude'),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return undefined
}

function findNodeExecutable(): string | undefined {
  const isWin = process.platform === 'win32'
  try {
    const result = execSync(isWin ? 'where node' : 'which node', {
      shell: isWin ? undefined : (process.env.SHELL || '/bin/zsh'),
      timeout: 3000,
    }).toString().trim().split('\n')[0].trim()
    if (result && fs.existsSync(result)) return result
  } catch {}
  const candidates = isWin
    ? [
        path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'nodejs', 'node.exe'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', 'node.exe'),
        path.join(os.homedir(), 'AppData', 'Roaming', 'nvm', 'current', 'node.exe'),
      ]
    : [
        '/opt/homebrew/bin/node',
        '/usr/local/bin/node',
        '/usr/bin/node',
      ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return undefined
}

let _wrapperPath: string | undefined

export function resolvePackagedClaudeEntrypoint(resourcesPath: string, platform = process.platform): string {
  const claudeCodeDir = path.join(resourcesPath, 'claude-code')
  const candidates = [
    path.join(claudeCodeDir, 'bin', 'claude.exe'),
    path.join(claudeCodeDir, 'cli-wrapper.cjs'),
    path.join(claudeCodeDir, 'cli.js'),
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }

  return candidates[0]
}

function getPackagedClaudeSetup(): { pathToClaudeCodeExecutable: string; executable?: string; extraEnv?: Record<string, string> } {
  const resourcesPath = process.env.WEWORKER_RESOURCES_PATH || ''
  const claudeEntrypoint = resolvePackagedClaudeEntrypoint(resourcesPath)
  const execPath = process.env.WEWORKER_EXEC_PATH || process.execPath
  const isWin = process.platform === 'win32'
  const usesNodeScript = ['.js', '.cjs', '.mjs'].includes(path.extname(claudeEntrypoint))
  const nativeShellEnv = buildClaudeNativeShellEnv()

  if (!usesNodeScript) {
    return {
      pathToClaudeCodeExecutable: claudeEntrypoint,
      ...(Object.keys(nativeShellEnv).length ? { extraEnv: nativeShellEnv } : {}),
    }
  }

  if (isWin) {
    const extraEnv: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1', ...nativeShellEnv }
    // Script fallbacks run through Electron in Node.js mode via
    // spawnClaudeCodeProcess.
    return {
      pathToClaudeCodeExecutable: claudeEntrypoint,
      ...(Object.keys(extraEnv).length ? { extraEnv } : {}),
    }
  }

  // macOS/Linux: write a node shebang wrapper to avoid Terminal popup / Electron relaunch
  if (_wrapperPath && fs.existsSync(_wrapperPath)) {
    return { pathToClaudeCodeExecutable: _wrapperPath }
  }
  const nodePath = findNodeExecutable()
  const wrapperPath = path.join(os.homedir(), '.weworker', 'claude-wrapper')
  fs.mkdirSync(path.dirname(wrapperPath), { recursive: true })
  if (nodePath) {
    fs.writeFileSync(wrapperPath, `#!${nodePath}\nrequire(${JSON.stringify(claudeEntrypoint)})\n`)
  } else {
    fs.writeFileSync(wrapperPath, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${execPath}" "${claudeEntrypoint}" "$@"\n`)
  }
  fs.chmodSync(wrapperPath, 0o755)
  _wrapperPath = wrapperPath
  return { pathToClaudeCodeExecutable: wrapperPath }
}

async function summarizeConversationOnly(input: {
  conversation: string
  settings: Settings
  abortController?: AbortController
  env: NodeJS.ProcessEnv
  claudeSetup: { pathToClaudeCodeExecutable?: string; executable?: string }
  spawnClaudeCodeProcess: (spawnArgs: ClaudeSpawnOptions) => SpawnedProcess
}): Promise<string> {
  const summaryQuery = query({
    prompt: input.conversation,
    options: {
      abortController: input.abortController,
      model: input.settings.model,
      systemPrompt: [
        '你正在执行 WeWorker 的对话上下文压缩。',
        '只根据用户与助手的对话内容生成简洁、可继续执行的事实摘要。',
        '保留用户目标、已经确认的事实、已完成或失败的步骤、重要参数、待处理事项和恢复线索。',
        '不要加入系统规则、工具定义、Skills、长期记忆或对话之外的推断。',
        '不要回答用户问题，不要输出标题、解释或元数据，只输出摘要正文。',
      ].join('\n'),
      tools: [],
      settingSources: [],
      persistSession: false,
      maxTurns: 1,
      permissionMode: 'dontAsk',
      includePartialMessages: false,
      cwd: getUserDirectory(),
      pathToClaudeCodeExecutable: input.claudeSetup.pathToClaudeCodeExecutable,
      spawnClaudeCodeProcess: input.spawnClaudeCodeProcess,
      env: input.env,
    },
  })

  try {
    let receivedResult = false
    for await (const message of summaryQuery) {
      if (message.type !== 'result') continue
      receivedResult = true
      const result = message as unknown as { subtype?: string; result?: string; is_error?: boolean; errors?: string[] }
      const summary = typeof result.result === 'string' ? result.result.trim() : ''
      if (result.subtype === 'success' && summary) return summary
      const providerErrors = Array.isArray(result.errors) ? result.errors.filter(Boolean).join('; ') : ''
      const detail = providerErrors || (result.subtype
        ? `摘要器返回状态 ${result.subtype}`
        : '摘要器未返回状态')
      log.error('conversation compaction summary failed', {
        detail,
        is_error: result.is_error === true,
        subtype: result.subtype,
        received_result: receivedResult,
        has_result_text: Boolean(summary),
      })
      throw new Error(detail)
    }
    const detail = '摘要器未返回成功结果'
    log.error('conversation compaction summary failed', { detail, received_result: receivedResult })
    throw new Error(detail)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (detail.startsWith('对话压缩摘要失败：')) throw error
    log.error('conversation compaction summary request failed', detail)
    throw new Error(`对话压缩摘要失败：${detail}`)
  } finally {
    summaryQuery.close()
  }
}

async function probeContextUsage(input: {
  contextAssembly: { sdk: { system_prompt: string; prompt: string } }
  settings: Settings
  abortController?: AbortController
  claudeSetup: { pathToClaudeCodeExecutable?: string }
  spawnClaudeCodeProcess: (spawnArgs: ClaudeSpawnOptions) => SpawnedProcess
  env: NodeJS.ProcessEnv
  mcpServer: McpServerConfig
  disallowedTools: string[]
  settingSources: SettingSource[]
}): Promise<UsageEvent> {
  const probeQuery = query({
    prompt: input.contextAssembly.sdk.prompt,
    options: {
      abortController: input.abortController,
      model: input.settings.model,
      systemPrompt: input.contextAssembly.sdk.system_prompt,
      mcpServers: { weworker: input.mcpServer },
      disallowedTools: input.disallowedTools,
      canUseTool: async () => ({ behavior: 'deny', message: '上下文 token 探针不执行工具' }),
      permissionMode: 'dontAsk',
      includePartialMessages: false,
      settingSources: input.settingSources,
      persistSession: false,
      maxTurns: 1,
      cwd: getUserDirectory(),
      pathToClaudeCodeExecutable: input.claudeSetup.pathToClaudeCodeExecutable,
      spawnClaudeCodeProcess: input.spawnClaudeCodeProcess,
      env: input.env,
    },
  })

  try {
    for await (const message of probeQuery) {
      if (message.type !== 'result') continue
      const result = message as unknown as {
        subtype?: string
        usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
        errors?: string[]
      }
      if (result.usage && result.subtype === 'success') {
        return {
          ...computeUsageMetrics(result.usage),
          kind: 'post_compaction_probe',
        }
      }
      const detail = (result.errors ?? []).filter(Boolean).join('; ') || `上下文 token 探针返回状态 ${result.subtype ?? 'unknown'}`
      throw new Error(detail)
    }
    throw new Error('上下文 token 探针未返回结果')
  } finally {
    probeQuery.close()
  }
}

function stringifyPromptValue(value: unknown): string {
  if (value == null || value === '') return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function clampPromptText(text: string, max = 8000): string {
  const value = String(text || '')
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n...[truncated ${value.length - max} chars]`
}

function extractToolResultText(result: unknown): string {
  if (typeof result !== 'string') return stringifyPromptValue(result)
  try {
    const parsed = JSON.parse(result)
    if (parsed && typeof parsed === 'object' && typeof (parsed as { output?: unknown }).output === 'string') {
      return (parsed as { output: string }).output
    }
  } catch {
    // Keep raw non-JSON tool output.
  }
  return result
}

function contentBlockPromptText(block: Message['content'][number]): string {
  if (block.type === 'text') return block.text
  if (block.type === 'file_attachment') return `[File] ${block.name}: ${block.path}`
  if (block.type === 'tool_use') {
    const args = block.args && typeof block.args === 'object' ? block.args as Record<string, unknown> : {}
    const command = typeof args.command === 'string' ? args.command : ''
    const resultText = extractToolResultText(block.result)
    const lines = [
      `[Tool] ${block.name || 'tool'}`,
      command ? `command: ${command}` : `args: ${stringifyPromptValue(block.args)}`,
      block.status ? `status: ${block.status}` : '',
      resultText ? `result:\n${clampPromptText(resultText)}` : '',
    ].filter(Boolean)
    return lines.join('\n')
  }
  return ''
}

function messagePromptText(message: Message): string {
  return message.content
    .map(contentBlockPromptText)
    .filter((text) => text.trim())
    .join('\n')
}

// Convert stored messages to a single prompt string for the Agent SDK
function buildPromptString(messages: Message[]): string {
  if (messages.length === 0) return ''

  const lastMsg = messages[messages.length - 1]
  const history = messages.slice(0, -1)

  const lastText = messagePromptText(lastMsg)

  if (history.length === 0) return lastText

  const historyText = history.map(m => {
    const textContent = messagePromptText(m)
    if (!textContent.trim()) return null
    return `${m.role === 'user' ? 'User' : 'Assistant'}: ${textContent}`
  }).filter(Boolean).join('\n\n')

  if (!historyText) return lastText
  return `[浠ヤ笅鏄箣鍓嶇殑瀵硅瘽鍘嗗彶锛屼粎渚涘弬鑰僝\n${historyText}\n\n[褰撳墠鐢ㄦ埛娑堟伅]\n${lastText}`
}

// Strip any base64 image markdown that Claude may emit in its text response
// e.g. ![Screenshot](data:image/jpeg;base64,/9j/...)
function stripBase64Images(text: string): string {
  // Claude sometimes embeds the screenshot as a markdown image in its text block.
  // The base64 string is so long that it never has a closing ')' within the same
  // streaming delta 鈥?so we match from '![' up to the end of the string when no
  // closing ')' is found, effectively removing the entire trailing image embed.
  let result = text
  const re = /!\[[^\]]*\]\(data:image\//
  let m: RegExpExecArray | null
  while ((m = re.exec(result)) !== null) {
    const start = m.index
    // Find closing ')' after the marker
    const closeIdx = result.indexOf(')', m.index + m[0].length)
    if (closeIdx !== -1) {
      // Complete markdown image 鈥?remove it
      result = result.slice(0, start) + result.slice(closeIdx + 1)
    } else {
      // No closing ')' 鈥?truncated base64, remove from here to end of string
      result = result.slice(0, start)
      break
    }
  }
  return result.trim()
}

function* mapSdkMessage(msg: SDKMessage, streaming: boolean, textBlockBuf: { id: string; text: string }[]): Generator<SSEEvent> {
  // Log SDK message types for timing analysis
  if (msg.type !== 'stream_event') {
    log.info(`sdk-event: type=${msg.type}`)
  }
  // Streaming text deltas 鈥?only used in streaming mode
  if (msg.type === 'stream_event') {
    if (!streaming) return
    const event = (msg as unknown as { event: { type: string; delta?: { type: string; text?: string }; content_block?: { type: string; id?: string; name?: string }; index?: number } }).event

    if (event.type === 'content_block_start') {
      if (event.content_block?.type === 'text') {
        // Start buffering a new text block
        textBlockBuf.push({ id: String(event.index ?? textBlockBuf.length), text: '' })
      } else if (event.content_block?.type === 'tool_use') {
        yield {
          type: 'tool_call_start',
          id: event.content_block.id,
          name: event.content_block.name,
          args: {},
          status: 'running',
        } as SSEEvent & { status: string }
      }
      return
    }

    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
      // Accumulate into the current text block buffer
      const buf = textBlockBuf[textBlockBuf.length - 1]
      if (buf) {
        buf.text += event.delta.text
      } else {
        // Fallback: no open block, emit directly
        yield { type: 'text_delta', content: event.delta.text }
      }
      return
    }

    if (event.type === 'content_block_stop') {
      const buf = textBlockBuf.pop()
      if (buf?.text) {
        const cleaned = stripBase64Images(buf.text)
        const parsed = parseAssistantMemoryOutput(cleaned)
        const memoryParse = summarizeAssistantMemoryParse(parsed)
        log.info('memory_parse', memoryParse)
        yield { type: 'memory_parse', memoryParse }
        if (parsed.visibleText) yield { type: 'text_delta', content: parsed.visibleText }
        if (parsed.decision?.should_remember && parsed.decision.candidate) {
          yield { type: 'memory_candidate', candidate: parsed.decision.candidate }
        }
      }
      return
    }

    return
  }

  if (msg.type === 'system') {
    const systemMessage = msg as unknown as {
      subtype?: string
      status?: string | null
      compact_metadata?: { trigger?: 'manual' | 'auto'; pre_tokens?: number }
    }
    if (systemMessage.subtype === 'status' && systemMessage.status === 'compacting') {
      yield { type: 'context_compaction_start', compaction: { status: 'started' } }
    } else if (systemMessage.subtype === 'compact_boundary') {
      yield {
        type: 'context_compaction_end',
        compaction: {
          status: 'completed',
          ...(systemMessage.compact_metadata?.trigger ? { mode: 'conversation_only' } : {}),
          ...(Number.isFinite(systemMessage.compact_metadata?.pre_tokens)
            ? { before_tokens: systemMessage.compact_metadata?.pre_tokens }
            : {}),
        },
      }
    }
    return
  }

  // User message 鈥?contains tool results (including images)
  if (msg.type === 'user') {
    const userMsg = (msg as unknown as { message: { content: Array<{ type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }> } }).message
    for (const block of userMsg.content ?? []) {
      if (block.type === 'tool_result') {
        // content may be a string (e.g. Skill tool) or an array of parts
        const content = block.content
        if (typeof content === 'string') {
          yield { type: 'tool_call_result', id: block.tool_use_id, result: content, isError: block.is_error === true }
        } else if (Array.isArray(content)) {
          for (const part of content as Array<{ type: string; text?: string; source?: { data: string; media_type: string }; data?: string }>) {
            if (part.type === 'text' && part.text) {
              yield { type: 'tool_call_result', id: block.tool_use_id, result: part.text, isError: block.is_error === true }
            } else if (part.type === 'image') {
              const imgData = part.source?.data ?? part.data
              if (imgData) {
                yield { type: 'tool_call_image', id: block.tool_use_id, data: imgData }
              }
            }
          }
        }
      }
    }
    return
  }

  // Full assistant message 鈥?in non-streaming mode, extract text here (after all tool calls done)
  if (msg.type === 'assistant') {
    if (!streaming) {
      const assistantMsg = (msg as unknown as { message: { content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }> } }).message
      for (const block of assistantMsg.content ?? []) {
        if (block.type === 'text' && block.text) {
          const cleaned = stripBase64Images(block.text)
          const parsed = parseAssistantMemoryOutput(cleaned)
          const memoryParse = summarizeAssistantMemoryParse(parsed)
          log.info('memory_parse', memoryParse)
          yield { type: 'memory_parse', memoryParse }
          if (parsed.visibleText) yield { type: 'text_delta', content: parsed.visibleText }
          if (parsed.decision?.should_remember && parsed.decision.candidate) {
            yield { type: 'memory_candidate', candidate: parsed.decision.candidate }
          }
        }
        if (block.type === 'tool_use' && block.id) {
          yield { type: 'tool_call_start', id: block.id, name: block.name ?? '', args: block.input ?? {} } as SSEEvent
        }
      }
    } else {
      // In streaming mode, text came via deltas, but tool input didn't 鈥?extract it here
      const assistantMsg = (msg as unknown as { message: { content: Array<{ type: string; id?: string; name?: string; input?: Record<string, unknown> }> } }).message
      for (const block of assistantMsg.content ?? []) {
        if (block.type === 'tool_use' && block.id && block.input && Object.keys(block.input).length > 0) {
          yield { type: 'tool_call_start', id: block.id, name: block.name ?? '', args: block.input } as SSEEvent
        }
      }
    }
    return
  }

  if (msg.type === 'result') {
    // P0.5 baseline: log per-turn token usage + prompt-cache hit rate once per
    // streamChat turn. `usage` is also yielded so callers/frontend can aggregate.
    const r = msg as unknown as {
      subtype?: string
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
      total_cost_usd?: number
      duration_ms?: number
      num_turns?: number
      is_error?: boolean
      errors?: string[]
    }
    if (r.usage) {
      const m = computeUsageMetrics(r.usage)
      log.info(
        `usage in=${m.input_tokens} cache_read=${m.cache_read_input_tokens} cache_create=${m.cache_creation_input_tokens} out=${m.output_tokens} total_in=${m.total_input_tokens} cache_hit=${(m.cache_hit_rate * 100).toFixed(1)}% cost=$${r.total_cost_usd ?? 0} dur=${r.duration_ms ?? 0}ms turns=${r.num_turns ?? 0} subtype=${r.subtype ?? '?'}`,
      )
      yield {
        type: 'usage',
        usage: {
          ...m,
          total_cost_usd: r.total_cost_usd,
          duration_ms: r.duration_ms,
          num_turns: r.num_turns,
        },
      } as SSEEvent
    }
    if (r.is_error === true || r.subtype !== 'success') {
      yield {
        type: 'error',
        content: (r.errors ?? []).filter(Boolean).join('\n') || `Claude Code execution failed (${r.subtype ?? 'unknown'})`,
      }
    }
    yield { type: 'done' }
  }
}

export async function* streamChat(
  messages: Message[],
  settings: Settings,
  abortController?: AbortController,
  opts: {
    streaming?: boolean;
    enabledAdapterIds?: Set<string>;
    workId?: string;
    zcfRole?: string | null;
    zcfMode?: string | null;
    channelPermissionMode?: ChannelPermissionMode;
    onAskUser?: (event: { type: string; id: string; question: string; options: Array<{ label: string; description?: string }> }) => void;
    channelAskUserHandler?: (question: string, options: Array<{ label: string; description?: string }>) => Promise<string>;
    memoryScope?: MemoryScope;
    memoryEnabled?: boolean;
    memoryExpectedType?: import('./memory/memory-types.js').MemoryType;
    memoryTriggerHint?: import('./memory/memory-types.js').MemoryEventTrigger | 'chat';
    previousTaskFailed?: boolean;
    forceCompaction?: boolean;
    compactionOnly?: boolean;
    systemPromptOverride?: string;
    mcpServerOverride?: ReturnType<typeof _buildMcpServer>;
    restrictBuiltInTools?: boolean;
  } = {},
): AsyncGenerator<SSEEvent> {
  // Claude Code discovers user Skills when each query starts. If a website was
  // just scaffolded, wait for its hot-install to finish before starting query.
  await waitForAdapterRuntimeReload()
  const enabledAdapterIds = opts.enabledAdapterIds
  const channelPermissionMode = opts.channelPermissionMode ?? 'full'

  const mcpServer = _buildMcpServer({
    channelPermissionMode,
    workId: opts.workId ?? null,
    askUserSSECallback: opts.onAskUser ?? null,
    channelAskUserHandler: opts.channelAskUserHandler ?? null,
  })
  const activeMcpServer = opts.mcpServerOverride || mcpServer
  const claudeSetup: { pathToClaudeCodeExecutable?: string; executable?: string; extraEnv?: Record<string, string> } = process.env.WEWORKER_PACKAGED
    ? getPackagedClaudeSetup()
    : { pathToClaudeCodeExecutable: findClaudeExecutable() }

  // Always place Claude CLI in its own process group. SDK close/abort otherwise
  // terminates only the CLI and leaves command tools, Toolkit Runtime, and Playwright orphaned.
  const spawnClaudeCodeProcess = (spawnArgs: ClaudeSpawnOptions): SpawnedProcess => {
    const execPath = process.env.WEWORKER_EXEC_PATH || process.execPath
    // SDK passes command="node" (or "bun") when it treats pathToClaudeCodeExecutable as a script.
    // Replace it with the Electron exe running in Node.js mode when packaged.
    const isRuntimeCmd = ['node', 'bun', 'deno'].includes(spawnArgs.command)
    const command = claudeSetup.extraEnv && isRuntimeCmd ? execPath : spawnArgs.command
    const child = spawnManagedClaudeCodeProcess(
      { ...spawnArgs, command },
      claudeSetup.extraEnv,
    )
    child.stderr?.on('data', (d: Buffer) => log.error('claude-stderr', d.toString().trimEnd()))
    child.on('exit', (code: number) => log.info(' code:', code))
    return child as unknown as SpawnedProcess
  }
  let queryEnv: NodeJS.ProcessEnv
  try {
    queryEnv = buildConfiguredModelEnv(settings, claudeSetup.extraEnv)
  } catch (e) {
    yield { type: 'error', content: e instanceof Error ? e.message : 'LLM base URL is not allowed' }
    return
  }

  // includePartialMessages enables streaming text deltas but causes Claude to emit
  // text before tool calls complete. qa_only disables partial streaming and project
  // skills so visitors get plain text answers instead of silent tool attempts.
  // Runtime skills are stored under the isolated CLAUDE_CONFIG_DIR/skills,
  // which Claude Code treats as the user skill source.
  const settingSources: SettingSource[] = channelPermissionMode === 'qa_only' || opts.restrictBuiltInTools
    ? []
    : ['user', 'project']
  const includePartialMessages = channelPermissionMode === 'qa_only'
    ? false
    : opts.streaming !== false

  const textBlockBuf: { id: string; text: string }[] = []
  const queryStartTime = Date.now()
  log.info(` calling Claude API 鈥?model=${settings.model}, base_url=${settings.base_url || 'https://api.anthropic.com'}`)

  // Resolve webcli directory for PATH so Bash can find the `webcli` command
  const webcliDir = resolveWebcliDir()
  log.info(` webcliDir=${webcliDir}, exists=${fs.existsSync(webcliDir)}`)
  const pathPrefix = [webcliDir, path.dirname(process.execPath)].join(path.delimiter)
  const envWithWebcli = {
    ...queryEnv,
    PATH: `${pathPrefix}${path.delimiter}${queryEnv.PATH || process.env.PATH || ''}`,
    WEWORKER_ALLOWED_OPEN_BROWSER_ORIGINS: getOpenBrowserAllowedOrigins().join(','),
    WEWORKER_ADAPTERS_DIR: path.join(getUserDirectory(), '.claude', 'skills'),
    // Ensure Electron binary can act as Node.js runtime for packaged webcli
    ...(process.env.WEWORKER_PACKAGED ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  }

  const nativeCommandTool = process.platform === 'win32' ? 'PowerShell' : 'Bash'
  const alternateCommandTool = process.platform === 'win32' ? 'Bash' : 'PowerShell'
  const baseDisallowed = ['Agent', 'WebFetch', 'Task', 'TaskOutput', 'CronList', 'CronCreate', 'CronDelete', 'AskUserQuestion', alternateCommandTool]
  let disallowedTools = channelPermissionMode === 'qa_only'
    ? [...baseDisallowed, nativeCommandTool, 'Skill', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit', 'TodoWrite', 'WebSearch']
    : channelPermissionMode === 'no_bash'
      ? [...baseDisallowed, nativeCommandTool]
      : baseDisallowed
  if (opts.restrictBuiltInTools) {
    disallowedTools = [...new Set([
      ...disallowedTools,
      nativeCommandTool,
      'Skill', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit', 'TodoWrite', 'WebSearch',
    ])]
  }
  const filesystemSettings = buildAgentFilesystemSettings(getUserDirectory(), channelPermissionMode)
  const filesystemToolGuard = createUnifiedToolGuard(channelPermissionMode)
  const toolPolicy = createWeWorkerToolPolicy(channelPermissionMode)
  const canUseTool: typeof toolPolicy = async (toolName, input, context) => {
    const policyDecision = await toolPolicy(toolName, input, context)
    if (!policyDecision) {
      return { behavior: 'deny', message: `Tool permission was not resolved: ${toolName}`, interrupt: false }
    }
    if (policyDecision.behavior === 'deny') return policyDecision
    return filesystemToolGuard(toolName, input as Record<string, unknown>)
  }

  const memoryEnabled = opts.memoryEnabled !== false
  const skillRoots = channelPermissionMode === 'qa_only' || opts.restrictBuiltInTools ? [] : [
    path.join(queryEnv.CLAUDE_CONFIG_DIR!, 'skills'),
    path.join(getUserDirectory(), '.claude', 'skills'),
  ]
  const loadedSkills = buildLoadedSkillContext(messages, skillRoots)
  const skillContextCollector = createSkillContextCollector(skillRoots)
  log.info('skill_context_replay', { present: !!loadedSkills, chars: loadedSkills.length })
  const storedCompactedConversation = takeStoredCompactedConversation(opts.workId, messages.length)
  const latestMessage = messages[messages.length - 1]
  const promptRaw = storedCompactedConversation
    ? storedCompactedConversation.includesCurrent || !latestMessage
      ? storedCompactedConversation.prompt
      : `${storedCompactedConversation.prompt}\n\nUser: ${messagePromptText(latestMessage)}`
    : buildPromptString(messages)
  const prompt = promptRaw
  const memoryQuery = messages.length > 0
    ? messagePromptText(messages[messages.length - 1]).slice(0, 2_000)
    : ''
  const identityPrompt = channelPermissionMode === 'qa_only'
    ? '你是 WeWorker 问答助手。'
    : '你是 WeWorker，一个通过 Adapter 操作网页的 AI 助手。'
  const longTermMemory = memoryEnabled
    ? recallLongTermMemory({
      query: memoryQuery,
      scope: opts.memoryScope ?? { user: 'local' },
      limit: 8,
    })
    : { recalled: '' }
  const memoryProtocol = memoryEnabled
    ? buildMemoryOutputProtocolPrompt({
      scope: opts.memoryScope ?? { user: 'local' },
      triggerHint: opts.memoryTriggerHint ?? 'chat',
      expectedMemoryType: opts.memoryExpectedType,
      previousTaskFailed: opts.previousTaskFailed,
    })
    : ''
  const systemPrompt = opts.systemPromptOverride ?? buildSystemPrompt({
      channelPermissionMode,
      zcfRole: opts.zcfRole,
      zcfMode: opts.zcfMode,
      zcfCustomRoles: settings.zcf_custom_roles,
      memoryProtocol,
    })
  const buildAssembly = (conversationPrompt: string, compaction?: ConversationCompactionSnapshot) => buildContextAssembly({
    systemPrompt,
    identityPrompt,
    prompt: conversationPrompt,
    toolDefinitions: [
      `Claude Code 原生 ${nativeCommandTool}`,
      'Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit', 'Skill', 'TodoWrite',
    ].join('\n'),
    skillIndex: channelPermissionMode === 'qa_only' || opts.restrictBuiltInTools ? '' : buildEnabledSkillIndex(path.join(queryEnv.CLAUDE_CONFIG_DIR || '', 'skills')),
    loadedSkills,
    mcpDynamicTools: opts.mcpServerOverride ? '' : getMcpToolDefinitionSummary(channelPermissionMode),
    subagentDefinitions: '',
    recalledMemory: longTermMemory.recalled,
    contextLimit: settings.context_limit,
    compaction,
  })
  const fullContextAssembly = buildAssembly(prompt)
  const nonConversationTokens = fullContextAssembly.snapshot.categories
    .filter((item) => item.id !== 'conversation')
    .reduce((sum, item) => sum + item.estimated_tokens, 0)
  const conversationTokens = fullContextAssembly.snapshot.categories
    .find((item) => item.id === 'conversation')?.estimated_tokens ?? 0
  const compactionPlan = planConversationCompaction({
    contextLimit: fullContextAssembly.snapshot.context_limit,
    nonConversationTokens,
    conversationTokens,
  })
  let contextAssembly = fullContextAssembly
  let compactionEventEmitted = false
  let compactionCompleted = false

  if ((compactionPlan.shouldCompact || opts.forceCompaction) && messages.length > 1) {
    const historyMessages = messages.slice(0, -1)
    const currentMessage = messages[messages.length - 1]
    const currentTokens = estimateContextTokens(messagePromptText(currentMessage))
    const recentSelection = takeRecentWithinTokenBudget(
      historyMessages,
      Math.max(1, compactionPlan.targetTokens - currentTokens),
      (message) => estimateContextTokens(messagePromptText(message)),
    )
    const compactionBase = {
      mode: 'conversation_only' as const,
      before_tokens: conversationTokens,
      after_tokens: 0,
      summarized_message_count: recentSelection.dropped.length,
      retained_message_count: recentSelection.retained.length + 1,
    }
    if (recentSelection.dropped.length > 0) {
      const summarySource = recentSelection.dropped
        .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${messagePromptText(message)}`)
        .filter((text) => text.trim())
        .join('\n\n')
      compactionEventEmitted = true
      yield { type: 'context_compaction_start', compaction: { ...compactionBase, status: 'started' } }
      try {
        const summary = await summarizeConversationOnly({
          conversation: summarySource,
          settings,
          abortController,
          env: envWithWebcli,
          claudeSetup,
          spawnClaudeCodeProcess,
        })
        if (summary) {
          const recentConversation = buildPromptString([...recentSelection.retained, currentMessage])
          const compactedConversation = buildCompactedConversationPrompt({
            summary: clampPromptText(summary, 16_000),
            recentConversation,
          })
          const compactedPrompt = compactedConversation
          const compaction = {
            ...compactionBase,
            after_tokens: estimateContextTokens(compactedPrompt),
          }
          contextAssembly = buildAssembly(compactedPrompt, compaction)
          compactionCompleted = true
          if (opts.compactionOnly && opts.workId) {
            compactedConversationByWork.set(opts.workId, {
              sourceMessageCount: messages.length,
              prompt: compactedConversation,
            })
          }
          compactionEventEmitted = true
          yield { type: 'context_compaction_end', compaction: { ...compaction, status: 'completed' } }
        } else {
          compactionEventEmitted = true
          yield { type: 'context_compaction_end', compaction: { ...compactionBase, status: 'failed', reason: 'summary_unavailable', error: '摘要器未返回内容' } }
        }
      } catch (error) {
        if (abortController?.signal.aborted) throw error
        compactionEventEmitted = true
        yield {
          type: 'context_compaction_end',
          compaction: {
            ...compactionBase,
            status: 'failed',
            reason: 'summary_failed',
            error: error instanceof Error ? error.message : String(error),
          },
        }
      }
    } else {
      compactionEventEmitted = true
      yield {
        type: 'context_compaction_end',
        compaction: {
          ...compactionBase,
          after_tokens: conversationTokens,
          status: 'skipped',
          reason: 'no_droppable_history',
        },
      }
    }
  }
  if (opts.forceCompaction && !compactionEventEmitted) {
    yield {
      type: 'context_compaction_end',
      compaction: {
        mode: 'conversation_only',
        before_tokens: conversationTokens,
        after_tokens: conversationTokens,
        summarized_message_count: 0,
        retained_message_count: messages.length,
        status: 'skipped',
        reason: 'no_droppable_history',
      },
    }
  }
  yield { type: 'context_snapshot', context: contextAssembly.snapshot }
  if (opts.compactionOnly) {
    if (compactionCompleted) {
      try {
        const usage = await probeContextUsage({
          contextAssembly,
          settings,
          abortController,
          claudeSetup,
          spawnClaudeCodeProcess,
          env: envWithWebcli,
          mcpServer,
          disallowedTools,
          settingSources,
        })
        yield { type: 'usage', usage } as SSEEvent
      } catch (error) {
        log.error('post-compaction usage probe failed', error instanceof Error ? error.message : String(error))
      }
    }
    yield { type: 'done' }
    return
  }
  const turnContextCollector = createTurnContextCollector(contextAssembly.snapshot)
  let memoryUserPromptInjectionCount = 0
  let memoryPostToolBatchInjectionCount = 0
  const memoryUserPromptSubmitHook: HookCallback = async (): Promise<HookJSONOutput> => {
    memoryUserPromptInjectionCount += 1
    log.info('memory_reminder_injected', {
      source: 'user_prompt_submit',
      sequence: memoryUserPromptInjectionCount,
      present: true,
    })
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: MEMORY_USER_TURN_REMINDER,
      },
    }
  }
  const memoryPostToolBatchHook: HookCallback = async (): Promise<HookJSONOutput> => {
    memoryPostToolBatchInjectionCount += 1
    log.info('memory_reminder_injected', {
      source: 'post_tool_batch',
      sequence: memoryPostToolBatchInjectionCount,
      present: true,
    })
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PostToolBatch',
        additionalContext: MEMORY_USER_TURN_REMINDER,
      },
    }
  }

  const queryHandle = query({
    prompt: contextAssembly.sdk.prompt,
    options: {
      abortController,
      model: settings.model,
      systemPrompt: contextAssembly.sdk.system_prompt,
      mcpServers: { weworker: activeMcpServer },
      disallowedTools,
      canUseTool,
      settings: filesystemSettings,
      // bypassPermissions skips canUseTool; blacklist enforcement relies on canUseTool + tool handlers.
      permissionMode: 'default',
      includePartialMessages,
      cwd: getUserDirectory(),
      settingSources,
      pathToClaudeCodeExecutable: claudeSetup.pathToClaudeCodeExecutable,
      spawnClaudeCodeProcess,
      env: envWithWebcli,
      hooks: memoryEnabled ? {
        UserPromptSubmit: [{ hooks: [memoryUserPromptSubmitHook] }],
        PostToolBatch: [{ hooks: [memoryPostToolBatchHook] }],
      } : undefined,
    },
  })

  // When the abort signal fires, forcefully close the query to kill the
  // underlying Claude CLI subprocess. Without this, the child process
  // keeps running (and operating on websites) even after the HTTP
  // connection is closed.
  let queryRunning = true
  const onAbort = () => {
    log.info(` onAbort called 鈥?queryRunning=${queryRunning}`)
    if (!queryRunning) return // query already finished, nothing to kill
    log.info(' abort signal received, closing query handle')
    queryHandle.close()
  }
  if (abortController) {
    if (abortController.signal.aborted) {
      log.info(' abortController already aborted before query started')
      queryHandle.close()
      return
    }
    abortController.signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    log.info(' starting for-await over queryHandle')
    let firstEventReceived = false
    let completed = false
    let assistantResponseCount = 0
    let memoryParseCount = 0
    let sdkUserEventCount = 0
    let sdkUserReminderObservedCount = 0
    for await (const msg of queryHandle) {
      if (!firstEventReceived) {
        firstEventReceived = true
        log.info(` first event received 鈥?elapsed=${((Date.now() - queryStartTime) / 1000).toFixed(2)}s`)
      }
      if (msg.type === 'user') {
        sdkUserEventCount += 1
        const serialized = JSON.stringify(msg)
        const reminderObserved = serialized.includes(MEMORY_USER_TURN_REMINDER)
        if (reminderObserved) sdkUserReminderObservedCount += 1
        log.info('memory_reminder_observed', {
          source: 'sdk_user_event',
          present: reminderObserved,
        })
      }
      if (msg.type === 'assistant') assistantResponseCount += 1
      for (const skillContext of skillContextCollector.observe(msg)) {
        turnContextCollector.observe({ type: 'skill_context', id: skillContext.tool_use_id, content: skillContext.text })
        log.info('skill_context_captured', { chars: skillContext.text.length })
        yield { type: 'skill_context', skillContext }
      }
      for (const event of mapSdkMessage(msg, includePartialMessages, textBlockBuf)) {
        if (event.type === 'memory_parse') memoryParseCount += 1
        if (
          event.type === 'text_delta'
          || event.type === 'tool_call_start'
          || event.type === 'tool_call_result'
          || event.type === 'usage'
        ) {
          turnContextCollector.observe(event)
        }
        if (event.type === 'done') {
          completed = true
        } else {
          yield event
        }
      }
    }
    if (completed) {
      for (const event of turnContextCollector.finish()) yield event
    }
    log.info(` for-await loop completed normally 鈥?total=${((Date.now() - queryStartTime) / 1000).toFixed(2)}s`)
    log.info('memory_context_check', {
      user_prompt_injections: memoryUserPromptInjectionCount,
      post_tool_batch_injections: memoryPostToolBatchInjectionCount,
      assistant_responses: assistantResponseCount,
      memory_parse_events: memoryParseCount,
      sdk_user_events: sdkUserEventCount,
      sdk_user_reminders_observed: sdkUserReminderObservedCount,
    })
  } catch (e) {
    // Silently ignore abort errors (user cancelled)
    if (e instanceof Error && (e.name === 'AbortError' || e.message.includes('aborted'))) {
      log.info(` caught abort error: ${e.message}`)
      return
    }
    log.info(` caught error: ${e instanceof Error ? e.message : String(e)}`)
    yield { type: 'error', content: e instanceof Error ? e.message : String(e) }
  } finally {
    log.info(' finally block 鈥?setting queryRunning=false')
    queryRunning = false
    if (abortController) {
      abortController.signal.removeEventListener('abort', onAbort)
    }
  }
}
