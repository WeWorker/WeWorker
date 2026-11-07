/**
 * Tool guards for dedicated agents (WeWorker Bot).
 *
 * A workspace agent behaves like Claude running in a folder, optionally with
 * WeWorker website capabilities: native file and shell tools are unrestricted,
 * but every `webcli` invocation must target one of the agent's own sites.
 * Quoted argument text is passed to webcli verbatim (e.g. free-form text an
 * Adapter tool accepts), so shell operators are only rejected when they appear
 * outside quotes in a single invocation.
 */

export type ShellWordsResult =
  | { ok: true; words: string[] }
  | { ok: false; reason: string }

const UNQUOTED_FORBIDDEN = new Set([';', '|', '&', '<', '>', '(', ')', '$', '`', '{', '}', '\\', '\n', '\r', '#'])

/**
 * Split a command into words, honoring single and double quotes.
 * Works the same for bash and PowerShell for the accepted subset:
 * - single quotes are literal
 * - double quotes may not contain `$`, backtick or backslash (expansion/escape
 *   rules differ between shells)
 * - outside quotes, operators, expansions, escapes and newlines are rejected,
 *   except a backslash-newline line continuation.
 */
export function splitShellWords(command: string): ShellWordsResult {
  const words: string[] = []
  let current = ''
  let inWord = false
  let quote: "'" | '"' | null = null

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (quote === "'") {
      if (char === "'") quote = null
      else current += char
      continue
    }
    if (quote === '"') {
      if (char === '"') quote = null
      else if (char === '$' || char === '`' || char === '\\') return { ok: false, reason: '双引号内不能包含 $、反引号或反斜杠，请改用单引号' }
      else current += char
      continue
    }
    if (char === '\\') {
      const next = command[index + 1]
      if (next === '\n') { index += 1; endWord(); continue }
      if (next === '\r' && command[index + 2] === '\n') { index += 2; endWord(); continue }
    }
    if (char === ' ' || char === '\t') {
      endWord()
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      inWord = true
      continue
    }
    if (UNQUOTED_FORBIDDEN.has(char)) {
      return { ok: false, reason: `不能在引号外使用 ${JSON.stringify(char)}（不支持管道、重定向、变量或多条命令）` }
    }
    current += char
    inWord = true
  }
  if (quote) return { ok: false, reason: '引号未闭合' }
  endWord()
  if (words.length === 0) return { ok: false, reason: '命令为空' }
  return { ok: true, words }

  function endWord() {
    if (inWord || current) words.push(current)
    current = ''
    inWord = false
  }
}

const WEBCLI_EXECUTABLES = new Set(['webcli', 'webcli.cmd', 'webcli.ps1'])
const READ_ONLY_WEBCLI_COMMANDS = new Set(['help', '--help', '-h', 'list', '--version'])

export type WebcliCheck = { ok: true } | { ok: false; reason: string }

/**
 * Decide whether a native shell command is an allowed webcli call.
 * `knownSiteIds` lists every installed Adapter id, so a tool of a longer id
 * sharing the prefix (example.com vs example.com.cn) is not mistaken as ours.
 */
export function checkFocusedWebcliCommand(command: unknown, allowedSiteIds: string[], knownSiteIds: string[] = []): WebcliCheck {
  if (typeof command !== 'string' || !command.trim()) return { ok: false, reason: '命令为空' }
  const split = splitShellWords(command.trim())
  if (!split.ok) return split
  const [executable, subcommand, target] = split.words
  if (!WEBCLI_EXECUTABLES.has(executable.toLowerCase())) {
    return { ok: false, reason: '只能执行 webcli 命令' }
  }
  if (!subcommand) return { ok: true }
  const sub = subcommand.toLowerCase()
  if (READ_ONLY_WEBCLI_COMMANDS.has(sub)) return { ok: true }
  const sites = allowedSiteIds.map((id) => id.toLowerCase())
  if (sub === 'call') {
    const tool = String(target ?? '').toLowerCase()
    if (!tool) return { ok: false, reason: 'webcli call 缺少工具名' }
    if (tool === 'open_browser') {
      const adapterFlags = split.words.slice(3).filter((word) => word.toLowerCase().startsWith('--adapter='))
      if (adapterFlags.length !== 1) return { ok: false, reason: 'open_browser 必须且只能指定一个 --adapter=<本 Agent 网站>' }
      const adapter = adapterFlags[0].slice(adapterFlags[0].indexOf('=') + 1).toLowerCase()
      return sites.includes(adapter)
        ? { ok: true }
        : { ok: false, reason: `open_browser 的 Adapter ${adapter || '(空)'} 不属于本 Agent 负责的网站` }
    }
    const owner = [...new Set([...sites, ...knownSiteIds.map((id) => id.toLowerCase())])]
      .filter((site) => tool.startsWith(`${site}.`))
      .sort((a, b) => b.length - a.length)[0]
    if (owner && sites.includes(owner)) return { ok: true }
    return { ok: false, reason: `工具 ${target} 不属于本 Agent 负责的网站` }
  }
  // WeCLI style: `webcli <site> <command...>` or `webcli <site> help`
  if (sites.includes(sub)) return { ok: true }
  return { ok: false, reason: `不支持的 webcli 子命令：${subcommand}` }
}

