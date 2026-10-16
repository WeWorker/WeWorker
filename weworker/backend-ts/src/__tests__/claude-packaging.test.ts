import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createWeWorkerToolPolicy } from '../agent-tool-policy.js'
import {
  buildClaudeNativeShellEnv,
  buildDisallowedTools,
  resolvePackagedClaudeEntrypoint,
} from '../agent.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function createTempResourcesDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-claude-resources-'))
  tempDirs.push(dir)
  return dir
}

describe('packaged Claude Code entrypoint', () => {
  it('hides unsupported native tools in every permission mode while preserving supported tools', async () => {
    const unsupported = [
      'EnterWorktree', 'ExitWorktree', 'ListAgents', 'ReportFindings',
      'ScheduleWakeup', 'SendMessage', 'TaskCreate', 'TaskGet', 'TaskList',
      'TaskStop', 'TaskUpdate', 'WebSearch', 'Workflow',
    ]
    for (const mode of ['full', 'no_bash', 'qa_only'] as const) {
      for (const platform of ['win32', 'darwin', 'linux'] as const) {
        const excluded = buildDisallowedTools(mode, platform)
        expect(excluded).toEqual(expect.arrayContaining(unsupported))
        for (const name of unsupported) {
          await expect(createWeWorkerToolPolicy(mode)(name, {}, {} as never))
            .resolves.toMatchObject({ behavior: 'deny' })
        }
        if (mode !== 'qa_only') {
          for (const name of ['Skill', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit']) {
            expect(excluded).not.toContain(name)
          }
        }
        expect(excluded).not.toContain('mcp__weworker__ask_user')
      }
    }
  })

  it('uses the bundled native runtime first', () => {
    const runtimeDir = createTempResourcesDir()
    const nativeBin = path.join(runtimeDir, 'claude-code', 'bin', 'claude.exe')
    const scriptBin = path.join(runtimeDir, 'claude-code', 'cli-wrapper.cjs')
    fs.mkdirSync(path.dirname(nativeBin), { recursive: true })
    fs.writeFileSync(nativeBin, '')
    fs.writeFileSync(scriptBin, '')

    expect(resolvePackagedClaudeEntrypoint(runtimeDir, 'win32')).toBe(nativeBin)
  })

  it('falls back to the packaged script entrypoint when no native binary exists', () => {
    const runtimeDir = createTempResourcesDir()
    const scriptBin = path.join(runtimeDir, 'claude-code', 'cli-wrapper.cjs')
    fs.mkdirSync(path.dirname(scriptBin), { recursive: true })
    fs.writeFileSync(scriptBin, '')

    expect(resolvePackagedClaudeEntrypoint(runtimeDir)).toBe(scriptBin)
  })

  it('enables the native PowerShell tool on Windows without configuring Git Bash', () => {
    expect(buildClaudeNativeShellEnv('win32')).toEqual({ CLAUDE_CODE_USE_POWERSHELL_TOOL: '1' })
    expect(buildClaudeNativeShellEnv('darwin')).toEqual({})
  })

  it('keeps the native shell authoritative and disallows the alternate shell', () => {
    const fullWindows = buildDisallowedTools('full', 'win32')
    const noBashWindows = buildDisallowedTools('no_bash', 'win32')
    const qaWindows = buildDisallowedTools('qa_only', 'win32')
    const fullPosix = buildDisallowedTools('full', 'darwin')
    const noBashRestricted = buildDisallowedTools('no_bash', 'win32', true)
    const fullRestricted = buildDisallowedTools('full', 'win32', true)

    expect(fullWindows).toContain('Bash')
    expect(fullWindows).not.toContain('PowerShell')
    expect(noBashWindows).toEqual(expect.arrayContaining(['Bash', 'PowerShell']))
    expect(qaWindows).toEqual(expect.arrayContaining(['Bash', 'PowerShell', 'Skill']))
    expect(fullPosix).toContain('PowerShell')
    expect(fullPosix).not.toContain('Bash')
    expect(noBashRestricted).toEqual(expect.arrayContaining([
      'Bash',
      'PowerShell',
      'Skill',
      'Read',
      'Glob',
      'Grep',
      'Edit',
      'Write',
      'NotebookEdit',
      'TodoWrite',
      'WebSearch',
    ]))
    expect(fullRestricted).toEqual(expect.arrayContaining([
      'Bash',
      'PowerShell',
      'Skill',
      'Read',
      'WebSearch',
    ]))
  })

  it('keeps Claude Code owned by Backend and packages one explicit copy', () => {
    const packageJsonPath = path.resolve(process.cwd(), '..', 'package.json')
    const backendPackageJsonPath = path.resolve(process.cwd(), 'package.json')
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      scripts?: Record<string, string>
      build?: {
        extraResources?: Array<{ from?: string; to?: string; filter?: string[] }>
      }
    }
    const backendPackageJson = JSON.parse(fs.readFileSync(backendPackageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>
    }

    const sharedClaudeResource = packageJson.build?.extraResources?.find((entry) => entry.to === 'claude-code')

    expect(packageJson.dependencies?.['@anthropic-ai/claude-code']).toBeUndefined()
    expect(packageJson.devDependencies?.['@anthropic-ai/claude-code']).toBeUndefined()
    expect(backendPackageJson.dependencies?.['@anthropic-ai/claude-code']).toBe('2.1.252')
    expect(sharedClaudeResource?.from).toBe('backend-ts/node_modules/@anthropic-ai/claude-code')
    expect(sharedClaudeResource?.filter).toEqual(expect.arrayContaining([
      'bin/**',
      'cli-wrapper.cjs',
      'package.json',
    ]))
    expect(packageJson.scripts?.['ensure:bash-runtime']).toBeUndefined()
    expect(packageJson.scripts?.['build:win']).not.toContain('ensure:bash-runtime')
    expect(packageJson.build?.extraResources?.some((entry) => entry.to === 'runtime/git-bash')).toBe(false)
  })

  it('pins the Agent SDK so dependency installation cannot silently change the CLI protocol', () => {
    const packageJsonPath = path.resolve(process.cwd(), 'package.json')
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>
    }

    expect(packageJson.dependencies?.['@anthropic-ai/claude-agent-sdk']).toBe('0.3.252')
  })

  it('packages bundled ZCF templates at the runtime lookup path', () => {
    const packageJsonPath = path.resolve(process.cwd(), '..', 'package.json')
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      build?: {
        extraResources?: Array<{ from?: string; to?: string; filter?: string[] }>
      }
    }

    const bundledZcfResource = packageJson.build?.extraResources?.find((entry) => entry.to === 'bundled')

    expect(bundledZcfResource?.from).toBe('backend-ts/bundled/')
    expect(bundledZcfResource?.filter).toEqual(expect.arrayContaining(['zcf/**']))
  })
})
