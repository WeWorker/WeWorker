import { query } from '@anthropic-ai/claude-agent-sdk'
import type {
  SDKMessage,
  SDKUserMessage,
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
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Settings } from './config.js'
import { getConfigDirectory, getOpenBrowserAllowedOrigins, getSiteEnabled, getUserDirectory, getUserDirectoryBlacklist } from './config.js'
import { formatBlacklistEntry } from './user-directory-blacklist.js'
import type { ChannelPermissionMode } from './channels/channel-permissions.js'
import type { Message } from './works-store.js'
import { buildMcpServer as _buildMcpServer, getMcpToolDefinitionSummary } from './tools.js'
import { parseAllAdapters } from './adapter-parser.js'
import { getDesktopAdapterCatalog, refreshDesktopAdapterSkillsIfStale } from './adapter-catalog-cache.js'
import { bridgeStatus, type ExtensionInstance } from './bridge-status.js'
import {
  ChatSession,
  fingerprintSkillFiles,
  PromptQueue,
  disposeChatSession,
  findReusableChatSession,
  hasChatSession,
  hasSpareChatSession,
  isChatSessionBusy,
  registerChatSession,
  registerSpareChatSession,
  type ChatHistoryEntry,
  type ChatTurnBindings,
} from './chat-session.js'
import type { UserMediaSink } from './user-media.js'
import { buildAgentFilesystemSettings, createUnifiedToolGuard } from './user-directory-access.js'
import { createLogger } from './logger.js'
import { resolveWebcliDir } from './webcli-path.js'
import { syncBundledWebcliSkills } from './webcli-skills.js'
import { composeSystemPromptWithStyle } from './style-settings.js'
import { computeUsageMetrics, createContextUsageTracker, createApiDurationTracker, resolveTurnApiDuration, type ApiDurationTracker } from './usage-metrics.js'
import { assertAllowedLlmBaseUrl } from './llm-egress.js'
import { buildRuntimeAllowedLlmBaseUrls, findProviderByWeWorkerBaseUrl } from './provider-registry.js'
import { prepareModelRuntime } from './anthropic-endpoint-relay.js'
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
  CONVERSATION_COMPACTION_TARGET_RATIO,
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
import { buildThinkingExtraBody, resolveThinkingEffort, type ThinkingEffort } from './thinking-effort.js'
import { StreamingVisibleText } from './streaming-visible-text.js'

const log = createLogger('agent')

const compactedConversationByWork = new Map<string, {
  sourceMessageCount: number
  sourceHash: string
  prompt: string
}>()

function conversationHash(messages: Message[]): string {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex')
}

function getStoredCompactedConversation(workId: string | undefined, messages: Message[]) {
  if (!workId) return undefined
  const stored = compactedConversationByWork.get(workId)
  if (!stored) return undefined
  if (messages.length < stored.sourceMessageCount
    || conversationHash(messages.slice(0, stored.sourceMessageCount)) !== stored.sourceHash) {
    compactedConversationByWork.delete(workId)
    return undefined
  }
  return stored
}

export function clearStoredConversationCompaction(workId: string): void {
  compactedConversationByWork.delete(workId)
}

const MODEL_AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_OAUTH_TOKEN',
]

export function ensureIsolatedClaudeConfigDir(
  platform: NodeJS.Platform = process.platform,
  configDir: string = path.join(getConfigDirectory(), 'claude-config'),
): string {
  const dir = configDir
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(path.join(dir, 'skills'), { recursive: true })
  // Runs before every turn: rewrite the JSON files only when the enforced keys change.
  const updateJsonObject = (file: string, update: (value: Record<string, unknown>) => void) => {
    let raw = ''
    let value: Record<string, unknown> = {}
    try {
      raw = fs.readFileSync(file, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        value = parsed as Record<string, unknown>
      }
    } catch {
      value = {}
    }
    update(value)
    const next = JSON.stringify(value, null, 2)
    if (next !== raw) fs.writeFileSync(file, next)
  }
  updateJsonObject(path.join(dir, '.claude.json'), (config) => { config.env = {} })
  if (platform === 'win32') {
    updateJsonObject(path.join(dir, 'settings.json'), (userSettings) => { userSettings.defaultShell = 'powershell' })
  }
  return dir
}

export function buildClaudeNativeShellEnv(
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  return platform === 'win32' ? { CLAUDE_CODE_USE_POWERSHELL_TOOL: '1' } : {}
}

export function buildConfiguredModelEnv(
  settings: Pick<Settings, 'api_key' | 'base_url'> & Partial<Pick<Settings, 'active_provider' | 'active_weworker_protocol' | 'custom_auth_type' | 'active_auth_type' | 'model'>>,
  extraEnv?: NodeJS.ProcessEnv,
  claudeConfigDir?: string,
): NodeJS.ProcessEnv {
  const env = { ...process.env, ...buildClaudeNativeShellEnv(), ...extraEnv }
  for (const key of MODEL_AUTH_ENV_KEYS) delete env[key]
  delete env.CLAUDE_CODE_GIT_BASH_PATH
  delete env.WEWORKER_BUNDLED_GIT_BASH
  const baseUrl = assertAllowedLlmBaseUrl(settings.base_url, buildRuntimeAllowedLlmBaseUrls(settings.base_url))
  const effectiveProviderId = settings.active_provider === 'custom'
    ? findProviderByWeWorkerBaseUrl(baseUrl)?.id || settings.active_provider
    : settings.active_provider
  if (usesAnthropicBearerToken(effectiveProviderId, settings.active_auth_type ?? settings.custom_auth_type)) {
    env.ANTHROPIC_AUTH_TOKEN = settings.api_key
  } else {
    env.ANTHROPIC_API_KEY = settings.api_key
  }
  if (settings.active_provider === 'bank_coding') {
    const model = settings.model
    if (!model) throw new Error('模型服务尚未配置')
    env.ANTHROPIC_MODEL = model
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = model
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = model
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  }
  env.CLAUDE_CONFIG_DIR = claudeConfigDir
    ? ensureIsolatedClaudeConfigDir(process.platform, claudeConfigDir)
    : ensureIsolatedClaudeConfigDir()
  if (baseUrl !== 'https://api.anthropic.com') {
    env.ANTHROPIC_BASE_URL = baseUrl
  } else {
    delete env.ANTHROPIC_BASE_URL
  }
  return env
}

