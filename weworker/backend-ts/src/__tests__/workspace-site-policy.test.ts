import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixtures = vi.hoisted(() => ({ origins: ['https://example.com'], adapterEnabled: true }))
vi.mock('../config.js', () => ({
  getOpenBrowserAllowedOrigins: () => fixtures.origins,
  getSiteEnabled: () => fixtures.adapterEnabled,
}))
vi.mock('../adapter-parser.js', () => ({
  parseAllAdapters: () => new Map([['example', {
    id: 'example', defaultEnabled: true, managed: undefined,
    homepageUrl: 'https://adapter.example.org', match: ['adapter.example.org'], tools: [{ name: 'adapter.example.org.read' }],
  }]]),
}))

import { checkWorkspaceToolSites } from '../workspace-site-policy.js'
import { createWorkspacePreToolUseHook } from '../workspace-tool-hook.js'

describe('workspace network tool restrictions', () => {
  beforeEach(() => {
    fixtures.origins = ['https://example.com']
    fixtures.adapterEnabled = true
  })

  it('limits WebFetch to configured and enabled Adapter origins', () => {
    expect(checkWorkspaceToolSites('WebFetch', { url: 'https://example.com/docs' })).toMatchObject({ allowed: true })
    expect(checkWorkspaceToolSites('WebFetch', { url: 'https://adapter.example.org/read' })).toMatchObject({ allowed: true })
    expect(checkWorkspaceToolSites('WebFetch', { url: 'https://unlisted.example.net' })).toMatchObject({ allowed: false })
  })

  it('restricts WebSearch to the exact configured domain set', () => {
    expect(checkWorkspaceToolSites('WebSearch', { query: 'public docs' })).toMatchObject({
      allowed: true,
      updatedInput: { allowed_domains: ['example.com', 'adapter.example.org'] },
    })
    expect(checkWorkspaceToolSites('WebSearch', { query: 'public docs', allowed_domains: ['unlisted.example.net'] }))
      .toMatchObject({ allowed: false })
  })

  it('denies WebSearch when the site allowlist is empty', () => {
    fixtures.origins = []
    fixtures.adapterEnabled = false
    expect(checkWorkspaceToolSites('WebSearch', { query: 'public docs' })).toMatchObject({ allowed: false })
  })

  it('enforces and narrows website tools in the PreToolUse hook', async () => {
    const hook = createWorkspacePreToolUseHook('C:/example/workspace')
    const invoke = (toolName: string, toolInput: Record<string, unknown>) => hook({
      hook_event_name: 'PreToolUse', session_id: 'example-session', transcript_path: '', cwd: 'C:/example/workspace',
      tool_name: toolName, tool_input: toolInput, tool_use_id: 'example-tool',
    }, 'example-tool', { signal: new AbortController().signal })

    await expect(invoke('WebFetch', { url: 'https://unlisted.example.net/docs' })).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    })
    await expect(invoke('WebSearch', { query: 'public docs' })).resolves.toMatchObject({
      hookSpecificOutput: { updatedInput: { allowed_domains: ['example.com', 'adapter.example.org'] } },
    })
  })
})
