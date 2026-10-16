import { describe, it, expect, afterEach } from 'vitest'
import fc from 'fast-check'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateSkillContent, syncAllSkills, syncSkillForAdapter } from '../skill-generator.js'
import type { ParsedAdapter, StaticToolDef } from '../adapter-parser.js'

// --- Arbitraries ---

/** Generate a valid identifier-like string (alphanumeric + underscores, non-empty). */
const arbIdentifier: fc.Arbitrary<string> = fc.stringMatching(/^[a-z][a-z0-9_]{0,14}$/)

/** Generate a non-empty human-readable string (no special chars that break YAML). */
const arbText: fc.Arbitrary<string> = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9 ]{0,30}$/)

/** Generate a domain-like string, e.g. "abc.com". */
const arbDomain: fc.Arbitrary<string> = fc
  .tuple(
    fc.stringMatching(/^[a-z]{2,10}$/),
    fc.constantFrom('.com', '.net', '.org', '.io'),
  )
  .map(([name, tld]) => name + tld)

/** Generate a JSON Schema type string. */
const arbJsonType: fc.Arbitrary<string> = fc.constantFrom('string', 'number', 'integer', 'boolean', 'array', 'object')

/**
 * arbitraryStaticToolDef — generates random tool definitions with valid JSON Schema parameters.
 * Tools have 0-5 parameters, each with a name, type, and description.
 * A random subset of parameters is marked as required.
 */
function arbitraryStaticToolDef(): fc.Arbitrary<StaticToolDef> {
  const arbParam = fc.record({
    name: arbIdentifier,
    type: arbJsonType,
    description: arbText,
  })

  return fc
    .record({
      toolDomain: arbDomain,
      toolSuffix: arbIdentifier,
      description: arbText,
      params: fc.uniqueArray(arbParam, { minLength: 0, maxLength: 5, selector: (p) => p.name }),
    })
    .chain(({ toolDomain, toolSuffix, description, params }) => {
      if (params.length === 0) {
        return fc.constant<StaticToolDef>({
          name: `${toolDomain}.${toolSuffix}`,
          description,
          parameters: { type: 'object', properties: {}, required: [] },
        })
      }
      return fc
        .subarray(params.map((p) => p.name), { minLength: 0 })
        .map<StaticToolDef>((requiredNames) => {
          const properties: Record<string, unknown> = {}
          for (const p of params) {
            properties[p.name] = { type: p.type, description: p.description }
          }
          return {
            name: `${toolDomain}.${toolSuffix}`,
            description,
            parameters: { type: 'object', properties, required: requiredNames },
          }
        })
    })
}


/**
 * arbitraryParsedAdapter — generates random adapter data with 1-10 tools,
 * random domains, and auth settings.
 */
function arbitraryParsedAdapter(): fc.Arbitrary<ParsedAdapter> {
  return fc
    .record({
      id: arbIdentifier,
      name: arbText,
      description: arbText,
      domains: fc.uniqueArray(arbDomain, { minLength: 1, maxLength: 5 }),
      homepageUrl: arbDomain.map((d) => `https://${d}/`),
      tools: fc.array(arbitraryStaticToolDef(), { minLength: 1, maxLength: 10 }),
      testPrompts: fc.constant<string[]>([]),
      requiresAuth: fc.boolean(),
      authCheckTool: fc.option(arbIdentifier, { nil: null }),
      hidden: fc.boolean(),
      defaultEnabled: fc.boolean(),
    })
    .map<ParsedAdapter>((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      match: r.domains,
      gateAliases: [],
      homepageUrl: r.homepageUrl,
      tools: r.tools,
      testPrompts: r.testPrompts,
      requiresAuth: r.requiresAuth,
      authCheckTool: r.requiresAuth ? r.authCheckTool : null,
      hidden: r.hidden,
      defaultEnabled: r.defaultEnabled,
      detailDescription: '',
      registryScenarios: [],
      routeTemplates: [],
      icon: 'globe',
      promptVarDisplay: {},
    }))
}

// --- Property Tests ---

