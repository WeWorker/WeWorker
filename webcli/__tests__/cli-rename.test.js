// Feature: webcli-and-skill-architecture, Property 1: CLI 输出文本不包含旧名称
// Feature: webcli-and-skill-architecture, Property 6: 日志前缀统一更新
// **Validates: Requirements 1.1, 1.4, 2.1, 2.2, 8.2, 9.1, 9.4**

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const WEBCLI_DIR = resolve(__dirname, '..')

const indexSource = readFileSync(resolve(WEBCLI_DIR, 'index.js'), 'utf8')
const bridgeSource = readFileSync(resolve(WEBCLI_DIR, 'bridge.js'), 'utf8')
const pkg = JSON.parse(readFileSync(resolve(WEBCLI_DIR, 'package.json'), 'utf8'))

// Extract the HELP constant from index.js source.
// It's a template literal assigned to `const HELP = \`...\`.trim()`
function extractHelp(source) {
  const match = source.match(/const HELP\s*=\s*`([\s\S]*?)`\.trim\(\)/)
  return match ? match[1] : ''
}

const helpText = extractHelp(indexSource)

describe('Property 1: CLI 输出文本不包含旧名称', () => {
  it('mcp-server.js file does NOT exist in webcli/', () => {
    expect(existsSync(resolve(WEBCLI_DIR, 'mcp-server.js'))).toBe(false)
  })

  it('help text does NOT contain "webmcp" as a command name', () => {
    // WEBMCP_HUB env var is intentionally kept — exclude it from the check
    const helpWithoutEnvVar = helpText.replace(/WEBMCP_HUB/g, '')
    expect(helpWithoutEnvVar).not.toMatch(/webmcp/i)
  })

  it('help text does NOT contain "mcp-logs"', () => {
    expect(helpText).not.toContain('mcp-logs')
  })

  it('package.json does NOT contain @modelcontextprotocol/sdk', () => {
    const deps = pkg.dependencies || {}
    const devDeps = pkg.devDependencies || {}
    expect(deps).not.toHaveProperty('@modelcontextprotocol/sdk')
    expect(devDeps).not.toHaveProperty('@modelcontextprotocol/sdk')
  })

  it('package.json bin field is {"webcli": ...} (not {"webmcp": ...})', () => {
    expect(pkg.bin).toHaveProperty('webcli')
    expect(pkg.bin).not.toHaveProperty('webmcp')
  })

  it('package.json uses the public package name (not "webmcp-adapter")', () => {
    expect(pkg.name).toBe('weworker-webcli')
    expect(pkg.name).not.toContain('webmcp')
  })
})

describe('Property 6: 日志前缀统一更新', () => {
  it('webcli/index.js source does NOT contain "[WebMCP]"', () => {
    expect(indexSource).not.toContain('[WebMCP]')
  })

  it('webcli/index.js 日志前缀统一由 cliName.js 派生(webgo 包输出 [WebGo],webcli 包输出 [WebCLI])', () => {
    // 品牌自适应:前缀不再硬编码 [WebCLI],统一经 cliLabel() 按包身份派生
    expect(indexSource).toContain('cliLabel()')
    expect(indexSource).not.toContain('[WebCLI]')
    expect(indexSource).not.toContain('[WebMCP]')
  })

  it('webcli/bridge.js source does NOT contain "[WebMCP]"', () => {
    expect(bridgeSource).not.toContain('[WebMCP]')
  })

  it('webcli/bridge.js uses "[Bridge]" prefix only', () => {
    expect(bridgeSource).toContain('[Bridge]')
  })
})
