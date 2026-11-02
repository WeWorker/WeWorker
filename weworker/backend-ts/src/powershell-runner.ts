import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { redactSensitive } from './http-security.js'
import { broadcastSSE } from './notifier.js'
import { assertShellCommand } from './user-directory-access.js'
import { assertPathInsideUserDirectory, resolveUserDirectoryRoot } from './user-directory-guard.js'
import { resolveWebcliDir } from './webcli-path.js'

export type TerminalSource = 'ai' | 'user'
export type TerminalStream = 'stdout' | 'stderr'
export type TerminalShell = 'bash' | 'powershell'

export interface PowerShellRunOptions {
  command: string
  cwd?: string
  source?: TerminalSource
  shell?: TerminalShell
  outputEncoding?: string
  workId?: string | null
  signal?: AbortSignal | null
}

export interface PowerShellRunResult {
  sessionId: string
  command: string
  cwd: string
  shell: TerminalShell
  outputEncoding: string
  exitCode: number | null
  signal: string | null
  output: string
  stdout: string
  stderr: string
}

const MAX_CAPTURE_CHARS = 200_000
type TerminalEventPayload = Record<string, unknown>
type TerminalEventListener = (event: TerminalEventPayload) => void
const terminalEventListeners = new Set<TerminalEventListener>()
type ActiveTerminalSession = {
  pid?: number
  source: TerminalSource
  shell: TerminalShell
  workId: string | null
  command: string
  cwd: string
}
const activeTerminalSessions = new Map<string, ActiveTerminalSession>()
type TerminalContext = {
  env: Record<string, string>
}
const terminalContexts = new Map<string, TerminalContext>()

