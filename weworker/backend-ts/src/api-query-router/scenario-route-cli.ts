/**
 * `gen:routes` 的 CLI 实现（详见 docs/intelligent_routing_design.md §3.3）。
 *
 * **单一真源**：本文件与运行时加载器共用 `scenario-route-compiler.ts`，因此「编译脚本说
 * 写出来的」和「运行时会认的」永远是同一份。`weworker/scripts/gen-routes.mjs` 只是薄启动器
 * （esbuild 打包本文件后动态导入），避免出现第二套实现漂移。
 *
 * 读：根 `<repo>/adapters/<domain>/manifest.json`（公开内置适配器）。
 * 写：`<router-config>/scenario-routes.json`（进 git、可 diff、可评审）。
 *
 * 退出码：0 成功；1 编译错误或 `--check` 不一致；2 用法错误。
 * `--check` 用于 CI 硬门：产物与源不一致即失败，杜绝「改了 manifest 忘了重跑」。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildCompileInputFromManifest,
  checkRouteTemplates,
  compileScenarioRoutes,
  type CompileAdapterInput,
} from './scenario-route-compiler.js'
import type { CompiledScenarioRoute, PlanTerminalsFile, ScenarioRoutesFile } from '../router-config/types.js'
import { expandAdapterGroupedField } from '../router-config/adapter-grouped.js'
import { parseJsonc } from '../router-config/jsonc.js'
import type { ManifestRouteTemplateDef } from '../adapter-parser.js'

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
/** 开发态：`weworker/backend-ts/src/api-query-router` → 仓库根 */
export const DEFAULT_REPO_ROOT = path.resolve(MODULE_DIR, '..', '..', '..', '..')

export type CliOptions = {
  adaptersDir: string
  outFile: string
  planTerminalsFile: string
  check: boolean
  json: boolean
  /** 供 Profile Overlay 使用：额外把配置层已声明的工具算进规则 ④ 冲突告警 */
  extraConfiguredTools: string[]
}

export type CliResult = {
  exitCode: number
  lines: string[]
}

