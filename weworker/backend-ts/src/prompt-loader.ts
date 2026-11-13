import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROMPT_IDS = [
  'agent',
  'agent-qa-only',
  'context-window',
  'memory-output',
  'api-router',
  'terminal',
  'title',
] as const

export type PromptId = (typeof PROMPT_IDS)[number]

declare const __BUILD_PROMPTS__: unknown

const PROMPT_FILES: Record<PromptId, string> = {
  agent: 'agent.md',
  'agent-qa-only': 'agent-qa-only.md',
  'context-window': 'context-window.md',
  'memory-output': 'memory-output.md',
  'api-router': 'api-router.md',
  terminal: 'terminal.md',
  title: 'title.md',
}

const PROMPTS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../prompts')
const EXACT_PLACEHOLDER = /^{{([a-z][a-z0-9]*(?:_[a-z0-9]+)*)}}$/
const PLACEHOLDER = /{{([a-z][a-z0-9]*(?:_[a-z0-9]+)*)}}/g
const BRACE_EXPRESSION = /{+[^{}]*}+/g
const promptCache = new Map<PromptId, string>()

function assertPromptId(id: string): asserts id is PromptId {
  if (!Object.hasOwn(PROMPT_FILES, id)) {
    throw new Error(`Unknown prompt ID: ${id}`)
  }
}

function getBuildPrompts(): Record<string, unknown> | undefined {
  if (typeof __BUILD_PROMPTS__ === 'undefined') return undefined
  if (!__BUILD_PROMPTS__ || typeof __BUILD_PROMPTS__ !== 'object' || Array.isArray(__BUILD_PROMPTS__)) {
    throw new Error('Invalid __BUILD_PROMPTS__: expected a prompt map')
  }
  return __BUILD_PROMPTS__ as Record<string, unknown>
}

function normalizePrompt(content: string): string {
  return content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
}

export function loadPrompt(id: PromptId): string {
  assertPromptId(id)

  const cached = promptCache.get(id)
  if (cached !== undefined) return cached

  const buildPrompts = getBuildPrompts()
  const content = buildPrompts
    ? buildPrompts[id]
    : fs.readFileSync(path.join(PROMPTS_ROOT, PROMPT_FILES[id]), 'utf8')
  if (typeof content !== 'string') {
    throw new Error(`Missing embedded prompt: ${id}`)
  }

  const normalized = normalizePrompt(content)
  promptCache.set(id, normalized)
  return normalized
}

function collectDeclaredVariables(template: string, id: PromptId): Set<string> {
  const declaredVariables = new Set<string>()
  for (const match of template.matchAll(BRACE_EXPRESSION)) {
    const expression = match[0]
    if (!expression.includes('{{') && !expression.includes('}}')) continue

    const placeholder = expression.match(EXACT_PLACEHOLDER)
    if (!placeholder) {
      throw new Error(`Unsupported prompt placeholder in ${id}: ${expression}`)
    }
    declaredVariables.add(placeholder[1])
  }

  const unmatchedBoundary = template.replace(BRACE_EXPRESSION, '').match(/{{|}}/)
  if (unmatchedBoundary) {
    throw new Error(`Unsupported prompt placeholder in ${id}: ${unmatchedBoundary[0]}`)
  }
  return declaredVariables
}

for (const id of PROMPT_IDS) {
  collectDeclaredVariables(loadPrompt(id), id)
}

export function renderPrompt(id: PromptId, variables: Record<string, string>): string {
  const template = loadPrompt(id)
  const declaredVariables = collectDeclaredVariables(template, id)

  for (const name of declaredVariables) {
    if (!Object.hasOwn(variables, name)) {
      throw new Error(`Missing prompt variable for ${id}: ${name}`)
    }
  }
  for (const name of Object.keys(variables)) {
    if (!declaredVariables.has(name)) {
      throw new Error(`Unknown prompt variable for ${id}: ${name}`)
    }
  }

  return template.replace(PLACEHOLDER, (_placeholder, name: string) => variables[name])
}