export function buildDisallowedTools(
  channelPermissionMode: ChannelPermissionMode,
  platform: NodeJS.Platform = process.platform,
  restrictBuiltInTools = false,
): string[] {
  const nativeCommandTool = platform === 'win32' ? 'PowerShell' : 'Bash'
  const alternateCommandTool = platform === 'win32' ? 'Bash' : 'PowerShell'
  const baseDisallowed = [
    'Agent',
    'WebFetch',
    'Task',
    'TaskOutput',
    'CronList',
    'CronCreate',
    'CronDelete',
    'AskUserQuestion',
    // Hide definitions as well as denying execution in createWeWorkerToolPolicy.
    // These SDK tools are not supported by WeWorker, even in full mode.
    'EnterWorktree',
    'ExitWorktree',
    'ListAgents',
    'ReportFindings',
    'ScheduleWakeup',
    'SendMessage',
    'TaskCreate',
    'TaskGet',
    'TaskList',
    'TaskStop',
    'TaskUpdate',
    'WebSearch',
    'Workflow',
    alternateCommandTool,
  ]
  const restrictedBuiltInTools = [
    'Skill',
    'Read',
    'Glob',
    'Grep',
    'Edit',
    'Write',
    'NotebookEdit',
    'TodoWrite',
  ]
  if (channelPermissionMode === 'qa_only' || restrictBuiltInTools) {
    return [...baseDisallowed, nativeCommandTool, ...restrictedBuiltInTools]
  }
  if (channelPermissionMode === 'no_bash') return [...baseDisallowed, nativeCommandTool]
  return baseDisallowed
}

export function ensureAgentWorkingDirectory(directory = getUserDirectory()): string {
  fs.mkdirSync(directory, { recursive: true })
  return directory
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
  /** Latest main model request input, separate from cumulative billing usage. */
  context_input_tokens?: number
  cache_hit_rate: number
  total_cost_usd?: number
  duration_ms?: number
  /** Per-turn API time (delta of the CLI's session-cumulative duration_api_ms). */
  duration_api_ms?: number
  /** Session-cumulative API time reported by the CLI, for diagnostics only. */
  duration_api_ms_total?: number
  num_turns?: number
  kind?: 'turn' | 'post_compaction_probe'
}

