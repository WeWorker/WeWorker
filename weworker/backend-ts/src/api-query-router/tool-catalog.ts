/**
 * 直调工具目录（详见 docs/intelligent_routing_design.md §4「工具目录」与 §7 红线）。
 *
 * 职责：
 * - 汇总当前已启用 adapter 的全部工具，标注「可直调」与「只读」；
 * - 按 adapter 目录 mtime 失效重建（改 manifest → 下次路由决策即生效，不重启进程）；
 * - 路由面准入硬门：**写操作不得进路由面**，只读性只认工具自述的 safety，缺省即不放行。
 *
 * 与既有 `query-router/configurable-query-route.ts` 的 `listDefaultCatalogTools()` 保持一致：
 * 两者共用同一「可直调」判据，避免同仓出现两套口径。
 */

import fs from 'node:fs'
import path from 'node:path'
import { parseAllAdapters, type ParsedAdapter, type StaticToolDef } from '../adapter-parser.js'
import { findAdaptersDirectory, resolveToolsForAdapter } from '../adapter-tool-list.js'
import { getSiteEnabled } from '../config.js'

export type CatalogTool = {
  /** 全名 `<adapterId>.<tool>` */
  name: string
  adapterId: string
  description: string
  /** 参数 JSON Schema */
  parameters: Record<string, unknown>
  /** `read` / `write` / 其它；undefined 表示工具未自述 */
  safety?: string
  /** 可直调：execution 声明为 api+background，或工具显式声明 direct */
  direct: boolean
  requiresConfirmation: boolean
  aliases: string[]
  /**
   * 该工具调用前必须先打开的页面 URL（manifest `tool_execution[<工具名>].navigate_before`）。
   * 唯一消费者是 `page-prep.ts`：缺省 = 无页面依赖，page-prep 不动手（回到「今天盲调」行为）。
   */
  navigateBefore?: string
}

export type ToolCatalog = {
  tools: CatalogTool[]
  directTools: CatalogTool[]
  byName: Map<string, CatalogTool>
  /** 当前已启用 adapter 的 id 集合，用于 router-config 作用域过滤 */
  adapterIds: Set<string>
}

const EMPTY_CATALOG: ToolCatalog = {
  tools: [],
  directTools: [],
  byName: new Map(),
  adapterIds: new Set(),
}

/**
 * 可直调判据：三选一即成立。
 * 与 `configurable-query-route.ts` 的 `isDirectCapable` 同口径。
 */
export function isDirectTool(adapter: ParsedAdapter, tool: StaticToolDef): boolean {
  const execution = adapter.toolExecution?.[tool.name] ?? tool.execution
  return (
    (execution?.type === 'api' && execution?.runtime === 'background') ||
    tool.directCapable === true ||
    tool.executionMode === 'direct'
  )
}

/**
 * 只读准入：必须**显式**声明 `safety: 'read'`。
 * 缺 safety 的工具读写不可区分，不得默认放行——否则写操作可能被当成只读直连（§7 红线）。
 */
export function isReadOnlyTool(tool: CatalogTool): boolean {
  return tool.safety === 'read' && tool.requiresConfirmation !== true
}

/** 工具全名：adapter id 已是前缀时不重复拼接。 */
export function qualifiedToolName(adapterId: string, toolName: string): string {
  return toolName.startsWith(`${adapterId}.`) ? toolName : `${adapterId}.${toolName}`
}

export function buildCatalog(adaptersDir: string | null = findAdaptersDirectory()): ToolCatalog {
  let adapters: Map<string, ParsedAdapter>
  try {
    adapters = parseAllAdapters()
  } catch {
    return EMPTY_CATALOG
  }

  const tools: CatalogTool[] = []
  const adapterIds = new Set<string>()
  for (const adapter of adapters.values()) {
    if (!getSiteEnabled(adapter.id, adapter.defaultEnabled, adapter.managed?.enabled)) continue
    adapterIds.add(adapter.id)
    let resolved: StaticToolDef[] = adapter.tools
    try {
      resolved = resolveToolsForAdapter(adapter, adaptersDir)
    } catch {
      // 读取失败时退回 manifest 声明的工具，不让整个目录为空
    }
    for (const tool of resolved) {
      const execution = adapter.toolExecution?.[tool.name] ?? tool.execution
      const navigateBefore =
        typeof execution?.navigate_before === 'string' ? execution.navigate_before.trim() : ''
      tools.push({
        name: qualifiedToolName(adapter.id, tool.name),
        adapterId: adapter.id,
        description: tool.description ?? '',
        parameters: tool.parameters ?? {},
        safety: tool.safety,
        direct: isDirectTool(adapter, tool),
        requiresConfirmation: tool.requiresConfirmation === true,
        aliases: tool.aliases ?? [],
        ...(navigateBefore ? { navigateBefore } : {}),
      })
    }
  }

  const byName = new Map<string, CatalogTool>()
  for (const tool of tools) byName.set(tool.name, tool)
  return {
    tools,
    directTools: tools.filter((tool) => tool.direct),
    byName,
    adapterIds,
  }
}

/** adapters 目录签名（mtime+size），用于热重载失效判定。 */
function adaptersSignature(adaptersDir: string | null): string {
  if (!adaptersDir) return '-'
  try {
    const stat = fs.statSync(adaptersDir)
    const names = fs.readdirSync(adaptersDir).sort()
    return `${adaptersDir}:${stat.mtimeMs}:${names.length}:${names.join(',')}`
  } catch {
    return `${adaptersDir}:-`
  }
}

let cache: { signature: string; catalog: ToolCatalog } | null = null

/**
 * 取工具目录（进程内缓存，目录签名变化即重建）。
 * 成本是一次 `stat`，远低于一次工具调用；目录不可读时返回空目录而非抛错。
 */
export function getCatalog(adaptersDir: string | null = findAdaptersDirectory()): ToolCatalog {
  const signature = adaptersSignature(adaptersDir)
  if (cache && cache.signature === signature) return cache.catalog
  const catalog = buildCatalog(adaptersDir)
  cache = { signature, catalog }
  return catalog
}

/** 可直调工具的全名列表，供 LLM 分类候选与日志使用。 */
export function listDirectTools(adaptersDir: string | null = findAdaptersDirectory()): CatalogTool[] {
  return getCatalog(adaptersDir).directTools
}

export function findCatalogTool(
  name: string,
  adaptersDir: string | null = findAdaptersDirectory(),
): CatalogTool | undefined {
  return getCatalog(adaptersDir).byName.get(name)
}

/** 测试用：清空目录缓存。 */
export function resetToolCatalogCacheForTests(): void {
  cache = null
}

/** 目录签名（mtime + 目录项）；供其它层的热重载判定拼进自身缓存键。 */
export function catalogSignature(adaptersDir: string | null = findAdaptersDirectory()): string {
  return adaptersSignature(adaptersDir)
}

/** 暴露给测试与日志：当前解析到的 adapters 根目录。 */
export function currentAdaptersDir(): string | null {
  return findAdaptersDirectory()
}

/** 便于日志：把绝对路径裁剪成相对 cwd，避免把真实机器路径写进日志。 */
export function relativeForLog(target: string | null): string {
  if (!target) return '(none)'
  try {
    return path.relative(process.cwd(), target) || '.'
  } catch {
    return '(unknown)'
  }
}