function readJson(filePath: string): unknown | null {
  try {
    // 与 runtime loader 同一口径：JSONC（允许注释与尾逗号），避免「CLI 能读、运行时读不了」。
    return parseJsonc(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

/** 枚举 `<adaptersDir>/*\/manifest.json`；跳过扩展旧清单目录与隐藏目录。 */
export function listManifestDirs(adaptersDir: string): { dirName: string; manifestPath: string }[] {
  let names: string[]
  try {
    names = fs.readdirSync(adaptersDir)
  } catch {
    return []
  }
  const out: { dirName: string; manifestPath: string }[] = []
  for (const name of names.sort()) {
    if (name.startsWith('.') || name.startsWith('_')) continue
    const manifestPath = path.join(adaptersDir, name, 'manifest.json')
    try {
      if (!fs.statSync(manifestPath).isFile()) continue
    } catch {
      continue
    }
    out.push({ dirName: name, manifestPath })
  }
  return out
}

export type CollectedInputs = {
  inputs: CompileAdapterInput[]
  templates: { adapterId: string; defs: readonly ManifestRouteTemplateDef[] }[]
  /** 保留了 route/route_templates 声明的 adapter，用于稳定排序与冲突告警 */
  configuredTools: string[]
}

/** 读全部 manifest 并构造编译输入（CLI 路径不依赖运行时 profile / 状态目录）。 */
export function collectInputs(adaptersDir: string): CollectedInputs {
  const inputs: CompileAdapterInput[] = []
  const templates: CollectedInputs['templates'] = []
  const configuredTools: string[] = []

  for (const { dirName, manifestPath } of listManifestDirs(adaptersDir)) {
    const raw = readJson(manifestPath)
    if (!raw || typeof raw !== 'object') continue
    const input = buildCompileInputFromManifest(dirName, raw)
    inputs.push(input)
    for (const tool of input.tools) configuredTools.push(`${input.adapterId}.${tool.name}`)
    const record = raw as Record<string, unknown>
    if (Array.isArray(record.route_templates)) {
      templates.push({ adapterId: input.adapterId, defs: record.route_templates as ManifestRouteTemplateDef[] })
    }
  }
  return { inputs, templates, configuredTools }
}

/** 产物规范化：去掉时间戳后序列化，供 `--check` 逐字符比对（时间只影响可读性，不影响语义）。 */
export function stableRoutesJson(routes: readonly CompiledScenarioRoute[]): string {
  return JSON.stringify(routes, null, 2)
}

export function buildRoutesFile(routes: readonly CompiledScenarioRoute[], generatedAt: string): ScenarioRoutesFile {
  return { version: 2, generatedAt, routes: [...routes] }
}

/** 手写层已配置的工具（用于规则 ④ 的冲突告警）。读不到就当没有：告警本身不影响产物。 */
export function readConfiguredTools(routerConfigDir: string): string[] {
  const tools: string[] = []
  for (const [file, field] of [
    ['routes.json', 'routes'],
    ['aliases.json', 'aliases'],
    ['shortcuts.json', 'shortcuts'],
  ] as const) {
    // 配置支持「按 Adapter 分节」书写，这里必须与 runtime loader 用同一口径展开，
    // 否则分节形态下会读不到任何工具，规则 ④ 的冲突告警静默失效。
    const raw = expandAdapterGroupedField(readJson(path.join(routerConfigDir, file)), field).raw
    const list = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[field] : null
    if (!Array.isArray(list)) continue
    for (const item of list) {
      const tool = item && typeof item === 'object' ? (item as Record<string, unknown>).tool : null
      if (typeof tool === 'string' && tool) tools.push(tool)
    }
  }
  return [...new Set(tools)]
}

export function runScenarioRouteCli(options: CliOptions): CliResult {
  const lines: string[] = []
  const { inputs, templates } = collectInputs(options.adaptersDir)
  if (!inputs.length) {
    lines.push(`[gen:routes] no manifests under ${options.adaptersDir}`)
    return { exitCode: 1, lines }
  }

  const planTerminals = readJson(options.planTerminalsFile) as PlanTerminalsFile | null
  const planTerminalsFile = planTerminals && typeof planTerminals === 'object' ? planTerminals : null
  const configuredTools = [...options.extraConfiguredTools, ...readConfiguredTools(path.dirname(options.outFile))]

  const result = compileScenarioRoutes(inputs, { planTerminals: planTerminalsFile, configuredTools })
  const templateErrors = checkRouteTemplates(inputs, templates)

  lines.push(
    `[gen:routes] adapters=${result.stats.adapters} scenariosWithRoute=${result.stats.scenariosWithRoute} ` +
      `tool=${result.stats.byShape.tool} plan=${result.stats.byShape.plan} optout=${result.stats.byShape.optout}`,
  )
  for (const warning of result.warnings) lines.push(`[gen:routes] warning: ${warning}`)
  for (const error of [...result.errors, ...templateErrors]) lines.push(`[gen:routes] error: ${error}`)

  const errors = [...result.errors, ...templateErrors]
  if (errors.length) return { exitCode: 1, lines }

  const nextJson = stableRoutesJson(result.routes)
  const previous = readJson(options.outFile) as ScenarioRoutesFile | null
  const previousJson = previous && Array.isArray(previous.routes) ? stableRoutesJson(previous.routes) : null

  if (options.check) {
    if (previousJson !== nextJson) {
      lines.push(
        `[gen:routes] check failed: ${options.outFile} 与 manifest 不一致（源改了但产物未重跑）——请执行 npm run gen:routes`,
      )
      return { exitCode: 1, lines }
    }
    lines.push(`[gen:routes] check ok: ${options.outFile}`)
    return { exitCode: 0, lines }
  }

  if (previousJson === nextJson) {
    lines.push(`[gen:routes] up to date: ${options.outFile}`)
    return { exitCode: 0, lines }
  }

  const file: ScenarioRoutesFile = buildRoutesFile(result.routes, new Date().toISOString())
  try {
    fs.mkdirSync(path.dirname(options.outFile), { recursive: true })
    fs.writeFileSync(options.outFile, `${JSON.stringify(file, null, 2)}\n`, 'utf-8')
  } catch (error) {
    lines.push(`[gen:routes] write failed: ${error instanceof Error ? error.message : String(error)}`)
    return { exitCode: 1, lines }
  }
  lines.push(`[gen:routes] wrote ${result.routes.length} routes → ${options.outFile}`)
  return { exitCode: 0, lines }
}

// ── argv 解析（不依赖第三方库：脚本要能在最小环境里跑）────────────────────────

export function parseArgs(argv: readonly string[], defaults: Partial<CliOptions> = {}): CliOptions | { error: string } {
  const repoRoot = defaults.adaptersDir
    ? path.resolve(defaults.adaptersDir, '..', '..')
    : DEFAULT_REPO_ROOT
  const options: CliOptions = {
    adaptersDir: defaults.adaptersDir ?? path.join(repoRoot, 'adapters'),
    outFile:
      defaults.outFile ??
      path.join(process.env.WEWORKER_ROUTER_CONFIG_DIR ?? path.join(repoRoot, 'weworker', 'router-config'), 'scenario-routes.json'),
    planTerminalsFile:
      defaults.planTerminalsFile ??
      path.join(process.env.WEWORKER_ROUTER_CONFIG_DIR ?? path.join(repoRoot, 'weworker', 'router-config'), 'plan-terminals.json'),
    check: false,
    json: false,
    extraConfiguredTools: [],
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--check') {
      options.check = true
      continue
    }
    if (arg === '--json') {
      options.json = true
      continue
    }
    const takesValue: Record<string, (value: string) => void> = {
      '--adapters': (value) => {
        options.adaptersDir = path.resolve(value)
      },
      '--out': (value) => {
        options.outFile = path.resolve(value)
      },
      '--plan-terminals': (value) => {
        options.planTerminalsFile = path.resolve(value)
      },
    }
    const consume = takesValue[arg]
    if (consume) {
      const value = argv[index + 1]
      if (value === undefined) return { error: `${arg} requires a value` }
      consume(value)
      index += 1
      continue
    }
    return { error: `unknown argument: ${arg}` }
  }
  return options
}

/** 供薄启动器调用：解析 argv、跑编译、打印结果、返回退出码。 */
export function main(argv: readonly string[], defaults: Partial<CliOptions> = {}): number {
  const parsed = parseArgs(argv, defaults)
  if ('error' in parsed) {
    process.stderr.write(`[gen:routes] ${parsed.error}\n`)
    return 2
  }
  const result = runScenarioRouteCli(parsed)
  const sink = result.exitCode === 0 ? process.stdout : process.stderr
  if (parsed.json) {
    sink.write(`${JSON.stringify({ exitCode: result.exitCode, messages: result.lines }, null, 2)}\n`)
  } else {
    for (const line of result.lines) sink.write(`${line}\n`)
  }
  return result.exitCode
}
