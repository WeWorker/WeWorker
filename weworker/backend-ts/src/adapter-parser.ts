/**
 * Static adapter parser — extracts tool definitions from adapter JS files
 * without executing them. Uses regex-based parsing to extract the
 * `window.__webmcpRegister({...})` call parameters.
 */
import fs from 'node:fs'
import { describeDesktopAdapters, resolveDesktopUserAdaptersDir } from '../../../webcli/adapter-desktop.js'
import type { DesktopAdapter } from '../../../webcli/adapter-desktop.js'
import path from 'node:path'
import { createLogger } from './logger.js'
import type { RegistryScenarioDef } from './site-scenarios.js'
import type { PromptVarDisplayMap } from './prompt-var-display.js'
import { mergePromptVarDisplay } from './prompt-var-display.js'
import { clearDesktopAdapterCatalogCache, getDesktopAdapterCatalog } from './adapter-catalog-cache.js'
import defaultSiteOrder from '../../default-site.json' with { type: 'json' }

const log = createLogger('adapter-parser')

export interface StaticToolDef {
  safety?: string
  requiresConfirmation?: boolean
  aliases?: string[]
  name: string
  description: string
  parameters: Record<string, unknown>  // JSON Schema
  execution?: ToolExecution
  directCapable?: boolean
  executionMode?: string
}

export interface ToolExecution {
  type?: 'api' | 'dom' | 'mixed' | string
  runtime?: 'background' | 'page' | 'node' | string
  /**
   * 该工具调用前必须先打开的页面 URL（page-prep 编排的唯一输入）。
   * manifest 里 `tool_execution` 是**按工具名索引的对象**（`{ [toolName]: {...} }`，不是数组），
   * 其 `navigate_before` 原样带进来；缺省 = 无页面依赖，page-prep 不动手（回到盲调行为）。
   */
  navigate_before?: string
}

/**
 * manifest 顶层 route_templates[] 条目（智能路由 Tier -2「模板直达」）。
 * pattern 语法：`${A|B|C}`（含 `|`）= 枚举槽（enumArgs 须覆盖全部分支词）；
 * `${名称}`（不含 `|`）= 自由文本槽（slots 须提供 {arg, validate}）。
 * 字段宽松可选——严格校验由 api-query-router/manifest-templates.ts 加载期完成，
 * 校验失败的模板整条跳过（warn+skip），不影响 adapter 其余功能。
 */
export interface ManifestRouteTemplateDef {
  id?: string
  pattern?: string
  tool?: string
  description?: string
  args?: Record<string, unknown>
  enumArgs?: Record<string, Record<string, unknown>>
  slots?: Record<string, { arg?: string; validate?: string; description?: string }>
}

export interface ParsedAdapter {
  managed?: DesktopAdapter['managed']
  id: string
  name: string
  description: string
  match: string[]
  /**
   * siteGate S2 信号词表（manifest 可选 `gate_aliases`）。拉丁词按 ASCII 字母数字判边界
   * （`XXTICKETSYY` 不命中 `tickets`），CJK 词直接子串。缺省 = 只靠域名信号，没有任何站点名推断。
   */
  gateAliases: string[]
  homepageUrl: string
  tools: StaticToolDef[]
  testPrompts: string[]
  requiresAuth: boolean
  authCheckTool: string | null
  toolExecution?: Record<string, ToolExecution>
  hidden: boolean
  defaultEnabled: boolean
  detailDescription: string
  registryScenarios: RegistryScenarioDef[]
  icon: string
  iconUrl?: string
  promptVarDisplay: PromptVarDisplayMap
  routeTemplates?: ManifestRouteTemplateDef[]
}

// Cache parsed results
let _cache: Map<string, ParsedAdapter> | null = null
let _registryDefaultIcon = 'globe'

type RegistryAdapterEntry = {
  id: string
  name?: string
  description?: string
  detail_description?: string
  match?: string[]
  gate_aliases?: string[]
  homepage_url?: string
  homepage?: string
  requires_auth?: boolean
  auth_check_tool?: string
  hidden?: boolean
  enabled?: boolean
  i18n?: { zh?: { name?: string; description?: string } }
  scenarios?: RegistryScenarioDef[]
  test_prompts?: string[]
  icon?: string
  prompt_var_display?: PromptVarDisplayMap
  route_templates?: ManifestRouteTemplateDef[]
  tool_execution?: Record<string, ToolExecution>
}