// Feature: skill-based-adapter-architecture, Property 4: Skill content completeness
describe('Property 4: Skill content completeness', () => {
  it('describes per-command confirmation independently of write access', () => {
    const adapter = fc.sample(arbitraryParsedAdapter(), 1)[0]
    adapter.tools = [{ name: 'fixture.reserve', description: 'Reserve an item', parameters: {}, safety: 'write', requiresConfirmation: false }]
    expect(generateSkillContent(adapter)).toContain('Confirmation: not required')
    expect(generateSkillContent(adapter)).not.toContain('__confirmed')
    adapter.tools[0].requiresConfirmation = true
    expect(generateSkillContent(adapter)).toContain('Confirmation: required')
    expect(generateSkillContent(adapter)).toContain('__confirmed: true')
  })
  // **Validates: Requirements 2.2, 2.3, 6.1, 6.2, 6.3**

  it('(a) generated content contains YAML frontmatter with name and description', () => {
    fc.assert(
      fc.property(arbitraryParsedAdapter(), (adapter) => {
        const content = generateSkillContent(adapter)

        // Frontmatter must start with --- and be closed with ---
        expect(content).toMatch(/^---\n/)
        expect(content).toMatch(/^---\n[\s\S]*?\n---/m)

        // Name and description in frontmatter (with escaping applied)
        const escaped = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        expect(content).toContain(`name: "${escaped(adapter.name)}"`)
        expect(content).toContain(`description: "${escaped(adapter.description)}"`)
      }),
      { numRuns: 100 },
    )
  })

  it('(b) generated content contains all domain strings from adapter.match', () => {
    fc.assert(
      fc.property(arbitraryParsedAdapter(), (adapter) => {
        const content = generateSkillContent(adapter)

        for (const domain of adapter.match) {
          expect(content).toContain(domain)
        }
      }),
      { numRuns: 100 },
    )
  })

  it('(c) generated content contains adapter.homepageUrl', () => {
    fc.assert(
      fc.property(arbitraryParsedAdapter(), (adapter) => {
        const content = generateSkillContent(adapter)
        expect(content).toContain(adapter.homepageUrl)
      }),
      { numRuns: 100 },
    )
  })

  it('(d) generated content contains every tool.name from adapter.tools', () => {
    fc.assert(
      fc.property(arbitraryParsedAdapter(), (adapter) => {
        const content = generateSkillContent(adapter)

        for (const tool of adapter.tools) {
          expect(content).toContain(tool.name)
        }
      }),
      { numRuns: 100 },
    )
  })

  it('(e) generated content contains parameter name, type, and required/optional status for each tool parameter', () => {
    fc.assert(
      fc.property(arbitraryParsedAdapter(), (adapter) => {
        const content = generateSkillContent(adapter)

        for (const tool of adapter.tools) {
          const params = tool.parameters as {
            properties?: Record<string, { type?: string }>
            required?: string[]
          }
          const props = params.properties
          const requiredList = params.required ?? []

          if (props && Object.keys(props).length > 0) {
            for (const [paramName, schema] of Object.entries(props)) {
              // Parameter name appears in the content
              expect(content).toContain(paramName)
              // Type appears in the content
              const paramType = typeof schema.type === 'string' ? schema.type : 'string'
              expect(content).toContain(paramType)
              // Required/optional status: the row should contain 'Yes' or 'No'
              const isRequired = requiredList.includes(paramName)
              const statusStr = isRequired ? 'Yes' : 'No'
              // Find the table row for this parameter and verify it has the right status
              const rowPattern = new RegExp(
                `\\|\\s*${paramName}\\s*\\|\\s*${paramType}\\s*\\|\\s*${statusStr}\\s*\\|`,
              )
              expect(content).toMatch(rowPattern)
            }
          }
        }
      }),
      { numRuns: 100 },
    )
  })

  it('(f) generated content contains a "How to Use" section mentioning webcli call', () => {
    fc.assert(
      fc.property(arbitraryParsedAdapter(), (adapter) => {
        const content = generateSkillContent(adapter)

        expect(content).toContain('## How to Use')
        expect(content).toContain('webcli call')
      }),
      { numRuns: 100 },
    )
  })

  it('(g) generated content contains at least one example invocation per tool', () => {
    fc.assert(
      fc.property(arbitraryParsedAdapter(), (adapter) => {
        const content = generateSkillContent(adapter)

        for (const tool of adapter.tools) {
          // Each tool should have an example using its exact public name.
          expect(content).toContain(`webcli call '${tool.name}'`)
          expect(content).not.toMatch(/webcli call [^\n]* --args/)
          const required = (tool.parameters.required ?? []) as string[]
          for (const name of required) expect(content).toContain('--' + name + '=')
        }
      }),
      { numRuns: 100 },
    )
  })
})

