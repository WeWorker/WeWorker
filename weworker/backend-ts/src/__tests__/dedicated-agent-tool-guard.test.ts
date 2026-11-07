import { describe, expect, it } from 'vitest'
import {
  checkFocusedWebcliCommand,
  checkWebcliScopeInCommand,
  createWorkspaceToolGuard,
  splitShellWords,
  WORKSPACE_AGENT_DISALLOWED_TOOLS,
} from '../dedicated-agents/focused-tool-guard.js'

const SITES = ['example.com']

describe('focused tool guard', () => {
  it('splits words with single and double quotes', () => {
    expect(splitShellWords(`webcli call example.com.search --query='a | b; c'`)).toEqual({
      ok: true,
      words: ['webcli', 'call', 'example.com.search', '--query=a | b; c'],
    })
    expect(splitShellWords('webcli call example.com.search --query="plain text"')).toEqual({
      ok: true,
      words: ['webcli', 'call', 'example.com.search', '--query=plain text'],
    })
  })

  it.each([
    'webcli call example.com.search; rm -rf .',
    'webcli call example.com.search | more',
    'webcli call example.com.search > out.txt',
    'webcli call example.com.search --q=$HOME',
    'webcli call example.com.search --q=`id`',
    'webcli call example.com.search --q="$(id)"',
    'webcli call example.com.search && echo done',
    "webcli call example.com.search --q='unterminated",
  ])('rejects shell operators outside quotes in a single invocation: %s', (command) => {
    expect(checkFocusedWebcliCommand(command, SITES).ok).toBe(false)
  })

  it('allows only webcli calls for the agent website', () => {
    expect(checkFocusedWebcliCommand('webcli call example.com.list_orders --limit=5', SITES)).toEqual({ ok: true })
    expect(checkFocusedWebcliCommand('webcli call open_browser --url=https://example.com --adapter=example.com', SITES)).toEqual({ ok: true })
    expect(checkFocusedWebcliCommand('webcli call open_browser --url=https://example.com', SITES).ok).toBe(false)
    expect(checkFocusedWebcliCommand('webcli call open_browser --url=https://example.org --adapter=example.org', SITES).ok).toBe(false)
    expect(checkFocusedWebcliCommand('webcli help', SITES)).toEqual({ ok: true })
    expect(checkFocusedWebcliCommand('webcli example.com help', SITES)).toEqual({ ok: true })
    expect(checkFocusedWebcliCommand('webcli call example.org.search', SITES).ok).toBe(false)
    expect(checkFocusedWebcliCommand('webcli call example.com', SITES).ok).toBe(false)
    expect(checkFocusedWebcliCommand('webcli call example.community.search', SITES).ok).toBe(false)
  })

  it('does not treat tools of a longer Adapter id with the same prefix as ours', () => {
    const known = ['example.com', 'example.com.cn', 'orders.example.com']
    expect(checkFocusedWebcliCommand('webcli call example.com.search', SITES, known)).toEqual({ ok: true })
    expect(checkFocusedWebcliCommand('webcli call example.com.cn.search', SITES, known).ok).toBe(false)
    expect(checkFocusedWebcliCommand('webcli call orders.example.com.search', SITES, known).ok).toBe(false)
    expect(checkFocusedWebcliCommand('webcli call example.com.cn.search', ['example.com.cn'], known)).toEqual({ ok: true })
    expect(checkFocusedWebcliCommand('webcli call', SITES).ok).toBe(false)
    expect(checkFocusedWebcliCommand('webcli install --skills', SITES).ok).toBe(false)
    expect(checkFocusedWebcliCommand('node -e 1', SITES).ok).toBe(false)
    expect(checkFocusedWebcliCommand('', SITES).ok).toBe(false)
  })
})