type AdapterManifest = RegistryAdapterEntry & {
  schema_version?: number
  author?: string
  version?: string
  verified_on?: string
  except?: string[]
  support_files?: string[]
}

type AdapterRegistry = {
  defaults?: { icon?: string; prompt_var_display?: PromptVarDisplayMap }
  adapters?: RegistryAdapterEntry[]
}

type BuildProfile = {
  adapters?: string[]
}

/**
 * Find the adapters directory from multiple candidate paths.
 */
function findAdaptersDir(): string | null {
  // WEWORKER_RESOURCES_PATH is set by Electron main process for packaged app
  const resourcesPath = process.env.WEWORKER_RESOURCES_PATH || ''

  const candidates = [
    // Packaged app: extension bundled in resources via extraResources
    ...(resourcesPath ? [path.join(resourcesPath, 'extension', 'adapters')] : []),
    // Development: cwd is weworker/backend-ts, project root is ../../
    path.join(process.cwd(), '..', '..', 'extension', 'adapters'),
    // Development: cwd might be weworker/
    path.join(process.cwd(), '..', 'extension', 'adapters'),
    // Relative to this source file location
    path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', 'extension', 'adapters'),
  ]

  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        // Check if it has at least one adapter subdirectory with manifest.json
        const entries = fs.readdirSync(dir)
        if (entries.some(e => fs.existsSync(path.join(dir, e, 'manifest.json')))) {
          return dir
        }
      }
    } catch { /* skip */ }
  }
  return null
}

/**
 * Use the host's stable profile-aware user root; legacy roots are migration inventory only.
 */
function findUserAdaptersDir(): string | null {
  const directory = resolveDesktopUserAdaptersDir()
  return fs.existsSync(directory) ? directory : null
}

function findBuildProfilePath(adaptersDir: string): string | null {
  const resourcesPath = process.env.WEWORKER_RESOURCES_PATH || ''
  const candidates = [
    ...(resourcesPath ? [path.join(resourcesPath, 'build-profile.json')] : []),
    path.join(process.cwd(), 'build-profile.json'),
    path.join(process.cwd(), '..', 'build-profile.json'),
    path.resolve(adaptersDir, '..', '..', 'weworker', 'build-profile.json'),
    path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'build-profile.json'),
  ]

  for (const file of candidates) {
    try {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file
    } catch { /* skip */ }
  }
  return null
}

function loadBuildProfileOrder(adaptersDir: string): string[] {
  const profilePath = findBuildProfilePath(adaptersDir)
  if (!profilePath) return []
  try {
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8')) as BuildProfile
    return Array.isArray(profile.adapters)
      ? profile.adapters.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map((id) => id.trim())
      : []
  } catch {
    return []
  }
}

function loadAdapterRegistry(adaptersDir: string): { byId: Map<string, RegistryAdapterEntry>; byMatch: Map<string, RegistryAdapterEntry>; defaults: AdapterRegistry['defaults']; order: string[] } {
  const registryPath = path.join(adaptersDir, 'registry.json')
  const byId = new Map<string, RegistryAdapterEntry>()
  const byMatch = new Map<string, RegistryAdapterEntry>()
  const buildProfileOrder = loadBuildProfileOrder(adaptersDir)
  if (!fs.existsSync(registryPath)) return { byId, byMatch, defaults: {}, order: buildProfileOrder }
  try {
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8')) as AdapterRegistry
    _registryDefaultIcon = registry.defaults?.icon?.trim() || 'globe'
    const registryOrder = (registry.adapters ?? []).map((adapter) => adapter.id).filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    for (const adapter of registry.adapters ?? []) {
      if (adapter.id) byId.set(adapter.id, adapter)
      for (const match of adapter.match ?? []) {
        byMatch.set(match, adapter)
      }
    }
    return { byId, byMatch, defaults: registry.defaults ?? {}, order: buildProfileOrder.length > 0 ? buildProfileOrder : registryOrder }
  } catch (e) {
    log.warn('Failed to read registry.json:', e)
    return { byId, byMatch, defaults: {}, order: buildProfileOrder }
  }
}

/**
 * Extract tool definitions from a single adapter JS file.
 */