// Feature: skill-based-adapter-architecture, Property 5: Auth instructions presence
describe('Property 5: Auth instructions presence', () => {
  // **Validates: Requirements 2.5**

  it('(a) auth section is present when requiresAuth=true', () => {
    const arbAuthAdapter = arbitraryParsedAdapter().filter((a) => a.requiresAuth)

    fc.assert(
      fc.property(arbAuthAdapter, (adapter) => {
        const content = generateSkillContent(adapter)
        expect(content).toContain('## Authentication')
      }),
      { numRuns: 100 },
    )
  })

  it('(b) auth section is absent when requiresAuth=false', () => {
    const arbNoAuthAdapter = arbitraryParsedAdapter().map<ParsedAdapter>((a) => ({
      ...a,
      requiresAuth: false,
      authCheckTool: null,
    }))

    fc.assert(
      fc.property(arbNoAuthAdapter, (adapter) => {
        const content = generateSkillContent(adapter)
        expect(content).not.toContain('## Authentication')
      }),
      { numRuns: 100 },
    )
  })

  it('(c) auth section references authCheckTool when configured and requiresAuth=true', () => {
    const arbAuthWithTool = arbitraryParsedAdapter()
      .filter((a) => a.requiresAuth && a.authCheckTool !== null)

    fc.assert(
      fc.property(arbAuthWithTool, (adapter) => {
        const content = generateSkillContent(adapter)
        expect(content).toContain('## Authentication')
        expect(content).toContain(adapter.authCheckTool!)
      }),
      { numRuns: 100 },
    )
  })
})

// Feature: skill-based-adapter-architecture, Property 6: Skill sync produces one file per enabled adapter
describe('Property 6: Skill sync produces one file per enabled adapter', () => {
  // **Validates: Requirements 2.1, 3.2**

  let tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // ignore cleanup errors
      }
    }
    tempDirs = []
  })

  it('after syncAllSkills(), skills directory contains exactly one subdirectory per enabled adapter with SKILL.md or SKILL.md.disabled', () => {
    fc.assert(
      fc.property(
        // Generate a unique-by-id array of adapters, then derive a Map and a random enabled subset
        fc.uniqueArray(arbitraryParsedAdapter(), { minLength: 0, maxLength: 8, selector: (a) => a.id })
          .chain((adapters) => {
            const ids = adapters.map((a) => a.id)
            return fc.tuple(
              fc.constant(adapters),
              fc.subarray(ids, { minLength: 0 }),
            )
          }),
        ([adapters, enabledIds]) => {
          // Setup
          const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-sync-p6-'))
          tempDirs.push(tmpDir)

          const adapterMap = new Map<string, ParsedAdapter>()
          for (const a of adapters) {
            adapterMap.set(a.id, a)
          }
          const enabledSet = new Set(enabledIds)

          // Act
          syncAllSkills(adapterMap, enabledSet, { skillsDir: tmpDir })

          // Assert: read subdirectories in the skills dir
          const entries = fs.readdirSync(tmpDir, { withFileTypes: true })
          const subdirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)

          // Exactly one subdirectory per enabled adapter
          expect(subdirs.sort()).toEqual([...enabledSet].sort())

          // Each enabled adapter subdirectory contains exactly SKILL.md or SKILL.md.disabled
          for (const id of enabledSet) {
            const adapterDir = path.join(tmpDir, id)
            const files = fs.readdirSync(adapterDir)
            const skillFiles = files.filter((f: string) => f === 'SKILL.md' || f === 'SKILL.md.disabled')
            expect(skillFiles).toHaveLength(1)
          }

          // No subdirectories for disabled adapters
          const disabledIds = adapters
            .map((a) => a.id)
            .filter((id) => !enabledSet.has(id))
          for (const id of disabledIds) {
            expect(subdirs).not.toContain(id)
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})

// Feature: skill-based-adapter-architecture, Property 7: Disabled Skill state preservation
describe('Property 7: Disabled Skill state preservation', () => {
  // **Validates: Requirements 3.3**

  let tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // ignore cleanup errors
      }
    }
    tempDirs = []
  })

  it('syncSkillForAdapter(adapter, true) updates SKILL.md.disabled content without renaming it back to SKILL.md', () => {
    fc.assert(
      fc.property(arbitraryParsedAdapter(), (adapter) => {
        // Setup: create a temp directory with a pre-existing SKILL.md.disabled file
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-sync-p7-'))
        tempDirs.push(tmpDir)

        const adapterDir = path.join(tmpDir, adapter.id)
        fs.mkdirSync(adapterDir, { recursive: true })

        const disabledPath = path.join(adapterDir, 'SKILL.md.disabled')
        const skillPath = path.join(adapterDir, 'SKILL.md')

        // Write old content to SKILL.md.disabled
        const oldContent = '---\nname: "old"\ndescription: "old content"\n---\n\n# Old Skill\n'
        fs.writeFileSync(disabledPath, oldContent, 'utf-8')

        // Act: sync with enabled=true
        syncSkillForAdapter(adapter, true, { skillsDir: tmpDir })

        // Assert: SKILL.md.disabled still exists (not renamed)
        expect(fs.existsSync(disabledPath)).toBe(true)

        // Assert: SKILL.md does NOT exist
        expect(fs.existsSync(skillPath)).toBe(false)

        // Assert: SKILL.md.disabled content has been updated
        const updatedContent = fs.readFileSync(disabledPath, 'utf-8')
        expect(updatedContent).not.toBe(oldContent)

        // Assert: updated content contains adapter name, tool names, etc.
        expect(updatedContent).toContain(adapter.name)
        for (const tool of adapter.tools) {
          expect(updatedContent).toContain(tool.name)
        }
      }),
      { numRuns: 100 },
    )
  })
})