describe('webcli scope check inside arbitrary shell commands', () => {
  it('allows ordinary commands without webcli and compound commands with own-site webcli', () => {
    expect(checkWebcliScopeInCommand('git status', SITES)).toEqual({ ok: true })
    expect(checkWebcliScopeInCommand('Get-ChildItem -Recurse | Measure-Object', SITES)).toEqual({ ok: true })
    expect(checkWebcliScopeInCommand('cd . && npm test', SITES)).toEqual({ ok: true })
    expect(checkWebcliScopeInCommand(`git pull && webcli call example.com.search --query='a | b'`, SITES)).toEqual({ ok: true })
    expect(checkWebcliScopeInCommand(`webcli call example.com.search; echo done`, SITES)).toEqual({ ok: true })
    expect(checkWebcliScopeInCommand('webcli call example.org.search || true', ['example.com', 'example.org'])).toEqual({ ok: true })
  })

  it('denies webcli calls for sites the agent does not operate', () => {
    expect(checkWebcliScopeInCommand('webcli call example.org.search', SITES).ok).toBe(false)
    expect(checkWebcliScopeInCommand('echo start; webcli call example.org.search', SITES).ok).toBe(false)
    expect(checkWebcliScopeInCommand('webcli call example.com.search && webcli call other.org.x', SITES).ok).toBe(false)
    expect(checkWebcliScopeInCommand('webcli call example.community.search', SITES).ok).toBe(false)
  })

  it('allows read-only webcli usage and denies unparseable webcli mentions for site-less agents', () => {
    expect(checkWebcliScopeInCommand('webcli list', []).ok).toBe(true)
    expect(checkWebcliScopeInCommand('webcli --version', []).ok).toBe(true)
    expect(checkWebcliScopeInCommand('webcli call example.com.search', []).ok).toBe(false)
  })

  it('checks unquoted subshells but denies webcli embedded inside other commands', () => {
    // A subshell invocation genuinely runs webcli, so it is validated like a plain call.
    expect(checkWebcliScopeInCommand('echo "$(webcli call example.com.search)" > /dev/null; echo done', SITES).ok).toBe(false)
    expect(checkWebcliScopeInCommand('result=$(webcli call example.com.search --q=x) && echo ok', SITES)).toEqual({ ok: true })
    expect(checkWebcliScopeInCommand('result=$(webcli call example.org.search) && echo ok', SITES).ok).toBe(false)
    expect(checkWebcliScopeInCommand('echo "$(webcli call example.org.search)"', SITES).ok).toBe(false)
    expect(checkWebcliScopeInCommand('CMD=webcli; $CMD call example.com.search', SITES).ok).toBe(false)
  })
})

describe('workspace tool guard', () => {
  it('allows native file and shell tools and scopes only webcli plus WeWorker MCP tools', () => {
    const guard = createWorkspaceToolGuard(SITES)
    expect(guard('Bash', { command: 'webcli call example.com.search --q=x' })).toEqual({ behavior: 'allow' })
    expect(guard('PowerShell', { command: 'Get-ChildItem' })).toEqual({ behavior: 'allow' })
    expect(guard('Bash', { command: 'webcli call example.org.search' }).behavior).toBe('deny')
    expect(guard('Write', { file_path: 'notes.txt' })).toEqual({ behavior: 'allow' })
    expect(guard('Edit', { file_path: 'notes.txt' })).toEqual({ behavior: 'allow' })
    expect(guard('mcp__weworker__create_scheduled_task', {}).behavior).toBe('deny')
    expect(guard('mcp__weworker__ask_user', {})).toEqual({ behavior: 'allow' })
    expect(guard('mcp__weworker__send_file_to_user', {})).toEqual({ behavior: 'allow' })
    expect(createWorkspaceToolGuard(SITES, [], ['mcp__weworker__send_agent_message'])('mcp__weworker__send_agent_message', {})).toEqual({ behavior: 'allow' })
    expect(guard('Skill', {})).toEqual({ behavior: 'allow' })
  })

  it('hides WeWorker-only MCP tools but not native file tools', () => {
    expect(WORKSPACE_AGENT_DISALLOWED_TOOLS).toContain('mcp__weworker__weworker_powershell')
    expect(WORKSPACE_AGENT_DISALLOWED_TOOLS).toContain('mcp__weworker__start_adapter_generation')
    expect(WORKSPACE_AGENT_DISALLOWED_TOOLS).not.toContain('Edit')
    expect(WORKSPACE_AGENT_DISALLOWED_TOOLS).not.toContain('Write')
    expect(WORKSPACE_AGENT_DISALLOWED_TOOLS).not.toContain('mcp__weworker__send_file_to_user')
  })
})