function makeSessionId(): string {
  return `ps-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function resolveCwd(cwd?: string): string {
  const resolved = cwd?.trim()
    ? assertPathInsideUserDirectory(cwd, 'cwd')
    : resolveUserDirectoryRoot()
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`cwd must be an existing directory: ${resolved}`)
  }
  return resolved
}

function terminalContextKey(source: TerminalSource, shell: TerminalShell, workId: string | null): string {
  return `${source}:${shell}:${workId || 'global'}`
}

function getTerminalContext(source: TerminalSource, shell: TerminalShell, workId: string | null): TerminalContext {
  const key = terminalContextKey(source, shell, workId)
  let context = terminalContexts.get(key)
  if (!context) {
    context = { env: {} }
    terminalContexts.set(key, context)
  }
  return context
}

function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseBashExportAssignments(command: string): Record<string, string> | null {
  const match = command.trim().match(/^export\s+(.+)$/)
  if (!match) return null
  const assignments: Record<string, string> = {}
  const parts = match[1].match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq <= 0) return null
    const name = part.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null
    assignments[name] = stripMatchingQuotes(part.slice(eq + 1))
  }
  return Object.keys(assignments).length ? assignments : null
}

function parseBashUnsetNames(command: string): string[] | null {
  const match = command.trim().match(/^unset\s+(.+)$/)
  if (!match) return null
  const names = match[1].split(/\s+/).filter(Boolean)
  if (!names.length || names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) return null
  return names
}

function applyTerminalContextMutation(
  context: TerminalContext,
  shell: TerminalShell,
  command: string,
  exitCode: number | null,
): void {
  if (exitCode !== 0 || shell !== 'bash') return
  const exports = parseBashExportAssignments(command)
  if (exports) {
    Object.assign(context.env, exports)
    return
  }
  const unsetNames = parseBashUnsetNames(command)
  if (unsetNames) {
    for (const name of unsetNames) delete context.env[name]
  }
}

export function getDefaultTerminalShell(platform: NodeJS.Platform = process.platform): TerminalShell {
  return platform === 'win32' ? 'powershell' : 'bash'
}

function normalizeShell(shell?: string, platform: NodeJS.Platform = process.platform): TerminalShell {
  if (platform === 'win32') return 'powershell'
  return shell === 'powershell' ? 'powershell' : 'bash'
}

function shellCommand(shell: TerminalShell): string {
  if (shell === 'bash') {
    if (process.platform === 'win32') throw new Error('Windows 仅使用系统 PowerShell，不提供 Bash Runtime。')
    return 'bash'
  }
  return process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
}

function shellArgs(shell: TerminalShell, command: string): string[] {
  if (shell === 'bash') return ['-lc', command]
  const utf8Command = process.platform === 'win32'
    ? `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); ${command}`
    : command
  return process.platform === 'win32'
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', utf8Command]
    : ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', utf8Command]
}

function terminateProcessTree(pid?: number): void {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      killer.on('error', () => {})
      return
    }
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      process.kill(pid, 'SIGTERM')
    }
  } catch {
    // Best-effort cleanup; close/error handlers keep the terminal state consistent.
  }
}

function pathEnvKey(env: NodeJS.ProcessEnv): 'PATH' | 'Path' {
  if (process.platform !== 'win32') return 'PATH'
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') as 'PATH' | 'Path' || 'Path'
}

export function buildTerminalEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    PYTHONIOENCODING: 'utf-8',
  }
  const key = pathEnvKey(env)
  const webcliDir = resolveWebcliDir()
  const electronDir = path.dirname(process.env.WEWORKER_EXEC_PATH || process.execPath)
  const pathParts = [webcliDir, electronDir, env[key] || env.PATH || env.Path || ''].filter(Boolean)
  env[key] = pathParts.join(path.delimiter)
  if (key !== 'PATH') env.PATH = env[key]
  if (key !== 'Path' && process.platform === 'win32') env.Path = env[key]
  return env
}

function buildTerminalEnvForContext(context: TerminalContext): NodeJS.ProcessEnv {
  return {
    ...buildTerminalEnv(),
    ...context.env,
  }
}

function trimCapture(text: string): string {
  if (text.length <= MAX_CAPTURE_CHARS) return text
  return text.slice(text.length - MAX_CAPTURE_CHARS)
}

export function normalizeTerminalOutputEncoding(encoding?: string): string {
  const raw = String(encoding || 'utf-8').trim().toLowerCase()
  const normalized = raw === '' || raw === 'utf8' ? 'utf-8' : raw
  try {
    new TextDecoder(normalized)
    return normalized
  } catch {
    throw new Error(`Unsupported terminal output encoding: ${encoding}`)
  }
}

export function isWindowsNativeCommand(command: string): boolean {
  const text = String(command || '').trim()
  if (!text) return false
  return /(?:^|[;&|]{1,2}\s*)(?:cmd(?:\.exe)?\s+\/[ck]\s+)?(?:xcopy|copy|dir|del|erase|move|ren|rename|mklink|robocopy|attrib|icacls)\b/i.test(text)
}

export function inferTerminalShell(
  _command: string,
  shell?: string,
  platform: NodeJS.Platform = process.platform,
): TerminalShell {
  return normalizeShell(shell, platform)
}

export function inferTerminalOutputEncoding(command: string, shell: TerminalShell, encoding?: string): string {
  if (encoding && String(encoding).trim()) return normalizeTerminalOutputEncoding(encoding)
  if (process.platform === 'win32' && isWindowsNativeCommand(command)) {
    return normalizeTerminalOutputEncoding('gbk')
  }
  return normalizeTerminalOutputEncoding()
}

export function createTerminalOutputDecoder(encoding?: string): {
  encoding: string
  decode: (chunk: Buffer | string) => string
  flush: () => string
} {
  const normalized = normalizeTerminalOutputEncoding(encoding)
  const decoder = new TextDecoder(normalized)
  return {
    encoding: normalized,
    decode: (chunk: Buffer | string) => {
      if (typeof chunk === 'string') return chunk
      return decoder.decode(chunk, { stream: true })
    },
    flush: () => decoder.decode(),
  }
}

export function decodeTerminalOutputChunk(chunk: Buffer | string, encoding?: string): string {
  if (typeof chunk === 'string') return chunk
  const decoder = createTerminalOutputDecoder(encoding)
  return decoder.decode(chunk) + decoder.flush()
}

export function onTerminalEvent(listener: TerminalEventListener): () => void {
  terminalEventListeners.add(listener)
  return () => terminalEventListeners.delete(listener)
}

function emitTerminalEvent(event: TerminalEventPayload): void {
  broadcastSSE({ type: 'terminal_event', data: event })
  for (const listener of terminalEventListeners) {
    try {
      listener(event)
    } catch {
      // Listener errors must not break command execution.
    }
  }
}

export const emitTerminalEventForTest = emitTerminalEvent

export function stopTerminalSession(sessionId?: string): boolean {
  const ids = Array.from(activeTerminalSessions.keys())
  const id = sessionId || ids[ids.length - 1]
  if (!id) return false
  const session = activeTerminalSessions.get(id)
  if (!session) return false
  emitTerminalEvent({
    event: 'error',
    sessionId: id,
    source: session.source,
    shell: session.shell,
    workId: session.workId,
    command: session.command,
    cwd: session.cwd,
    error: 'Shell command stopped',
    endedAt: new Date().toISOString(),
  })
  terminateProcessTree(session.pid)
  activeTerminalSessions.delete(id)
  return true
}

export async function runWeWorkerPowerShell(options: PowerShellRunOptions): Promise<PowerShellRunResult> {
  const command = String(options.command || '').trim()
  assertShellCommand(command)
  const cwd = resolveCwd(options.cwd)
  const source = options.source || 'ai'
  const shell = inferTerminalShell(command, options.shell)
  const outputEncoding = inferTerminalOutputEncoding(command, shell, options.outputEncoding)
  const context = getTerminalContext(source, shell, options.workId || null)
  const sessionId = makeSessionId()
  const startedAt = new Date().toISOString()

  emitTerminalEvent({
    event: 'start',
    sessionId,
    source,
    shell,
    outputEncoding,
    workId: options.workId || null,
    command,
    cwd,
    startedAt,
  })

  return await new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error('Shell command aborted'))
      return
    }

    const child = spawn(shellCommand(shell), shellArgs(shell, command), {
      cwd,
      env: buildTerminalEnvForContext(context),
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    activeTerminalSessions.set(sessionId, {
      pid: child.pid,
      source,
      shell,
      workId: options.workId || null,
      command,
      cwd,
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    let aborted = false
    const stdoutDecoder = createTerminalOutputDecoder(outputEncoding)
    const stderrDecoder = createTerminalOutputDecoder(outputEncoding)

    const cleanupAbortHandler = () => {
      options.signal?.removeEventListener('abort', abortHandler)
      activeTerminalSessions.delete(sessionId)
    }

    const abortHandler = () => {
      if (settled) return
      aborted = true
      emitTerminalEvent({
        event: 'error',
        sessionId,
        source,
        shell,
        workId: options.workId || null,
        command,
        cwd,
        error: 'Shell command stopped',
        endedAt: new Date().toISOString(),
      })
      terminateProcessTree(child.pid)
      child.kill()
    }

    options.signal?.addEventListener('abort', abortHandler, { once: true })

    const appendText = (stream: TerminalStream, rawText: string) => {
      if (!rawText) return
      const text = redactSensitive(rawText)
      if (stream === 'stdout') stdout = trimCapture(stdout + text)
      else stderr = trimCapture(stderr + text)
      emitTerminalEvent({
        event: 'output',
        sessionId,
        source,
        shell,
        workId: options.workId || null,
        command,
        cwd,
        stream,
        chunk: text,
        at: new Date().toISOString(),
      })
    }

    const appendOutput = (stream: TerminalStream, chunk: Buffer | string) => {
      const decoder = stream === 'stdout' ? stdoutDecoder : stderrDecoder
      appendText(stream, decoder.decode(chunk))
    }

    child.stdout?.on('data', (chunk) => appendOutput('stdout', chunk))
    child.stderr?.on('data', (chunk) => appendOutput('stderr', chunk))

    child.on('error', (error) => {
      if (settled) return
      settled = true
      cleanupAbortHandler()
      const message = redactSensitive(error.message)
      emitTerminalEvent({
        event: 'error',
        sessionId,
        source,
        shell,
        workId: options.workId || null,
        command,
        cwd,
        error: message,
        endedAt: new Date().toISOString(),
      })
      reject(error)
    })

    child.on('close', (exitCode, signal) => {
      if (settled) return
      settled = true
      cleanupAbortHandler()
      appendText('stdout', stdoutDecoder.flush())
      appendText('stderr', stderrDecoder.flush())
      const endedAt = new Date().toISOString()
      const finalSignal = aborted ? (signal || 'SIGTERM') : signal
      emitTerminalEvent({
        event: 'exit',
        sessionId,
        source,
        workId: options.workId || null,
        command,
        cwd,
        exitCode,
        signal: finalSignal,
        shell,
        outputEncoding,
        endedAt,
      })
      applyTerminalContextMutation(context, shell, command, exitCode)
      resolve({
        sessionId,
        command,
        cwd,
        shell,
        outputEncoding,
        exitCode,
        signal: finalSignal,
        output: trimCapture(stdout + stderr),
        stdout,
        stderr,
      })
    })
  })
}
