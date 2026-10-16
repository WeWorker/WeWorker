/**
 * 「路由直达」可用性计算 —— 由当前生效的路由配置反推**哪些站点真的被路由覆盖**。
 *
 * 用途：`GET /sites` 的 `routable` / `routeEntryCount` 字段，供站点列表展示徽标。
 * 之所以在这里算而不是在前端算：路由条目住在配置里（`weworker/router-config/` + 用户覆盖层），
 * 前端拿不到；而「配置项只对当前存在的 Adapter 生效」这条作用域规则也由本模块统一执行，
 * 避免前端另起一套判定导致徽标与实际路由面不一致。
 *
 * 语义（**只说能证明的事**）：一个站点可路由 ⇔ 存在至少一条**已启用**的配置条目，其工具
 * 归属于该站点。判定**不假设**工具是否只读、是否已在目录里——那是路由引擎的准入硬门
 * （`routableTools`），这里只看「配置有没有指向它」。两个条件同时满足才真会短路，
 * 徽标文案据此写（见 Renderer 的 `cap-site-row-badge`）。
 *
 * 入参 `bundle` 应当是**已经过作用域过滤**的配置束（`applyRouterConfigScope` 或
 * `getScopedRouterConfig` 的输出）；`adapterIds` 再兜一层，防止调用方漏过滤时把
 * 已下线的站点算成可路由。
 */

import type { RouterConfigBundle } from './types.js'
import { isToolInAdapterScope } from './validate.js'

export type RoutableSiteReport = {
  /** 至少有一条已启用条目指向的 adapter id */
  routable: Set<string>
  /** adapter id → 指向它的已启用条目数（同一工具被多层覆盖时按条目计） */
  entryCount: Map<string, number>
}

const EMPTY_REPORT: RoutableSiteReport = { routable: new Set(), entryCount: new Map() }

function isEnabled(entry: { enabled?: boolean } | undefined | null): boolean {
  return !!entry && entry.enabled !== false
}

/**
 * 把工具名归属到 adapter：取**最长**的匹配前缀。
 *
 * 必须取最长——`mail.qq.com` 与假设存在的 `mail.qq.com.cn` 同在配置里时，
 * 按首个匹配会把前者的工具错记到后者头上。
 */
function attributeToolToAdapter(tool: string, adapterIds: ReadonlySet<string>): string | null {
  if (typeof tool !== 'string' || tool === '') return null
  if (adapterIds.has(tool)) return tool
  let best: string | null = null
  for (const adapterId of adapterIds) {
    if (!adapterId || !tool.startsWith(`${adapterId}.`)) continue
    if (best === null || adapterId.length > best.length) best = adapterId
  }
  // 最后一个兜底：配置里出现的工具名可能是 adapter id 之外的写法（如内部工具名），
  // isToolInAdapterScope 是权威口径，它认了才记账，否则丢弃。
  if (best === null && isToolInAdapterScope(tool, adapterIds)) return tool
  return best
}

/** 收集配置里所有「已启用条目会调用的工具名」 */
function collectConfiguredTools(bundle: RouterConfigBundle): string[] {
  const tools: string[] = []

  for (const entry of bundle.routes?.routes ?? []) {
    if (isEnabled(entry) && typeof entry?.tool === 'string') tools.push(entry.tool)
  }
  for (const entry of bundle.aliases?.aliases ?? []) {
    if (isEnabled(entry) && typeof entry?.tool === 'string') tools.push(entry.tool)
  }
  for (const entry of bundle.shortcuts?.shortcuts ?? []) {
    if (isEnabled(entry) && typeof entry?.tool === 'string') tools.push(entry.tool)
  }

  // 第 −1 层的 configs 以**工具名**为 key
  for (const [tool, entry] of Object.entries(bundle.patterns?.configs ?? {})) {
    if (isEnabled(entry)) tools.push(tool)
  }

  // 多跳计划：resolver 与 terminal 是真正会被调用的工具
  for (const plan of bundle.plans?.plans ?? []) {
    if (!isEnabled(plan)) continue
    for (const resolver of plan.resolvers ?? []) {
      if (typeof resolver?.tool === 'string') tools.push(resolver.tool)
    }
    for (const terminal of plan.terminals ?? []) {
      if (typeof terminal?.tool === 'string') tools.push(terminal.tool)
    }
  }

  // 卡片话术编译产物：`tool` 单跳 / `plan.terminal` 多跳；opt-out 明确不是路由面
  for (const route of bundle.scenarioRoutes?.routes ?? []) {
    if (route?.enabled === false || route?.optout) continue
    if (typeof route?.tool === 'string') tools.push(route.tool)
    if (typeof route?.plan?.terminal === 'string') tools.push(route.plan.terminal)
  }

  return tools
}

/**
 * 计算当前配置覆盖到的站点。
 *
 * 纯函数：坏条目（缺 tool / 非字符串）一律跳过，绝不抛异常——`/sites` 是高频只读接口，
 * 一个坏配置不能让整个站点列表 500。
 */
export function computeRoutableSites(
  bundle: RouterConfigBundle | null | undefined,
  adapterIds: ReadonlySet<string>,
): RoutableSiteReport {
  if (!bundle || !adapterIds || adapterIds.size === 0) return EMPTY_REPORT

  const routable = new Set<string>()
  const entryCount = new Map<string, number>()

  for (const tool of collectConfiguredTools(bundle)) {
    const adapterId = attributeToolToAdapter(tool, adapterIds)
    if (!adapterId) continue
    routable.add(adapterId)
    entryCount.set(adapterId, (entryCount.get(adapterId) ?? 0) + 1)
  }

  return { routable, entryCount }
}
