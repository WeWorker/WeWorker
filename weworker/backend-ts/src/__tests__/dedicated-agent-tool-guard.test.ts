import { describe, expect, it } from 'vitest'
import {
  checkFocusedWebcliCommand,
  createFocusedToolGuard,
  FOCUSED_AGENT_DISALLOWED_TOOLS,
  splitShellWords,
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
  ])('rejects shell operators outside quotes: %s', (command) => {
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

  it('denies file writes, other shells and unlisted WeWorker tools', () => {
    const guard = createFocusedToolGuard(SITES)
    expect(guard('Bash', { command: 'webcli call example.com.search --q=x' })).toEqual({ behavior: 'allow' })
    expect(guard('PowerShell', { command: 'Get-ChildItem' }).behavior).toBe('deny')
    expect(guard('Write', { file_path: 'notes.txt' }).behavior).toBe('deny')
    expect(guard('mcp__weworker__create_scheduled_task', {}).behavior).toBe('deny')
    expect(guard('mcp__weworker__ask_user', {})).toEqual({ behavior: 'allow' })
    expect(createFocusedToolGuard(SITES, [], ['mcp__weworker__send_agent_message'])('mcp__weworker__send_agent_message', {})).toEqual({ behavior: 'allow' })
    expect(guard('Skill', {})).toEqual({ behavior: 'allow' })
    expect(FOCUSED_AGENT_DISALLOWED_TOOLS).toContain('mcp__weworker__weworker_powershell')
  })
})
