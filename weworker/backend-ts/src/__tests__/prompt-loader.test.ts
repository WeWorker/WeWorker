import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const PROMPT_IDS = [
  'agent',
  'agent-qa-only',
  'context-window',
  'memory-output',
  'api-router',
  'terminal',
  'title',
] as const

const PROMPTS_ROOT = path.resolve(import.meta.dirname, '../../prompts')

function normalizePrompt(content: string) {
  return content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
}

function buildPrompts(overrides: Partial<Record<(typeof PROMPT_IDS)[number], string>> = {}) {
  return {
    ...Object.fromEntries(PROMPT_IDS.map((id) => [id, `# ${id}\n`])),
    ...overrides,
  }
}

async function importLoader(prompts?: Record<string, string>) {
  vi.resetModules()
  if (prompts) vi.stubGlobal('__BUILD_PROMPTS__', prompts)
  return import('../prompt-loader.js')
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('prompt loader', () => {
  it('loads all fixed prompt IDs from Markdown in development', async () => {
    const { loadPrompt } = await importLoader()

    for (const id of PROMPT_IDS) {
      const markdown = fs.readFileSync(path.join(PROMPTS_ROOT, `${id}.md`), 'utf8')
      expect(loadPrompt(id)).toBe(normalizePrompt(markdown))
    }
  })

  it('prefers embedded build prompts, normalizes text, and caches by ID', async () => {
    const prompts = buildPrompts({ agent: '\uFEFFfirst\r\nsecond\r\n' })
    const { loadPrompt } = await importLoader(prompts)

    expect(loadPrompt('agent')).toBe('first\nsecond\n')
    prompts.agent = 'changed after first load'
    expect(loadPrompt('agent')).toBe('first\nsecond\n')
  })

  it('rejects unknown prompt IDs', async () => {
    const { loadPrompt } = await importLoader(buildPrompts())

    expect(() => loadPrompt('unknown' as never)).toThrow(/Unknown prompt ID: unknown/)
  })

  it('exports only the public API and validates all prompts during module initialization', async () => {
    const loader = await importLoader(buildPrompts())
    expect.soft(Object.keys(loader).sort()).toEqual(['loadPrompt', 'renderPrompt'])

    const prompts = buildPrompts()
    delete prompts.title
    await expect(importLoader(prompts)).rejects.toThrow(/Missing embedded prompt: title/)
  })

  it('renders simple snake_case placeholders', async () => {
    const { renderPrompt } = await importLoader(buildPrompts({
      agent: 'Tool: {{native_command_tool}}\nDirectory: {{user_directory}}\n',
    }))

    expect(renderPrompt('agent', {
      native_command_tool: 'PowerShell',
      user_directory: 'C:\\Users\\example',
    })).toBe('Tool: PowerShell\nDirectory: C:\\Users\\example\n')
  })

  it('rejects a missing template variable', async () => {
    const { renderPrompt } = await importLoader(buildPrompts({
      terminal: 'Shell: {{shell_name}}\nInput: {{user_input}}\n',
    }))

    expect(() => renderPrompt('terminal', { shell_name: 'PowerShell' }))
      .toThrow(/Missing prompt variable.*user_input/)
  })

  it('rejects a variable not declared by the template', async () => {
    const { renderPrompt } = await importLoader(buildPrompts({
      title: 'Message: {{user_message}}\n',
    }))

    expect(() => renderPrompt('title', {
      user_message: 'Summarize this',
      extra_value: 'not declared',
    })).toThrow(/Unknown prompt variable.*extra_value/)
  })

  it('rejects unsupported placeholder syntax', async () => {
    await expect(importLoader(buildPrompts({
      'api-router': 'Route: {{camelCase}}\n',
    }))).rejects.toThrow(/Unsupported prompt placeholder.*camelCase/)
  })

  it.each([
    ['triple opening brace', '{{{user_name}}}', { user_name: 'Ada' }],
    ['extra closing brace', '{{user_name}}}', { user_name: 'Ada' }],
    ['non-snake-case name', '{{user-name}}', {}],
  ])('rejects invalid placeholder boundaries: %s', async (_label, template, variables) => {
    await expect(importLoader(buildPrompts({ title: template })))
      .rejects.toThrow(/Unsupported prompt placeholder/)
  })

  it('validates placeholders in load-only prompts during module initialization', async () => {
    await expect(importLoader(buildPrompts({
      terminal: 'Invalid: {{bad-name}}\n',
    }))).rejects.toThrow(/Unsupported prompt placeholder.*bad-name/)
  })

  it('rejects a legal but undeclared variable when a no-variable prompt is rendered', async () => {
    const { renderPrompt } = await importLoader(buildPrompts({
      terminal: 'Unexpected: {{unexpected_value}}\n',
    }))

    expect(() => renderPrompt('terminal', {}))
      .toThrow(/Missing prompt variable.*unexpected_value/)
  })

  it('preserves placeholder-like text introduced by rendered values', async () => {
    const { renderPrompt } = await importLoader(buildPrompts({
      'memory-output': 'Scope: {{scope}}\n',
    }))

    expect(renderPrompt('memory-output', { scope: '{{literal}}' }))
      .toBe('Scope: {{literal}}\n')
  })
})
