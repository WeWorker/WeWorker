/**
 * Skill generator — produces SKILL.md content from ParsedAdapter definitions.
 * Each adapter gets a markdown file with YAML frontmatter, tool documentation,
 * usage examples, and optional authentication instructions.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { ParsedAdapter, StaticToolDef } from './adapter-parser.js'
import { createLogger } from './logger.js'

const log = createLogger('skill-generator')

export interface SkillGeneratorOptions {
  skillsDir: string  // default: ~/.weworker/.claude/skills
}

const DEFAULT_SKILLS_DIR = path.join(os.homedir(), '.weworker', '.claude', 'skills')

/**
 * Write/update a single adapter's Skill file, respecting disabled state.
 * - If enabled: write SKILL.md (or update SKILL.md.disabled content if user disabled it)
 * - If !enabled: remove the Skill directory
 * - Creates directories recursively as needed
 */
export function syncSkillForAdapter(
  adapter: ParsedAdapter,
  enabled: boolean,
  options?: SkillGeneratorOptions,
): void {
  const skillsDir = options?.skillsDir ?? DEFAULT_SKILLS_DIR
  const adapterDir = path.join(skillsDir, adapter.id)
  const skillPath = path.join(adapterDir, 'SKILL.md')
  const disabledPath = path.join(adapterDir, 'SKILL.md.disabled')

  if (!enabled) {
    // Remove the skill directory entirely
    if (fs.existsSync(adapterDir)) {
      fs.rmSync(adapterDir, { recursive: true, force: true })
    }
    return
  }

  // Enabled: generate content and write
  const content = generateSkillContent(adapter)
  fs.mkdirSync(adapterDir, { recursive: true })

  if (fs.existsSync(disabledPath)) {
    // User manually disabled — update content without renaming back
    fs.writeFileSync(disabledPath, content, 'utf-8')
  } else {
    fs.writeFileSync(skillPath, content, 'utf-8')
  }
}

/**
 * Sync all Skills: generate for each adapter, remove orphans.
 * - For each adapter: call syncSkillForAdapter with enabled = enabledAdapterIds.has(adapterId)
 * - Scan skillsDir for directories not matching any adapter ID → remove orphans
 * - Handle missing skills directory by creating it
 * - Log warnings on file permission errors, continue with other adapters
 */
export function syncAllSkills(
  adapters: Map<string, ParsedAdapter>,
  enabledAdapterIds: Set<string>,
  options?: SkillGeneratorOptions,
): void {
  const skillsDir = options?.skillsDir ?? DEFAULT_SKILLS_DIR

  // Ensure skills directory exists
  try {
    fs.mkdirSync(skillsDir, { recursive: true })
  } catch (e) {
    log.warn('Failed to create skills directory', e)
    return
  }

  // Sync each adapter
  for (const [adapterId, adapter] of adapters) {
    const enabled = enabledAdapterIds.has(adapterId)
    try {
      syncSkillForAdapter(adapter, enabled, options)
    } catch (e) {
      log.warn(`Failed to sync skill for adapter "${adapterId}"`, e)
    }
  }

  // Remove orphan directories not matching any adapter ID
  try {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && !adapters.has(entry.name)) {
        try {
          fs.rmSync(path.join(skillsDir, entry.name), { recursive: true, force: true })
        } catch (e) {
          log.warn(`Failed to remove orphan skill directory "${entry.name}"`, e)
        }
      }
    }
  } catch (e) {
    log.warn('Failed to scan skills directory for orphans', e)
  }
}


/**
 * Generate SKILL.md content for a single adapter.
 * Produces a complete markdown document with YAML frontmatter,
 * tool listings, parameter tables, usage examples, and auth instructions.
 */