export function buildSystemPrompt(opts?: {
  channelPermissionMode?: ChannelPermissionMode
  platform?: NodeJS.Platform
  styleId?: string | null
  customStyles?: import('./style-settings.js').CustomStyle[]
  memoryProtocol?: string
  /** Browser whose extension serves Adapter calls; 'dedicated' is WeWorker 浏览器. */
  browserInstance?: ExtensionInstance
}): string {
  const channelPermissionMode = opts?.channelPermissionMode ?? 'full'
  const platform = opts?.platform ?? process.platform
  const nativeCommandTool = platform === 'win32' ? 'PowerShell' : 'Bash'
  const defaultShell = platform === 'win32' ? 'powershell' : 'bash'
  if (channelPermissionMode === 'qa_only') {
    const base = renderPrompt('agent-qa-only', {}).trim()
    return composeSystemPromptWithStyle(`${base}\n\n${opts?.memoryProtocol ?? ''}`.trim(), opts?.styleId, opts?.customStyles ?? [])
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
  const openBrowserDesc = `使用 Claude Code 内置 ${nativeCommandTool} 执行 \`webcli call open_browser --url=<url> [--adapter=<adapter-id>]\``
  const webcliStep2 = `2. 使用 Claude Code 内置 ${nativeCommandTool} 执行 \`webcli call <完整工具名> --参数名=参数值\``
  const openBrowserRule = `用 Claude Code 内置 ${nativeCommandTool} 执行 \`webcli call open_browser --url=... [--adapter=<adapter-id>]\``
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
  // Login is handled by WeWorker itself (webcli/site-login.js): no pre-checks by the model.
  const browserLabel = opts?.browserInstance === 'dedicated' ? '「WeWorker 浏览器」' : '浏览器'
  const loginDetectionRules = adapterExecutionEnabled ? `
## 网站登录

网站工具会自动处理登录：遇到未登录时，WeWorker 会在${browserLabel}中打开该网站的登录页，等待用户完成（扫码、短信验证码或账号密码均可），然后自动重试原命令。
- 不要预先打开网站检测登录，也不要为了检测登录调用 check_login_status、check-login-status、whoami 或 login 命令；直接调用要用的工具。
- \`open_browser\` 返回成功但 \`auth.status\` 为 \`waiting_user\` 时，页面已打开但网站尚未登录：立即告诉用户完成登录并停止本轮后续网站调用，不要重试 \`open_browser\`；桌面端会继续显示登录进度。
- 工具返回 \`code: AUTH_REQUIRED\` 且 \`auth.status\` 为 \`waiting_user\` 时：告诉用户需要在${browserLabel}中登录该网站（登录页已打开${opts?.browserInstance === 'dedicated' ? '，也可点击 WeWorker 左侧栏底部的浏览器图标显示' : ''}），用户完成后再执行一次原命令。\`auth.screenshot\` 是登录页截图路径，可直接展示给用户扫码。${opts?.browserInstance === 'dedicated' ? '不要让用户去自己的 Chrome 登录。' : ''}
- \`AUTH_CANCELLED\` 表示用户取消了登录；\`AUTH_RETRY_REQUIRED\` 表示写操作因登录中断、登录已完成，需向用户确认后再执行。
` : ''
  const base = `${renderPrompt('agent', {
    adapter_capability: adapterExecutionEnabled
      ? '你通过 webcli 命令行工具调用 Extension Adapter 与 Toolkit Adapter，能够在网页上执行操作。'
      : '当前权限模式允许使用标准 Skill 和受控文件／Shell 工具，但不能执行 Extension Adapter 或 Toolkit Adapter。',
    adapter_execution_guidance: adapterExecutionEnabled
      ? `所有网站工具通过${webcliInvokeDesc}调用。
以命令的 runtime/execution 与当前 Adapter Skill 为准：\`type=api, runtime=background\` 或标为 background API 的命令直接调用，无需先打开业务页或检测页面登录；不要求同时具有 \`mode=direct\` 标记。旧 Skill 仅有 \`mode=direct\` 时仍兼容。缺登录或缓存时按具体错误完成显式准备，不能把后台命令改成页面调用。
Host-managed Extension Adapter（包括页面/DOM 命令）必须直接调用业务工具；宿主会自动选择、复用或创建匹配标签页，并处理 \`AUTH_REQUIRED\` 登录流程。调用前不要${openBrowserDesc}，也不要做登录预检。未知站点和 API 探索必须使用 \`webcli call browser.open --session=<name> --url=<url>\`，不得使用依赖已安装 Adapter 允许列表的 open_browser。只有用户明确要求打开已授权站点，或当前 Adapter Skill 明确要求手工页面准备时，才使用 \`open_browser\`。Toolkit 命令按其 Skill 的运行时说明执行。`
      : 'Skill 可用于阅读说明，但不要执行其中的 Adapter 命令。',
    new_adapter_guidance: adapterExecutionEnabled
      ? `用户要求探索接口、封装查询或生成/修复 Adapter 时，读取共享 Skill：\`webcli skills read webcli-api-exploration\`，按需读取 \`webcli\` 和 \`webcli-browser\`。没有现成网站 Skill 也可探索；由当前聊天 Agent 理解、观察和编写，通过内置 ${nativeCommandTool} 调用 \`webcli call exploration.<command>\`，不启动另一套模型协调流程。
先用 \`exploration.help\`、\`exploration.capabilities\` 和 \`profile.list\` 核对实际契约与选定浏览器。使用 PATH 中的桌面内置 WebCLI，不安装全局 npm 版替换它。能力缺失时说明需要更新匹配的客户端/Bridge/扩展，不退回旧流程。旧聊天中的 start_api_exploration/start_adapter_generation 等入口已停用；历史任务在独立探索页面查看，不将旧 taskId 交给新流程。
客户端模型凭据仅用于模型连接，不得读取环境变量或客户端配置来获取、打印或复用模型 Key 作为网站凭据，也不得为注入凭据而重启 Bridge。当前成员的查询先观察目标网站的登录态和真实请求，不凭品牌相同猜接口或账号口径；准备后无业务页允许首次观察与显式准备。
按共享 Skill 完成证据、草稿、真实 cases、validate、review、授权内 install，再普通调用。collecting/validating 只是运行中，使用 get/events 有界等待；用户取消时调用 exploration.cancel，已派发请求不自动重放。不要让用户手写代码或计划 JSON；登录/明确账号上下文/超出授权的安装范围用 ask_user 询问。
安装后立即通过 \`webcli adapter info/skill <id>\` 读取最新命令和说明；同轮不依赖旧 Skill 缓存，后续聊天由客户端刷新。草稿用 exploration.draft-read/draft-write，受审阅安装由 WebCLI 完成，不直接编辑托管 Skill 目录。`
      : '当前权限模式不能探索网站或生成/安装 Adapter；需要执行时明确说明需要 full 权限。',
    webcli_execution_step: adapterExecutionEnabled
      ? webcliStep2
      : '2. 当前权限模式不能执行 Adapter；需要执行时明确说明需要 full 权限。',
    native_command_capability: bashCapabilityNotice,
    open_browser_guidance: adapterExecutionEnabled
      ? '不要在 Host-managed Extension Adapter（包括页面/DOM 命令）之前调用 open_browser 或登录检查；宿主会自动处理匹配标签页与登录。未知站点或 API 探索使用 webcli call browser.open --session=<name> --url=<url>。open_browser 只用于用户明确要求显示已授权网站，或当前 Adapter Skill 明确要求手工准备页面。打开已知 Adapter 的网站时传 `--adapter=<adapter-id>` 以接入该站登录 flow；探索未知网页时省略该参数。后台 API 不要预先打开网站；HTTP 与 Toolkit 按各自运行时执行。'
      : '本节仅在 full 权限可执行；当前不要打开网站或调用 Adapter。',
    open_browser_wait_rule: adapterExecutionEnabled
      ? `${openBrowserRule} 仅在确实需要手工页面准备时使用；使用后必须等待至少 5 秒再执行依赖该页面的后续页面/DOM 操作。`
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
    login_detection_rules: loginDetectionRules,
  }).trimEnd()}\n`
  return composeSystemPromptWithStyle(`${base}\n\n${opts?.memoryProtocol ?? ''}`.trim(), opts?.styleId, opts?.customStyles ?? [])
}
function findClaudeExecutable(): string | undefined {
  const configured = process.env.WEWORKER_CLAUDE_CODE_PATH
  if (configured && fs.existsSync(configured)) return configured
  // On Windows the SDK resolves the bundled native executable itself. Running
  // a Unix locator through PowerShell on every turn adds startup delay and fails.
  if (process.platform === 'win32') return undefined
  try {
    const result = execSync('which claude', {
      shell: process.env.SHELL || '/bin/zsh',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
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
      if (result.subtype === 'success' && !result.is_error && summary) return summary
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
  if (block.type === 'timing') {
    // 智能路由（fast-path）命中回合的 provenance 投影：fast-path 跳过了 LLM，
    // 模型只能靠历史 md 认出那份结果；timing 块带 routeTool 时把来源/参数序列化成模型可见
    // 的一行，追问回合据此可直接引用上文数据、细查时优先复用同 tool。普通耗时块（无
    // routeTool）对模型无意义，保持空（与旧行为零差异）。
    if (!block.routeTool) return ''
    return [
      `[智能路由结果] tool=${block.routeTool}${block.routeSource ? ` source=${block.routeSource}` : ''}${block.routeArgs ? ` args=${clampPromptText(block.routeArgs, 800)}` : ''}`,
      '（本条 assistant 消息中的结果是直调 API 得到的确定性查询结果，未经模型加工，数据真实可信；追问可直接引用其中的数据，需要更细内容时优先用同 tool 重查。）',
    ].join('\n')
  }
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

export function messagePromptText(message: Message): string {
  return message.content
    .map(contentBlockPromptText)
    .filter((text) => text.trim())
    .join('\n')
}

export const HISTORY_REPLAY_HEADER = '[以下是之前的对话历史，仅供参考]'
export const CURRENT_USER_MESSAGE_HEADER = '[当前用户消息]'
const RECALLED_MEMORY_HEADER = '[相关长期记忆]'

// Convert stored messages to a single prompt string for the Agent SDK
export function buildPromptString(messages: Message[]): string {
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
  return `${HISTORY_REPLAY_HEADER}\n${historyText}\n\n${CURRENT_USER_MESSAGE_HEADER}\n${lastText}`
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

/**
 * SDK message → SSE event mapping, including the per-turn `usage` metrics.
 *
 * Exported for focused tests of the `usage` log line / event: the CLI's
 * `duration_api_ms` is session-cumulative, so `apiDuration` must be the same
 * tracker object for every turn of one CLI session.
 */
export function* mapSdkMessage(
  msg: SDKMessage,
  streaming: boolean,
  textBlockBuf: { id: string; text: string; filter: StreamingVisibleText }[],
  apiDuration: ApiDurationTracker = createApiDurationTracker(),
): Generator<SSEEvent> {
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
        textBlockBuf.push({ id: String(event.index ?? textBlockBuf.length), text: '', filter: new StreamingVisibleText() })
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
      const id = String(event.index ?? textBlockBuf.length - 1)
      let buf = textBlockBuf.find(block => block.id === id)
      if (!buf) {
        buf = { id, text: '', filter: new StreamingVisibleText() }
        textBlockBuf.push(buf)
      }
      buf.text += event.delta.text
      const visible = buf.filter.push(event.delta.text)
      if (visible) yield { type: 'text_delta', content: visible }
      return
    }

    if (event.type === 'content_block_stop') {
      const index = event.index === undefined ? textBlockBuf.length - 1 : textBlockBuf.findIndex(block => block.id === String(event.index))
      const buf = index >= 0 ? textBlockBuf.splice(index, 1)[0] : undefined
      if (buf?.text) {
        const remaining = buf.filter.finish()
        if (remaining) yield { type: 'text_delta', content: remaining }
        const cleaned = stripBase64Images(buf.text)
        const parsed = parseAssistantMemoryOutput(cleaned)
        const memoryParse = summarizeAssistantMemoryParse(parsed)
        log.info('memory_parse', memoryParse)
        yield { type: 'memory_parse', memoryParse }
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
    if (msg.error) {
      const detail = msg.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n')
      yield { type: 'error', content: detail || msg.error }
      return
    }
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
      duration_api_ms?: number
      ttft_ms?: number
      time_to_request_ms?: number
      time_to_request_from_spawn_ms?: number
      num_turns?: number
      is_error?: boolean
      errors?: string[]
      result?: string
    }
    // `duration_api_ms` is the CLI's session-cumulative API duration (same
    // ledger lifecycle as total_cost_usd), so the per-turn value is a delta
    // against the previous sample of this query() session.
    const apiDurationSample = resolveTurnApiDuration(r.duration_api_ms, apiDuration.lastCumulativeMs)
    if (apiDurationSample.cumulativeMs !== null) {
      apiDuration.lastCumulativeMs = apiDurationSample.cumulativeMs
    }
    if (r.usage) {
      const m = computeUsageMetrics(r.usage)
      log.info(
        `usage in=${m.input_tokens} cache_read=${m.cache_read_input_tokens} cache_create=${m.cache_creation_input_tokens} out=${m.output_tokens} total_in=${m.total_input_tokens} cache_hit=${(m.cache_hit_rate * 100).toFixed(1)}% cost=$${r.total_cost_usd ?? 0} dur=${r.duration_ms ?? 0}ms api=${apiDurationSample.turnMs ?? '?'}ms api_total=${apiDurationSample.cumulativeMs ?? '?'}ms${apiDurationSample.baselineReset ? ' api_reset=true' : ''} ttft=${r.ttft_ms ?? '?'}ms to_request=${r.time_to_request_ms ?? '?'}ms spawn_to_request=${r.time_to_request_from_spawn_ms ?? '?'}ms turns=${r.num_turns ?? 0} subtype=${r.subtype ?? '?'}`,
      )
      yield {
        type: 'usage',
        usage: {
          ...m,
          total_cost_usd: r.total_cost_usd,
          duration_ms: r.duration_ms,
          duration_api_ms: apiDurationSample.turnMs ?? undefined,
          duration_api_ms_total: apiDurationSample.cumulativeMs ?? undefined,
          num_turns: r.num_turns,
        },
      } as SSEEvent
    }
    if (r.is_error === true || r.subtype !== 'success') {
      yield {
        type: 'error',
        content: (r.errors ?? []).filter(Boolean).join('\n') || r.result || `Claude Code execution failed (${r.subtype ?? 'unknown'})`,
      }
    }
    yield { type: 'done' }
  }
}

export async function* streamChat(...args: Parameters<typeof streamChatWithBaseUrl>): AsyncGenerator<SSEEvent> {
  let runtime: Awaited<ReturnType<typeof prepareModelRuntime>>
  try {
    runtime = await prepareModelRuntime(args[1])
  } catch {
    yield { type: 'error', content: '模型接口地址无效或无法启动本地转发' }
    return
  }
  // A persistent session started in this turn keeps using the relay's address,
  // so it takes ownership of the relay and closes it together with the CLI.
  let adopted = false
  const internal: StreamChatInternalOptions = {
    sessionBaseUrl: args[1].base_url,
    adoptModelRuntime: () => {
      adopted = true
      return runtime.close
    },
  }
  try {
    yield* streamChatWithBaseUrl(args[0], runtime.settings, args[2], { ...args[3], [STREAM_CHAT_INTERNAL]: internal })
  } finally {
    if (!adopted) await runtime.close()
  }
}

const STREAM_CHAT_INTERNAL = Symbol('streamChatInternal')
interface StreamChatInternalOptions {
  /** Configured base URL before any per-turn relay rewrite; part of the session fingerprint. */
  sessionBaseUrl: string
  /** Transfer the per-turn model runtime to a new persistent session. */
  adoptModelRuntime: () => () => Promise<void>
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function userTurnMessage(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }
}

/** Per-phase durations for one turn's preparation; logged without prompt text. */
function createPhaseTimer() {
  const start = Date.now()
  let last = start
  const phases: Record<string, number> = {}
  return {
    mark(name: string) {
      const now = Date.now()
      phases[name] = (phases[name] ?? 0) + (now - last)
      last = now
    },
    startedAt: start,
    phases,
  }
}

async function* streamChatWithBaseUrl(
  messages: Message[],
  settings: Settings,
  abortController?: AbortController,
  opts: {
    streaming?: boolean;
    enabledAdapterIds?: Set<string>;
    workId?: string;
    styleId?: string | null;
    channelPermissionMode?: ChannelPermissionMode;
    onAskUser?: (event: { type: string; id: string; question: string; options: Array<{ label: string; description?: string }> }) => void;
    channelAskUserHandler?: (question: string, options: Array<{ label: string; description?: string }>) => Promise<string>;
    /** Where send_image_to_user / send_file_to_user deliver for this turn; absent = cannot deliver. */
    userMedia?: UserMediaSink | null;
    systemPromptOverride?: string;
    mcpServerOverride?: ReturnType<typeof _buildMcpServer>;
    restrictBuiltInTools?: boolean;
    memoryScope?: MemoryScope;
    /** siteGate 预注入的站点工具清单（server.ts 计算；与 loadedSkills 同通道前缀进 prompt）。 */
    siteToolkitPrompt?: string;
    memoryEnabled?: boolean;
    memoryExpectedType?: import('./memory/memory-types.js').MemoryType;
    memoryTriggerHint?: import('./memory/memory-types.js').MemoryEventTrigger | 'chat';
    previousTaskFailed?: boolean;
    forceCompaction?: boolean;
    compactionOnly?: boolean;
    thinkingEffort?: ThinkingEffort;
    /**
     * Run against a dedicated CLAUDE_CONFIG_DIR whose skills/ directory the caller
     * has already populated. Project skills under the user directory and the global
     * managed-skill refresh are skipped so the run only sees the caller's skills.
     */
    isolatedClaudeConfigDir?: string;
    /** Extra system prompt text appended after the standard WeWorker prompt. */
    appendSystemPrompt?: string;
    /** Additional tool guard evaluated before the standard WeWorker policy. */
    extraToolGuard?: (toolName: string, input: Record<string, unknown>) => { behavior: 'allow' } | { behavior: 'deny'; message: string };
    /** Additional tools hidden from the model. */
    extraDisallowedTools?: string[];
    /**
     * Keep this work's Claude Code process alive between turns (desktop chat).
     * Later turns send only the new message; see chat-session.ts for reuse rules.
     */
    reuseSession?: boolean;
    /**
     * With reuseSession: prepare the turn and start the CLI without sending a
     * message. Without workId the session waits as the spare for the next new work.
     */
    warmupOnly?: boolean;
    [STREAM_CHAT_INTERNAL]?: StreamChatInternalOptions;
  } = {},
): AsyncGenerator<SSEEvent> {
  const phase = createPhaseTimer()
  // Claude Code discovers user Skills when each query starts. If a website was
  // just scaffolded, wait for its hot-install to finish before starting query.
  await waitForAdapterRuntimeReload()
  phase.mark('adapter_reload_wait')
  const enabledAdapterIds = opts.enabledAdapterIds
  const channelPermissionMode = opts.channelPermissionMode ?? 'full'
  const internal = opts[STREAM_CHAT_INTERNAL]
  // Session reuse is limited to the plain desktop path: channel handlers, custom
  // prompts/tools and compaction-only runs keep the one-off query behavior.
  const sessionMode = opts.reuseSession === true
    && (!!opts.workId || opts.warmupOnly === true)
    && !!internal
    && opts.streaming !== false
    && channelPermissionMode === 'full'
    && !opts.channelAskUserHandler
    && !opts.systemPromptOverride
    && !opts.mcpServerOverride
    && !opts.restrictBuiltInTools
    && !opts.forceCompaction
    && !opts.compactionOnly
  // Callbacks that a reused session must take from the current turn.
  const turnBindings: ChatTurnBindings = {
    workIdRef: { current: opts.workId ?? null },
    onAskUser: opts.onAskUser ?? null,
    userMedia: opts.userMedia ?? null,
    extraToolGuard: opts.extraToolGuard,
    memory: { userPromptInjections: 0, postToolBatchInjections: 0 },
  }

  const mcpServer = _buildMcpServer({
    channelPermissionMode,
    workId: opts.workId ?? null,
    askUserSSECallback: opts.onAskUser ?? null,
    channelAskUserHandler: opts.channelAskUserHandler ?? null,
    userMedia: () => turnBindings.userMedia ?? null,
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
    queryEnv = buildConfiguredModelEnv(settings, claudeSetup.extraEnv, opts.isolatedClaudeConfigDir)
  } catch (e) {
    yield { type: 'error', content: e instanceof Error ? e.message : 'LLM base URL is not allowed' }
    return
  }

  // includePartialMessages enables streaming text deltas but causes Claude to emit
  // text before tool calls complete. qa_only disables partial streaming and project
  // skills so visitors get plain text answers instead of silent tool attempts.
  // Runtime skills are stored under the isolated CLAUDE_CONFIG_DIR/skills,
  // which Claude Code treats as the user skill source.
  const isolatedSkills = !!opts.isolatedClaudeConfigDir
  const settingSources: SettingSource[] = channelPermissionMode === 'qa_only' || opts.restrictBuiltInTools
    ? []
    : isolatedSkills ? ['user'] : ['user', 'project']
  const includePartialMessages = channelPermissionMode === 'qa_only'
    ? false
    : opts.streaming !== false

  const textBlockBuf: { id: string; text: string; filter: StreamingVisibleText }[] = []
  const thinkingEffort = resolveThinkingEffort(settings.active_provider, settings.model, opts.thinkingEffort)
  const queryStartTime = Date.now()
  log.info(` calling Claude API 鈥?model=${settings.model}`)

  // Resolve webcli directory for PATH so Bash can find the `webcli` command
  const webcliDir = resolveWebcliDir()
  log.info(` webcliDir=${webcliDir}, exists=${fs.existsSync(webcliDir)}`)
  const pathPrefix = [webcliDir, path.dirname(process.execPath)].join(path.delimiter)
  const envWithWebcli = {
    ...queryEnv,
    CLAUDE_CODE_EXTRA_BODY: buildThinkingExtraBody(thinkingEffort, queryEnv.CLAUDE_CODE_EXTRA_BODY),
    PATH: `${pathPrefix}${path.delimiter}${queryEnv.PATH || process.env.PATH || ''}`,
    WEWORKER_ALLOWED_OPEN_BROWSER_ORIGINS: getOpenBrowserAllowedOrigins().join(','),
    WEWORKER_ADAPTERS_DIR: path.join(getUserDirectory(), '.claude', 'skills'),
    // Ensure Electron binary can act as Node.js runtime for packaged webcli
    ...(process.env.WEWORKER_PACKAGED ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  }

  const disallowedTools = [
    ...buildDisallowedTools(
      channelPermissionMode,
      process.platform,
      opts.restrictBuiltInTools,
    ),
    ...(opts.extraDisallowedTools ?? []),
  ]
  const agentCwd = ensureAgentWorkingDirectory()
  const filesystemSettings = buildAgentFilesystemSettings(agentCwd, channelPermissionMode)
  const filesystemToolGuard = createUnifiedToolGuard(channelPermissionMode)
  const toolPolicy = createWeWorkerToolPolicy(channelPermissionMode)
  const canUseTool: typeof toolPolicy = async (toolName, input, context) => {
    // Read the guard at call time: a reused session rebinds it for each turn.
    const extraToolGuard = turnBindings.extraToolGuard
    if (extraToolGuard) {
      const extraDecision = extraToolGuard(toolName, input as Record<string, unknown>)
      if (extraDecision.behavior === 'deny') {
        return { behavior: 'deny', message: extraDecision.message, interrupt: false }
      }
    }
    const policyDecision = await toolPolicy(toolName, input, context)
    if (!policyDecision) {
      return { behavior: 'deny', message: `Tool permission was not resolved: ${toolName}`, interrupt: false }
    }
    if (policyDecision.behavior === 'deny') return policyDecision
    return filesystemToolGuard(toolName, input as Record<string, unknown>)
  }

  const memoryEnabled = opts.memoryEnabled !== false && !opts.restrictBuiltInTools
  const skillRoots = channelPermissionMode === 'qa_only' || opts.restrictBuiltInTools
    ? []
    : isolatedSkills
      ? [path.join(queryEnv.CLAUDE_CONFIG_DIR!, 'skills')]
      : [
          path.join(queryEnv.CLAUDE_CONFIG_DIR!, 'skills'),
          path.join(getUserDirectory(), '.claude', 'skills'),
        ]
  // Isolated runs receive a caller-curated skills directory; a global refresh
  // would write every managed Adapter Skill into it.
  phase.mark('config_setup')
  let sharedWebcliSkillDigest = ''
  if (skillRoots.length && !isolatedSkills) {
    if (channelPermissionMode === 'full') {
      try {
        sharedWebcliSkillDigest = syncBundledWebcliSkills(skillRoots[0])
      } catch (error) {
        yield { type: 'error', content: error instanceof Error ? error.message : 'WebCLI Skill 同步失败，请重新构建或更新客户端。' }
        return
      }
    }
    refreshDesktopAdapterSkillsIfStale(skillRoots[0])
  }
  phase.mark('managed_skill_sync')
  const loadedSkills = buildLoadedSkillContext(messages, skillRoots)
  const skillContextCollector = createSkillContextCollector(skillRoots)
  log.info('skill_context_replay', { present: !!loadedSkills, chars: loadedSkills.length })
  phase.mark('loaded_skill_replay')
  // siteGate 预注入与 loadedSkills 走同一通道（同为 prompt 前缀）：命中站点时把该站点的工具速查
  // 放在最前，模型首轮即可直接调用，不必先「激活 Skill」。未命中时为空串，逐字节等价于今天。
  const siteToolkitPrompt = String(opts.siteToolkitPrompt ?? '').trim()
  const skillContextPrefix = [siteToolkitPrompt, loadedSkills].filter(Boolean).join('\n\n')
  const storedCompactedConversation = getStoredCompactedConversation(opts.workId, messages)
  const conversationMessages: Message[] = storedCompactedConversation
    ? [{
        ...messages[0],
        role: 'assistant',
        content: [{ type: 'text', text: storedCompactedConversation.prompt }],
      }, ...messages.slice(storedCompactedConversation.sourceMessageCount)]
    : messages
  const promptRaw = storedCompactedConversation && conversationMessages.length === 1
    ? storedCompactedConversation.prompt
    : buildPromptString(conversationMessages)
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
  phase.mark('memory_recall')
  const memoryProtocol = memoryEnabled
    ? buildMemoryOutputProtocolPrompt({
      scope: opts.memoryScope ?? { user: 'local' },
      triggerHint: opts.memoryTriggerHint ?? 'chat',
      expectedMemoryType: opts.memoryExpectedType,
      previousTaskFailed: opts.previousTaskFailed,
    })
    : ''
  const baseSystemPrompt = opts.systemPromptOverride ?? buildSystemPrompt({
    channelPermissionMode,
    styleId: opts.styleId,
    customStyles: settings.zcf_custom_roles,
    memoryProtocol,
    browserInstance: bridgeStatus.getExtensionInstance(),
  })
  const systemPrompt = opts.appendSystemPrompt?.trim()
    ? `${baseSystemPrompt}\n\n${opts.appendSystemPrompt.trim()}`
    : baseSystemPrompt
  phase.mark('system_prompt_build')
  const nativeCommandTool = process.platform === 'win32' ? 'PowerShell' : 'Bash'
  const skillIndex = channelPermissionMode === 'qa_only' || opts.restrictBuiltInTools
    ? ''
    : buildEnabledSkillIndex(path.join(queryEnv.CLAUDE_CONFIG_DIR || '', 'skills'))
  const buildAssembly = (conversationPrompt: string, compaction?: ConversationCompactionSnapshot) => buildContextAssembly({
    systemPrompt,
    identityPrompt,
    prompt: conversationPrompt,
    toolDefinitions: [
      `Claude Code 原生 ${nativeCommandTool}`,
      'Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit', 'Skill', 'TodoWrite',
    ].join('\n'),
    skillIndex,
    loadedSkills: skillContextPrefix,
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
  const needsCompaction = (compactionPlan.shouldCompact || !!opts.forceCompaction) && conversationMessages.length > 1
  phase.mark('context_assembly')

  if (needsCompaction) {
    const historyMessages = conversationMessages.slice(0, -1)
    const currentMessage = conversationMessages[conversationMessages.length - 1]
    const currentTokens = estimateContextTokens(messagePromptText(currentMessage))
    const targetTokens = opts.forceCompaction
      ? Math.min(compactionPlan.targetTokens, Math.floor(conversationTokens * CONVERSATION_COMPACTION_TARGET_RATIO))
      : compactionPlan.targetTokens
    const recentSelection = takeRecentWithinTokenBudget(
      historyMessages,
      Math.max(1, targetTokens - currentTokens),
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
          if (compaction.after_tokens >= conversationTokens) {
            throw new Error('摘要未缩减对话上下文，请重试压缩或新建对话')
          }
          contextAssembly = buildAssembly(compactedPrompt, compaction)
          compactionCompleted = true
          if (opts.workId) {
            compactedConversationByWork.set(opts.workId, {
              sourceMessageCount: messages.length,
              sourceHash: conversationHash(messages),
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
          mcpServer: activeMcpServer,
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
  phase.mark('compaction')
  const turnContextCollector = createTurnContextCollector(contextAssembly.snapshot)
  const memoryUserPromptSubmitHook: HookCallback = async (): Promise<HookJSONOutput> => {
    activeBindings.memory.userPromptInjections += 1
    log.info('memory_reminder_injected', {
      source: 'user_prompt_submit',
      sequence: activeBindings.memory.userPromptInjections,
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
    activeBindings.memory.postToolBatchInjections += 1
    log.info('memory_reminder_injected', {
      source: 'post_tool_batch',
      sequence: activeBindings.memory.postToolBatchInjections,
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
  // Session callbacks resolve against the bindings of whichever turn is running.
  let activeBindings: ChatTurnBindings = turnBindings
  const buildQueryParams = (
    prompt: string | PromptQueue,
    target: { systemPrompt: string; abort?: AbortController; mcp?: McpServerConfig },
  ) => ({
    prompt,
    options: {
      abortController: target.abort ?? abortController,
      model: settings.model,
      systemPrompt: target.systemPrompt,
      mcpServers: { weworker: target.mcp ?? activeMcpServer },
      disallowedTools,
      canUseTool,
      settings: filesystemSettings,
      // bypassPermissions skips canUseTool; blacklist enforcement relies on canUseTool + tool handlers.
      permissionMode: 'default' as const,
      includePartialMessages,
      extraArgs: { 'replay-user-messages': null },
      cwd: agentCwd,
      settingSources,
      ...(thinkingEffort === 'off' ? { thinking: { type: 'disabled' as const } } : { effort: thinkingEffort }),
      pathToClaudeCodeExecutable: claudeSetup.pathToClaudeCodeExecutable,
      spawnClaudeCodeProcess,
      env: envWithWebcli,
      hooks: memoryEnabled ? {
        UserPromptSubmit: [{ hooks: [memoryUserPromptSubmitHook] }],
        PostToolBatch: [{ hooks: [memoryPostToolBatchHook] }],
      } : undefined,
    },
  })

  // Session mode: reuse this work's live CLI when its configuration and history match.
  const history: ChatHistoryEntry[] = messages.map((message) => ({
    id: message.id, role: message.role, digest: sha256(JSON.stringify(message.content)),
  }))
  const recalledMemoryBlock = longTermMemory.recalled ? `${RECALLED_MEMORY_HEADER}\n${longTermMemory.recalled}\n\n` : ''
  // A new (or still unused warm) session has seen no history: send replay + current message.
  const fullFirstPrompt = recalledMemoryBlock ? `${recalledMemoryBlock}${contextAssembly.sdk.prompt}` : contextAssembly.sdk.prompt
  let session: ChatSession | undefined
  let sessionState: 'cold' | 'new' | 'reused' | 'prewarmed' = 'cold'
  let turnMessages: AsyncIterable<SDKMessage>
  let closeTurn: () => void
  if (sessionMode && internal && (!opts.workId || !isChatSessionBusy(opts.workId))) {
    const workId = opts.workId ?? null
    const fingerprint = sha256(JSON.stringify({
      model: settings.model,
      protocol: settings.active_weworker_protocol || 'anthropic_messages',
      baseUrl: internal.sessionBaseUrl,
      apiKey: sha256(settings.api_key || ''),
      provider: settings.active_provider,
      authType: settings.active_auth_type ?? settings.custom_auth_type ?? null,
      systemPrompt,
      skillIndex,
      sharedWebcliSkillDigest,
      skillFiles: fingerprintSkillFiles(skillRoots),
      filesystemSettings,
      projectSkillIndex: isolatedSkills ? '' : buildEnabledSkillIndex(path.join(getUserDirectory(), '.claude', 'skills')),
      adapters: getDesktopAdapterCatalog().effective.map((entry) => `${entry.name}@${entry.digest}`),
      disallowedTools,
      settingSources,
      effort: thinkingEffort ?? null,
      includePartialMessages,
      memoryEnabled,
      cwd: agentCwd,
      configDir: queryEnv.CLAUDE_CONFIG_DIR,
      executable: claudeSetup.pathToClaudeCodeExecutable ?? null,
      openBrowserOrigins: envWithWebcli.WEWORKER_ALLOWED_OPEN_BROWSER_ORIGINS,
      path: envWithWebcli.PATH,
    }))
    const startSession = (): ChatSession => {
      const sessionAbort = new AbortController()
      const queue = new PromptQueue()
      const bindings = turnBindings
      const sessionMcp = _buildMcpServer({
        channelPermissionMode,
        workIdRef: bindings.workIdRef,
        askUserSSECallback: (event) => bindings.onAskUser?.(event),
        channelAskUserHandler: null,
        userMedia: () => bindings.userMedia ?? null,
      })
      const releaseRuntime = internal.adoptModelRuntime()
      return new ChatSession({
        workId,
        fingerprint,
        bindings,
        queue,
        // The long-lived system prompt excludes per-turn memory; each turn's message carries it.
        query: query(buildQueryParams(queue, { systemPrompt, abort: sessionAbort, mcp: sessionMcp }) as Parameters<typeof query>[0]),
        onClose: async () => {
          sessionAbort.abort()
          await releaseRuntime()
        },
      })
    }

    if (opts.warmupOnly) {
      // Start the CLI now so the user's first message skips its startup.
      const exists = workId ? hasChatSession(workId) : hasSpareChatSession()
      if (!exists) {
        const warm = startSession()
        if (workId) registerChatSession(warm)
        else registerSpareChatSession(warm)
        log.info('chat_session_prewarmed', {
          work_id: workId ? sha256(workId).slice(0, 12) : null,
          spare: !workId,
          prepare_ms: Date.now() - phase.startedAt,
        })
      }
      yield { type: 'done' }
      return
    }

    const turnWorkId = workId!
    const reusable = needsCompaction ? undefined : findReusableChatSession(turnWorkId, fingerprint, history)
    if (!reusable && needsCompaction) disposeChatSession(turnWorkId, 'compaction')
    let firstPrompt: string
    if (reusable) {
      session = reusable
      const prewarmed = reusable.fresh
      sessionState = prewarmed ? 'prewarmed' : 'reused'
      reusable.bindings.workIdRef.current = turnWorkId
      reusable.bindings.onAskUser = turnBindings.onAskUser
      reusable.bindings.userMedia = turnBindings.userMedia
      reusable.bindings.extraToolGuard = turnBindings.extraToolGuard
      reusable.bindings.memory = turnBindings.memory
      activeBindings = reusable.bindings
      // A live CLI already holds the conversation and loaded Skills: send only the new message.
      firstPrompt = prewarmed
        ? fullFirstPrompt
        : `${siteToolkitPrompt ? `${siteToolkitPrompt}\n\n` : ''}${recalledMemoryBlock}${messagePromptText(messages[messages.length - 1])}`
    } else {
      const created = startSession()
      registerChatSession(created)
      session = created
      sessionState = 'new'
      firstPrompt = fullFirstPrompt
    }
    const activeSession = session
    turnMessages = activeSession.runTurn(userTurnMessage(firstPrompt))
    closeTurn = () => disposeChatSession(turnWorkId, 'aborted', activeSession)
  } else {
    if (opts.warmupOnly) {
      yield { type: 'done' }
      return
    }
    const queryHandle = query(buildQueryParams(contextAssembly.sdk.prompt, {
      systemPrompt: contextAssembly.sdk.system_prompt,
    }) as Parameters<typeof query>[0])
    turnMessages = queryHandle
    closeTurn = () => queryHandle.close()
  }
  const sdkStartTime = Date.now()
  // A live session keeps one CLI (and therefore one cost ledger) across turns,
  // so its tracker must survive across turns; a one-off query starts a fresh
  // ledger on every turn and needs a fresh tracker.
  const apiDurationTracker: ApiDurationTracker = session?.apiDuration ?? createApiDurationTracker()

  // When the abort signal fires, forcefully close the query to kill the
  // underlying Claude CLI subprocess. Without this, the child process
  // keeps running (and operating on websites) even after the HTTP
  // connection is closed.
  let queryRunning = true
  const onAbort = () => {
    log.info(` onAbort called - queryRunning=${queryRunning}`)
    if (!queryRunning) return // query already finished, nothing to kill
    log.info(' abort signal received, closing query handle')
    closeTurn()
  }
  if (abortController) {
    if (abortController.signal.aborted) {
      log.info(' abortController already aborted before query started')
      closeTurn()
      return
    }
    abortController.signal.addEventListener('abort', onAbort, { once: true })
  }

  let completed = false
  let turnFailed = false
  const contextUsageTracker = createContextUsageTracker()
  try {
    log.info(' starting for-await over queryHandle')
    let firstEventReceived = false
    let assistantResponseCount = 0
    let memoryParseCount = 0
    let sdkUserEventCount = 0
    let sdkUserReminderObservedCount = 0
    for await (const msg of turnMessages) {
      if (!firstEventReceived) {
        firstEventReceived = true
        log.info(` first event received - elapsed=${((Date.now() - queryStartTime) / 1000).toFixed(2)}s`)
        log.info('chat_turn_timing', {
          work_id: opts.workId ? sha256(opts.workId).slice(0, 12) : null,
          dedicated_agent: isolatedSkills,
          session: sessionState,
          phase_ms: { ...phase.phases, sdk_start_to_first_event: Date.now() - sdkStartTime },
          prepare_ms: sdkStartTime - phase.startedAt,
          context_tokens: Object.fromEntries(contextAssembly.snapshot.categories.map((item) => [item.id, item.estimated_tokens])),
        })
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
      const latestModelInputTokens = contextUsageTracker.observe(msg)
      for (const skillContext of skillContextCollector.observe(msg)) {
        turnContextCollector.observe({ type: 'skill_context', id: skillContext.tool_use_id, content: skillContext.text })
        log.info('skill_context_captured', { chars: skillContext.text.length })
        yield { type: 'skill_context', skillContext }
      }
      for (const event of mapSdkMessage(msg, includePartialMessages, textBlockBuf, apiDurationTracker)) {
        if (event.type === 'usage' && event.usage && latestModelInputTokens !== undefined) {
          event.usage = { ...event.usage, context_input_tokens: latestModelInputTokens }
        }
        if (event.type === 'memory_parse') memoryParseCount += 1
        if (event.type === 'error') turnFailed = true
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
    log.info(` for-await loop completed normally - total=${((Date.now() - queryStartTime) / 1000).toFixed(2)}s`)
    log.info('memory_context_check', {
      user_prompt_injections: activeBindings.memory.userPromptInjections,
      post_tool_batch_injections: activeBindings.memory.postToolBatchInjections,
      assistant_responses: assistantResponseCount,
      memory_parse_events: memoryParseCount,
      sdk_user_events: sdkUserEventCount,
      sdk_user_reminders_observed: sdkUserReminderObservedCount,
    })
  } catch (e) {
    turnFailed = true
    // Silently ignore abort errors (user cancelled)
    if (e instanceof Error && (e.name === 'AbortError' || e.message.includes('aborted'))) {
      log.info(` caught abort error: ${e.message}`)
      return
    }
    log.info(` caught error: ${e instanceof Error ? e.message : String(e)}`)
    yield { type: 'error', content: e instanceof Error ? e.message : String(e) }
  } finally {
    log.info(' finally block - setting queryRunning=false')
    queryRunning = false
    if (abortController) {
      abortController.signal.removeEventListener('abort', onAbort)
    }
    if (session && opts.workId) {
      // Keep the CLI only after a clean turn; anything else may leave it mid-turn.
      if (completed && !turnFailed && !abortController?.signal.aborted && !session.closed) {
        session.complete(history)
      } else {
        disposeChatSession(opts.workId, abortController?.signal.aborted ? 'aborted' : 'turn_unfinished', session)
      }
    }
  }
}