/** MCP tools a workspace agent may use; everything else from the WeWorker MCP server is hidden. */
const ALLOWED_MCP_TOOLS = new Set([
  'mcp__weworker__ask_user',
  'mcp__weworker__webcli_result',
  'mcp__weworker__send_file_to_user',
  'mcp__weworker__send_image_to_user',
])

/** MCP tools hidden from a workspace agent's tool list (native file/shell tools stay available). */
export const WORKSPACE_AGENT_DISALLOWED_TOOLS = [
  'mcp__weworker__weworker_powershell',
  'mcp__weworker__create_scheduled_task',
  'mcp__weworker__list_scheduled_tasks',
  'mcp__weworker__list_files',
  'mcp__weworker__check_file_encryption',
  'mcp__weworker__decrypt_file',
  'mcp__weworker__list_explorable_tabs',
  'mcp__weworker__start_api_exploration',
  'mcp__weworker__list_api_explorations',
  'mcp__weworker__start_adapter_generation',
  'mcp__weworker__get_adapter_generation',
  'mcp__weworker__resume_adapter_generation',
  'mcp__weworker__publish_adapter_generation',
]

export type FocusedGuardDecision = { behavior: 'allow' } | { behavior: 'deny'; message: string }

const WEBCLI_TOKEN = /\bwebcli(?:\.cmd|\.ps1)?\b/i
const SEGMENT_SEPARATORS = new Set([';', '\r', '\n', '|', '&', '`', '(', ')', '<', '>'])
const ENV_PREFIX = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*)\s+/

/**
 * Split a command into segments on shell separators that appear outside
 * quotes, so compound commands (`&&`, `;`, pipelines, `$(...)`) are checked
 * invocation by invocation while quoted text stays intact.
 */
function splitCommandSegments(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: "'" | '"' | null = null
  for (const char of command) {
    if (quote) {
      current += char
      if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      current += char
      continue
    }
    if (SEGMENT_SEPARATORS.has(char)) {
      segments.push(current)
      current = ''
      continue
    }
    current += char
  }
  segments.push(current)
  return segments
}

/**
 * Scope-check every `webcli` invocation inside an arbitrary (possibly compound)
 * shell command. Anything else in the command is not restricted here. A webcli
 * mention that cannot be parsed as a plain invocation is denied so the model
 * falls back to running webcli as a standalone command.
 */
export function checkWebcliScopeInCommand(command: unknown, allowedSiteIds: string[], knownSiteIds: string[] = []): WebcliCheck {
  const text = typeof command === 'string' ? command : ''
  if (!text.trim()) return { ok: true }
  if (!WEBCLI_TOKEN.test(text)) return { ok: true }
  for (const segment of splitCommandSegments(text)) {
    if (!WEBCLI_TOKEN.test(segment)) continue
    let trimmed = segment.trim()
    for (;;) {
      const next = trimmed.replace(ENV_PREFIX, '')
      if (next === trimmed) break
      trimmed = next
    }
    const firstWord = trimmed.split(/\s+/)[0] ?? ''
    if (!WEBCLI_TOKEN.test(firstWord)) {
      return {
        ok: false,
        reason: '无法解析的 webcli 调用：请把 webcli 作为独立的一条命令执行，不要嵌进变量、子 shell 或其他命令里',
      }
    }
    const check = checkFocusedWebcliCommand(trimmed, allowedSiteIds, knownSiteIds)
    if (!check.ok) return check
  }
  return { ok: true }
}

/**
 * Tool guard for a workspace dedicated agent: a full Claude-style agent that
 * may also operate the websites it was given. Native file and shell tools are
 * unrestricted; only webcli invocations are scoped to the agent's sites and
 * WeWorker MCP tools stay behind an allowlist.
 */
export function createWorkspaceToolGuard(allowedSiteIds: string[], knownSiteIds: string[] = [], allowedMcpTools: string[] = []) {
  const permittedMcpTools = new Set([...ALLOWED_MCP_TOOLS, ...allowedMcpTools])
  return (toolName: string, input: Record<string, unknown>): FocusedGuardDecision => {
    if (toolName === 'Bash' || toolName === 'PowerShell') {
      const check = checkWebcliScopeInCommand(input?.command, allowedSiteIds, knownSiteIds)
      if (check.ok) return { behavior: 'allow' }
      return {
        behavior: 'deny',
        message: `webcli 只能操作这个WeWorker Bot 负责的网站：${check.reason}`,
      }
    }
    if (toolName.startsWith('mcp__') && !permittedMcpTools.has(toolName)) {
      return { behavior: 'deny', message: `WeWorker Bot 不能使用 ${toolName}。` }
    }
    return { behavior: 'allow' }
  }
}