export function generateSkillContent(adapter: ParsedAdapter): string {
  const lines: string[] = []

  // YAML frontmatter
  lines.push('---')
  lines.push(`name: "${escapeFrontmatter(adapter.name)}"`)
  lines.push(`description: "${escapeFrontmatter(adapter.description)}"`)
  lines.push('---')
  lines.push('')

  // Title
  const primaryDomain = adapter.match[0] ?? adapter.id
  lines.push(`# ${adapter.name} (${primaryDomain})`)
  lines.push('')

  // Supported Domains
  lines.push('## Supported Domains')
  for (const domain of adapter.match) {
    lines.push(`- ${domain}`)
  }
  lines.push('')

  // Homepage
  lines.push('## Homepage')
  lines.push(adapter.homepageUrl)
  lines.push('')

  // Available Tools
  lines.push('## Available Tools')
  lines.push('')
  for (const tool of adapter.tools) {
    lines.push(...generateToolSection(tool))
  }

  const hasDirectTools = adapter.tools.some(isDirectTool)
  if (hasDirectTools) {
    lines.push('## Execution Rules')
    lines.push('- Tools marked `Execution: type=api, runtime=background` and `Execution: mode=direct` are API tools and must be called without opening the website or checking login first.')
    lines.push('- Page/DOM tools still require opening the website in Chrome before calling them.')
    lines.push('- Open the Homepage URL only after a direct tool reports a login error or requires page context.')
    lines.push('')
  }

  // How to Use
  lines.push('## How to Use')
  lines.push('')
  lines.push('Call tools using `webcli call <tool_name> --key=value ...`:')
  lines.push('- `tool_name`: The exact public tool name (e.g., `' + (adapter.tools[0]?.name ?? `${primaryDomain}.example_tool`) + '`)')
  lines.push('- Pass ordinary strings, numbers and booleans as --key=value; quote the complete flag if it contains spaces.')
  lines.push('- Use JSON literals only for individual object/array parameters. Whole-object --args is a compatibility fallback, not the default; avoid it for ordinary arguments, especially in PowerShell.')
  lines.push('')

  // Examples
  lines.push('### Examples')
  lines.push('')
  lines.push('```bash')
  for (const tool of adapter.tools) {
    lines.push(generateExample(tool))
  }
  lines.push('```')
  lines.push('')

  // Authentication (conditional)
  if (adapter.requiresAuth) {
    lines.push('## Authentication')
    lines.push('This website requires login. WeWorker handles it: when a tool reports that login is needed, WeWorker opens the login page in WeWorker 浏览器, waits for the user (QR code, SMS code or password) and retries the tool. Call tools directly; do not check login first.')
    if (hasDirectTools) {
      lines.push('Direct tools reuse the browser\'s existing session; do not open the website before calling them.')
    }
    if (adapter.authCheckTool) {
      lines.push(`\`${adapter.authCheckTool}\` is only for diagnosing a login problem the user reports; WeWorker runs its own check.`)
    }
    lines.push('If a tool returns `code: AUTH_REQUIRED` with `auth.status: waiting_user`, ask the user to finish signing in on the opened page, then run the tool again.')
    lines.push('')
  }

  // Important Notes
  lines.push('## Important Notes')
  if (hasDirectTools) {
    lines.push('- Do not call `open_browser` or a login-check tool before direct tools.')
    lines.push('- Use `open_browser` before page/DOM tools, then wait at least 5 seconds.')
  } else {
    lines.push('- Use `open_browser` before calling page/DOM tools, then wait at least 5 seconds.')
  }
  lines.push('- Use the exact tool names listed above.')
  lines.push('')

  return lines.join('\n')
}

/**
 * Escape double quotes in YAML frontmatter values.
 */
function escapeFrontmatter(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Generate the markdown section for a single tool, including
 * description and parameter table.
 */
function generateToolSection(tool: StaticToolDef): string[] {
  const lines: string[] = []
  lines.push(`### ${tool.name}`)
  lines.push(tool.description)
  lines.push('')
  if (isDirectTool(tool)) {
    lines.push('Execution: type=api, runtime=background')
    lines.push('')
    lines.push('Execution: mode=direct')
    lines.push('')
  } else if (tool.execution?.type || tool.execution?.runtime) {
    lines.push(`Execution: type=${tool.execution.type || 'dom'}, runtime=${tool.execution.runtime || 'page'}`)
    lines.push('')
  }

  const params = extractParams(tool.parameters)
  if (params.length === 0) {
    lines.push('(no parameters)')
    lines.push('')
    return lines
  }

  lines.push('| Parameter | Type | Required | Description |')
  lines.push('|-----------|------|----------|-------------|')
  for (const p of params) {
    lines.push(`| ${p.name} | ${p.type} | ${p.required ? 'Yes' : 'No'} | ${p.description} |`)
  }
  lines.push('')
  return lines
}

function isDirectTool(tool: StaticToolDef): boolean {
  return tool.directCapable === true
    || tool.executionMode === 'direct'
    || (tool.execution?.type === 'api' && tool.execution?.runtime === 'background')
}

interface ParamInfo {
  name: string
  type: string
  required: boolean
  description: string
}

/**
 * Extract parameter info from a JSON Schema parameters object.
 */
function extractParams(parameters: Record<string, unknown>): ParamInfo[] {
  const properties = (parameters as { properties?: Record<string, Record<string, unknown>> }).properties
  if (!properties || typeof properties !== 'object') return []

  const requiredList = (parameters as { required?: string[] }).required ?? []

  return Object.entries(properties).filter(([name]) => name !== '__confirmed').map(([name, schema]) => ({
    name,
    type: (typeof schema.type === 'string' ? schema.type : 'string'),
    required: requiredList.includes(name),
    description: (typeof schema.description === 'string' ? schema.description : ''),
  }))
}

/**
 * Generate an example webcli call invocation for a tool.
 */
function generateExample(tool: StaticToolDef): string {
  const params = extractParams(tool.parameters)
  const exampleArgs: Record<string, unknown> = {}
  for (const p of params) {
    if (p.required) {
      exampleArgs[p.name] = getExampleValue(p)
    }
  }
  const flags = Object.entries(exampleArgs).map(([key, value]) => {
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
    return shellQuote('--' + key + '=' + text)
  })
  return [`webcli call ${shellQuote(tool.name)}`, ...flags].join(' ')
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Produce a placeholder example value for a parameter based on its type.
 */
function getExampleValue(param: ParamInfo): unknown {
  switch (param.type) {
    case 'number':
    case 'integer':
      return 1
    case 'boolean':
      return true
    case 'array':
      return []
    case 'object':
      return {}
    default:
      // Use description as hint for a meaningful placeholder, or fall back to generic
      return '...'
  }
}
