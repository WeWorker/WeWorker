import { describe, expect, it } from 'vitest'
import {
  WEWORKER_ALLOWED_TOOLS,
  canUseWeWorkerTool,
  createWeWorkerToolPolicy,
  isAllowedBashCommand,
  invokesWebcli,
} from '../agent-tool-policy.js'

describe('agent tool policy', () => {
  it('allows non-empty Bash commands used by regular tasks', () => {
    expect(isAllowedBashCommand('webcli call open_browser --args \'{"url":"https://expense.example.com"}\'')).toBe(true)
    expect(isAllowedBashCommand('webcli call expense.example.com.create_budget --args "{}"')).toBe(true)
    expect(isAllowedBashCommand('npm view @example/webcli version')).toBe(true)
    expect(isAllowedBashCommand('git clone git@github.com:example-user/example-repo.git')).toBe(true)
    expect(isAllowedBashCommand('npm test -- --runInBand')).toBe(true)
  })

  it('rejects empty or non-string Bash commands', () => {
    expect(isAllowedBashCommand('')).toBe(false)
    expect(isAllowedBashCommand('   ')).toBe(false)
    expect(isAllowedBashCommand(undefined)).toBe(false)
  })

  it('recognizes webcli executable invocations without matching unrelated text', () => {
    expect(invokesWebcli('webcli call blog-admin.search-blog')).toBe(true)
    expect(invokesWebcli('cd /tmp && /opt/bin/webcli call open_browser')).toBe(true)
    expect(invokesWebcli('webcli.cmd call blog-admin.search-blog')).toBe(true)
    expect(invokesWebcli('echo webcli-python')).toBe(false)
    expect(invokesWebcli('echo "use webcli for this skill"')).toBe(false)
  })

  it('allows Claude Code Skill activation for WeWorker adapter documentation', async () => {
    const decision = await canUseWeWorkerTool('Skill', {
      skill: 'webcli-project.example.com',
    })

    expect(decision.behavior).toBe('allow')
    expect(WEWORKER_ALLOWED_TOOLS).toContain('Skill')
  })

  it('allows Claude Code native file tools so user-directory guard can enforce paths', async () => {
    for (const toolName of ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit']) {
      const decision = await canUseWeWorkerTool(toolName, {
        file_path: 'notes.txt',
      })

      expect(decision.behavior).toBe('allow')
      expect(WEWORKER_ALLOWED_TOOLS).toContain(toolName)
    }
  })

  it('enforces the qa_only, no_bash, and full capability matrix', async () => {
    const cases = [
      { mode: 'qa_only' as const, skill: 'deny', file: 'deny', bash: 'deny', mcp: 'deny' },
      { mode: 'no_bash' as const, skill: 'allow', file: 'allow', bash: 'deny', mcp: 'allow' },
      { mode: 'workspace' as const, skill: 'allow', file: 'allow', bash: 'allow', mcp: 'allow' },
      { mode: 'ask' as const, skill: 'allow', file: 'allow', bash: 'allow', mcp: 'allow' },
      { mode: 'full' as const, skill: 'allow', file: 'allow', bash: 'allow', mcp: 'allow' },
    ]

    for (const expected of cases) {
      const policy = createWeWorkerToolPolicy(expected.mode)
      await expect(policy('Skill', { skill: 'test' }, {} as never))
        .resolves.toMatchObject({ behavior: expected.skill })
      await expect(policy('Read', { file_path: 'notes.txt' }, {} as never))
        .resolves.toMatchObject({ behavior: expected.file })
      await expect(policy('Bash', { command: 'pwd' }, {} as never))
        .resolves.toMatchObject({ behavior: expected.bash })
      await expect(policy('PowerShell', { command: 'Get-Location' }, {} as never))
        .resolves.toMatchObject({ behavior: expected.bash })
      await expect(policy('mcp__weworker__webcli_result', {}, {} as never))
        .resolves.toMatchObject({ behavior: expected.mcp })
    }
  })

  it.each(['ask', 'workspace', 'full'] as const)('allows the complete available Claude tool set in %s mode', async mode => {
    const policy = createWeWorkerToolPolicy(mode)
    for (const toolName of ['Agent', 'Task', 'WebFetch', 'WebSearch', 'CronCreate', 'AskUserQuestion', 'Read', 'Write', 'PowerShell', 'mcp__weworker__weworker_powershell']) {
      await expect(policy(toolName, { command: 'npm test', url: 'https://example.com' }, {} as never))
        .resolves.toMatchObject({ behavior: 'allow' })
    }
  })

  it('allows Adapter commands through every command tool in full mode', async () => {
    const policy = createWeWorkerToolPolicy('full')

    await expect(policy(
      'mcp__weworker__weworker_powershell',
      { command: 'webcli call blog-admin.search-blog --limit=5' },
      {} as never,
    )).resolves.toMatchObject({ behavior: 'allow' })
    await expect(policy(
      'mcp__weworker__weworker_powershell',
      { command: 'npm test' },
      {} as never,
    )).resolves.toMatchObject({ behavior: 'allow' })
  })

  it('allows both Adapter runtimes through guarded workspace native commands', async () => {
    const policy = createWeWorkerToolPolicy('workspace')
    for (const command of [
      'webcli call example.com.read --url=https://example.com/public',
      'webcli call example-toolkit.list --limit=5',
    ]) {
      await expect(policy('PowerShell', { command }, {} as never)).resolves.toMatchObject({ behavior: 'allow' })
    }
    await expect(policy('PowerShell', { command: ' ' }, {} as never)).resolves.toMatchObject({ behavior: 'allow' })
    const result = await policy('mcp__weworker__weworker_powershell', { command: 'webcli call example.com.read' }, {} as never)
    expect(result).toMatchObject({ behavior: 'allow' })
  })
})