function parseAdapterFile(filePath: string): StaticToolDef[] {
  const tools: StaticToolDef[] = []
  try {
    const source = fs.readFileSync(filePath, 'utf-8')

    const registerMatch = source.match(/window\.__webmcpRegister\s*\(\s*\{/)
    if (!registerMatch) return tools

    const afterRegister = source.slice(registerMatch.index!)
    const toolsArrayMatch = afterRegister.match(/tools\s*:\s*\[/)
    if (!toolsArrayMatch) return tools

    const toolsStart = registerMatch.index! + toolsArrayMatch.index! + toolsArrayMatch[0].length
    const remaining = source.slice(toolsStart)

    // Find each tool by its name field
    const toolNameRe = /\{\s*\n?\s*name\s*:\s*['"`]([^'"`]+)['"`]/g
    let match: RegExpExecArray | null

    while ((match = toolNameRe.exec(remaining)) !== null) {
      const toolName = match[1]
      const block = remaining.slice(match.index)
      const metadataEnd = [block.search(/parameters\s*:/), block.search(/handler\s*:/)]
        .filter((index) => index > 0)
        .sort((a, b) => a - b)[0] ?? Math.min(block.length, 2000)
      const metadataBlock = block.slice(0, metadataEnd)
      const publicName = metadataBlock.match(/publicName\s*:\s*['"`]([^'"`]+)['"`]/)?.[1] || toolName

      // Extract description (single-quoted, double-quoted, or template literal)
      let description = ''
      const descSingle = block.match(/description\s*:\s*\n?\s*'([^']*(?:'\s*\+\s*'[^']*)*)'/)
      const descDouble = block.match(/description\s*:\s*\n?\s*"([^"]*)"/)
      const descTmpl = block.match(/description\s*:\s*\n?\s*`([^`]*)`/)
      if (descSingle) {
        description = descSingle[1].replace(/'\s*\+\s*'/g, '')
      } else if (descDouble) {
        description = descDouble[1]
      } else if (descTmpl) {
        description = descTmpl[1].replace(/\s+/g, ' ').trim()
      }

      const parameters = extractParameters(block)
      if (publicName) tools.push({ name: publicName, description, parameters })
    }
  } catch (e) {
    log.warn(`Failed to parse ${filePath}:`, e)
  }
  return tools
}

/**
 * Extract the parameters JSON Schema from a tool definition block.
 */
function extractParameters(block: string): Record<string, unknown> {
  const paramMatch = block.match(/parameters\s*:\s*\{/)
  if (!paramMatch) return { type: 'object', properties: {}, required: [] }

  const start = paramMatch.index! + paramMatch[0].length - 1
  let depth = 0
  let end = start
  for (let i = start; i < block.length; i++) {
    if (block[i] === '{') depth++
    else if (block[i] === '}') {
      depth--
      if (depth === 0) { end = i + 1; break }
    }
  }

  const paramStr = block.slice(start, end)
  try {
    let jsonStr = paramStr
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/(\{|,)\s*(\w+)\s*:/g, '$1"$2":')
      .replace(/'/g, '"')
    return JSON.parse(jsonStr)
  } catch {
    return extractParametersManual(paramStr)
  }
}

function extractParametersManual(paramStr: string): Record<string, unknown> {
  const result: Record<string, unknown> = { type: 'object', properties: {}, required: [] }
  const properties: Record<string, unknown> = {}
  const required: string[] = []

  const propsMatch = paramStr.match(/properties\s*:\s*\{/)
  if (propsMatch) {
    const propsBlock = paramStr.slice(propsMatch.index! + propsMatch[0].length)
    const propRe = /(\w+)\s*:\s*\{([^}]*)\}/g
    let m: RegExpExecArray | null
    while ((m = propRe.exec(propsBlock)) !== null) {
      const prop: Record<string, unknown> = {}
      const typeMatch = m[2].match(/type\s*:\s*['"`](\w+)['"`]/)
      if (typeMatch) prop.type = typeMatch[1]
      const descMatch = m[2].match(/description\s*:\s*['"`]([^'"`]*)['"`]/)
      if (descMatch) prop.description = descMatch[1]
      const enumMatch = m[2].match(/enum\s*:\s*\[([^\]]*)\]/)
      if (enumMatch) {
        prop.enum = enumMatch[1].split(',').map(s => s.trim().replace(/^['"`]|['"`]$/g, '')).filter(Boolean)
      }
      properties[m[1]] = prop
    }
  }

  const reqMatch = paramStr.match(/required\s*:\s*\[([^\]]*)\]/g)
  if (reqMatch) {
    // 取最后一个 required 数组（顶层的，跳过嵌套在 items 里的）
    const lastReq = reqMatch[reqMatch.length - 1]
    const innerMatch = lastReq.match(/\[([^\]]*)\]/)
    if (innerMatch) {
      required.push(...innerMatch[1].split(',').map(s => s.trim().replace(/^['"`]|['"`]$/g, '')).filter(Boolean))
    }
  }

  result.properties = properties
  result.required = required
  return result
}

/**
 * 解析单个 adapter 目录，写入 result Map。
 * @param adaptersDir 内置或用户 adapter 目录
 * @param registry 内置 registry（用户目录无 registry，传空）
 * @param defaultVarDisplay 默认 prompt var display
 * @param result 写入目标 Map
 */
function parseAdaptersFromDir(
  adaptersDir: string,
  registry: ReturnType<typeof loadAdapterRegistry>,
  defaultVarDisplay: PromptVarDisplayMap,
  result: Map<string, ParsedAdapter>,
): void {
  let entries: string[]
  try {
    entries = fs.readdirSync(adaptersDir).filter(d => {
      const manifestPath = path.join(adaptersDir, d, 'manifest.json')
      return fs.statSync(path.join(adaptersDir, d)).isDirectory() && fs.existsSync(manifestPath)
    })
  } catch {
    log.warn(`Failed to read adapters directory: ${adaptersDir}`)
    return
  }

  for (const dir of entries) {
    try {
      const manifestPath = path.join(adaptersDir, dir, 'manifest.json')
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as AdapterManifest
      if (manifest.schema_version === 2) continue

      const indexPath = path.join(adaptersDir, dir, 'index.js')
      let tools: StaticToolDef[] = []
      if (fs.existsSync(indexPath)) {
        tools = parseAdapterFile(indexPath)
      }

      const adapterId = manifest.id || dir
      const registryEntry = registry.byId.get(adapterId) || registry.byMatch.get((manifest.match || [dir])[0])
      const toolExecution = {
        ...(registryEntry?.tool_execution || {}),
        ...(manifest.tool_execution || {}),
      }
      tools = tools.map((tool) => {
        const execution = toolExecution[tool.name]
        if (!execution) return tool
        const direct = execution.type === 'api' && execution.runtime === 'background'
        return {
          ...tool,
          execution,
          ...(direct ? { directCapable: true, executionMode: 'direct' } : {}),
        }
      })
      result.set(adapterId, {
        id: adapterId,
        name: manifest.i18n?.zh?.name || manifest.name || registryEntry?.i18n?.zh?.name || registryEntry?.name || adapterId,
        description: manifest.i18n?.zh?.description || manifest.description || registryEntry?.i18n?.zh?.description || registryEntry?.description || '',
        detailDescription: manifest.detail_description?.trim() || registryEntry?.detail_description?.trim() || '',
        match: manifest.match || registryEntry?.match || [dir],
        gateAliases: manifest.gate_aliases ?? registryEntry?.gate_aliases ?? [],
        homepageUrl: manifest.homepage_url || registryEntry?.homepage_url || `http://${(manifest.match || [dir])[0]}/`,
        tools,
        testPrompts: manifest.test_prompts ?? registryEntry?.test_prompts ?? [],
        requiresAuth: manifest.requires_auth ?? registryEntry?.requires_auth ?? false,
        authCheckTool: manifest.auth_check_tool ?? registryEntry?.auth_check_tool ?? null,
        toolExecution,
        hidden: manifest.hidden ?? registryEntry?.hidden ?? false,
        defaultEnabled: (manifest.enabled ?? registryEntry?.enabled) !== false,
        registryScenarios: manifest.scenarios ?? registryEntry?.scenarios ?? [],
        routeTemplates: manifest.route_templates ?? registryEntry?.route_templates ?? [],
        icon: manifest.icon?.trim() || registryEntry?.icon?.trim() || registry.defaults?.icon?.trim() || 'globe',
        promptVarDisplay: mergePromptVarDisplay(
          defaultVarDisplay,
          manifest.prompt_var_display ?? registryEntry?.prompt_var_display,
        ),
      })
    } catch { /* skip malformed adapter */ }
  }
}

/**
 * Cache only old-format compatibility metadata. Managed inventory is applied
 * separately on every read, including disabled and quarantined package names.
 */
function parseLegacyAdapters(): Map<string, ParsedAdapter> {
  if (_cache) return _cache

  const adaptersDir = findAdaptersDir()

  const result = new Map<string, ParsedAdapter>()
  const registry: ReturnType<typeof loadAdapterRegistry> = adaptersDir ? loadAdapterRegistry(adaptersDir) : { byId: new Map(), byMatch: new Map(), defaults: {}, order: [] as string[] }
  const defaultVarDisplay = registry.defaults?.prompt_var_display ?? {}

  // 先扫内置目录，再扫用户目录（用户优先）
  if (adaptersDir) parseAdaptersFromDir(adaptersDir, registry, defaultVarDisplay, result)
  const userAdaptersDir = findUserAdaptersDir()
  if (userAdaptersDir) {
    const emptyRegistry = { byId: new Map(), byMatch: new Map(), defaults: {}, order: [] as string[] }
    parseAdaptersFromDir(userAdaptersDir, emptyRegistry, defaultVarDisplay, result)
  }

  const ordered = new Map<string, ParsedAdapter>()
  for (const id of registry.order) {
    const adapter = result.get(id)
    if (adapter) ordered.set(id, adapter)
  }
  for (const [id, adapter] of result) {
    if (!ordered.has(id)) ordered.set(id, adapter)
  }

  _cache = ordered
  const totalTools = [...ordered.values()].reduce((n, a) => n + a.tools.length, 0)
  log.info(`Parsed ${ordered.size} adapters, ${totalTools} tools total`)
  return ordered
}

/** Managed metadata is refreshed on every read; the compatibility cache cannot override it. */
export function parseAllAdapters(): Map<string, ParsedAdapter> {
  // The shared snapshot is rebuilt whenever registry state or package roots change.
  const inventory = describeDesktopAdapters({ catalog: getDesktopAdapterCatalog() })
  const result = new Map(parseLegacyAdapters())
  for (const manifest of inventory.adapters) {
    // 已存在的同名条目（v1 遗留 registry 路径）在桌面 manifest 未声明 gate_aliases 时继续供词表，
    // 避免两套注册路径下同一站点信号表现不一致。
    const legacy = result.get(manifest.id)
    result.set(manifest.id, {
      id: manifest.id, name: manifest.i18n?.zh?.name || manifest.display || manifest.name,
      description: manifest.i18n?.zh?.description || manifest.description || '',
      // Site domains (v2 `domains`) are also site signals and open_browser origins.
      detailDescription: manifest.description || '', match: [...new Set([...(manifest.match || []), ...(manifest.domains || [])])],
      gateAliases: manifest.gate_aliases ?? legacy?.gateAliases ?? [],
      homepageUrl: manifest.homepage_url || (manifest.match?.[0] ? 'https://' + manifest.match[0].replace(/^\*\./, '') + '/' : ''),
      tools: manifest.commands.map(command => ({ name: command.name, aliases: (command.aliases || []).map(alias => manifest.name + '.' + alias),
        ...(command.execution ? { execution: command.execution, directCapable: true, executionMode: 'direct' as const } : {}),
        safety: command.safety, requiresConfirmation: command.requires_confirmation ?? command.safety === 'write',
        description: command.description, parameters: command.schema })),
      testPrompts: manifest.test_prompts || [], requiresAuth: manifest.requires_auth === true,
      authCheckTool: manifest.auth_check_tool || null, hidden: manifest.hidden === true,
      defaultEnabled: manifest.managed.enabled, managed: manifest.managed,
      registryScenarios: (manifest.scenarios || []) as RegistryScenarioDef[],
      routeTemplates: (manifest.route_templates || []) as ManifestRouteTemplateDef[],
      icon: manifest.icon || 'globe', promptVarDisplay: mergePromptVarDisplay({}, manifest.prompt_var_display),
      iconUrl: manifest.iconUrl,
    })
  }
  const ordered = new Map<string, ParsedAdapter>()
  for (const entry of defaultSiteOrder as Array<string | { id: string; enabled?: boolean }>) {
    const id = typeof entry === 'string' ? entry : entry.id
    const adapter = result.get(id)
    if (adapter) ordered.set(id, adapter)
  }
  // Installed sites outside the defaults remain available in inventory order.
  for (const [id, adapter] of result) {
    if (!ordered.has(id)) ordered.set(id, adapter)
  }
  return ordered
}

/** Clear the cache (useful for testing or hot-reload) */
export function clearAdapterCache(): void {
  _cache = null
  clearDesktopAdapterCatalogCache()
}

export function getRegistryDefaultIcon(): string {
  parseAllAdapters()
  return _registryDefaultIcon
}

export function getRegistryIconById(): Record<string, string> {
  return Object.fromEntries([...parseAllAdapters().values()].map((a) => [a.id, a.icon]))
}