// Feature: skill-based-adapter-architecture, Property 8: Orphan Skill removal
describe('Property 8: Orphan Skill removal', () => {
  // **Validates: Requirements 3.4**

  let tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // ignore cleanup errors
      }
    }
    tempDirs = []
  })

  it('orphan directories are removed after syncAllSkills() while adapter directories still exist', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(arbitraryParsedAdapter(), { minLength: 1, maxLength: 6, selector: (a) => a.id })
          .chain((adapters) => {
            const ids = adapters.map((a) => a.id)
            return fc.tuple(
              fc.constant(adapters),
              fc.subarray(ids, { minLength: 1 }),
              // Generate 1-5 orphan directory names that don't collide with adapter IDs
              fc.uniqueArray(
                arbIdentifier.filter((name) => !ids.includes(name)),
                { minLength: 1, maxLength: 5 },
              ),
            )
          }),
        ([adapters, enabledIds, orphanNames]) => {
          // Setup
          const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-sync-p8-'))
          tempDirs.push(tmpDir)

          // Pre-create orphan subdirectories
          for (const orphan of orphanNames) {
            const orphanDir = path.join(tmpDir, orphan)
            fs.mkdirSync(orphanDir, { recursive: true })
            // Put a dummy file inside so it's a non-empty directory
            fs.writeFileSync(path.join(orphanDir, 'SKILL.md'), 'orphan content', 'utf-8')
          }

          const adapterMap = new Map<string, ParsedAdapter>()
          for (const a of adapters) {
            adapterMap.set(a.id, a)
          }
          const enabledSet = new Set(enabledIds)

          // Act
          syncAllSkills(adapterMap, enabledSet, { skillsDir: tmpDir })

          // Assert: orphan directories are removed
          for (const orphan of orphanNames) {
            expect(fs.existsSync(path.join(tmpDir, orphan))).toBe(false)
          }

          // Assert: enabled adapter directories still exist
          for (const id of enabledIds) {
            expect(fs.existsSync(path.join(tmpDir, id))).toBe(true)
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})

// Feature: skill-based-adapter-architecture, Property 14: Skill generation round-trip
describe('Property 14: Skill generation round-trip', () => {
  // **Validates: Requirements 6.4**

  /**
   * Parse generated SKILL.md content to extract tool names (from ### headings
   * in the "Available Tools" section) and parameter names (from table rows
   * under each tool heading).
   */
  function parseSkillContent(content: string): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>()

    // Find the "## Available Tools" section
    const availableToolsMatch = content.match(/## Available Tools\n([\s\S]*?)(?=\n## (?!#)|\n$|$)/)
    if (!availableToolsMatch) return result

    const toolsSection = availableToolsMatch[1]

    // Split by ### headings to get individual tool sections
    const toolSections = toolsSection.split(/(?=^### )/m).filter((s) => s.startsWith('### '))

    for (const section of toolSections) {
      // Extract tool name from ### heading
      const headingMatch = section.match(/^### (.+)$/m)
      if (!headingMatch) continue
      const toolName = headingMatch[1].trim()

      // Extract parameter names from table rows: | paramName | type | Yes/No | description |
      const paramNames = new Set<string>()
      const tableRowRegex = /^\| ([a-z][a-z0-9_]*) \| \w+ \| (?:Yes|No) \| .* \|$/gm
      let rowMatch: RegExpExecArray | null
      while ((rowMatch = tableRowRegex.exec(section)) !== null) {
        paramNames.add(rowMatch[1])
      }

      result.set(toolName, paramNames)
    }

    return result
  }

  it('parsing generated skill content recovers original tool names and parameter names', () => {
    fc.assert(
      fc.property(arbitraryParsedAdapter(), (adapter) => {
        // Generate SKILL.md content
        const content = generateSkillContent(adapter)

        // Parse the generated content
        const parsed = parseSkillContent(content)

        // Verify extracted tool names match original adapter.tools[].name set
        const originalToolNames = new Set(adapter.tools.map((t) => t.name))
        const parsedToolNames = new Set(parsed.keys())
        expect(parsedToolNames).toEqual(originalToolNames)

        // Verify extracted parameter names for each tool match original properties keys
        for (const tool of adapter.tools) {
          const params = tool.parameters as { properties?: Record<string, unknown> }
          const originalParamNames = new Set(Object.keys(params.properties ?? {}))
          const parsedParamNames = parsed.get(tool.name) ?? new Set<string>()
          expect(parsedParamNames).toEqual(originalParamNames)
        }
      }),
      { numRuns: 100 },
    )
  })
})
