/**
 * 层 P：配置路由（`router-config/routes.json`，详见设计文档 §2 第 1 行）。
 *
 * 这是**级联的第一层**：显式点名的话术优先于任何推测。匹配语义与既有
 * `query-router/configurable-query-route.ts` 完全一致（别名归一化全等 / 关键词包含），
 * 避免同仓出现两套口径：
 *
 * - `match.aliases`：去掉空白并小写后**全等**——「这句话就是这条路由的点名」；
 * - `match.keywords`：归一化后**包含**——「这句话里出现了这个关键词」。
 *
 * 本模块只做匹配（纯函数）；是否可直调、是否只读、以及派发与渲染由调用方裁决，
 * 保证「配置写了但工具不可用」时是**静默落回**而不是硬派发。
 */

import type { RouteEntry, RouterRenderSpec } from '../router-config/types.js'

export type RouteHit = {
  /** 命中条目 id，仅日志用 */
  id: string
  tool: string
  args: Record<string, unknown>
  title?: string
  render?: RouterRenderSpec
}

/** 归一化：去全部空白 + 小写（中文场景空格无语义）。与第 0 层同规则。 */
export function normalizeRouteText(value: string): string {
  // 必须去掉**内部**空白，不只是 trim：卡片话术里带空格（如「帮我在 B 站搜索…」），
  // 配置里按卡片原文抄一遍是很自然的动作；只 trim 会让「抄来的别名」永远不等。
  return String(value ?? '').replace(/\s+/g, '').toLowerCase()
}

/** 单条路由是否命中。别名全等优先，其次关键词包含。 */
export function routeMatches(entry: RouteEntry, message: string): boolean {
  const normalized = normalizeRouteText(message)
  if (!normalized) return false
  for (const alias of entry.match?.aliases ?? []) {
    if (normalized === normalizeRouteText(alias)) return true
  }
  for (const keyword of entry.match?.keywords ?? []) {
    const key = normalizeRouteText(keyword)
    if (key && normalized.includes(key)) return true
  }
  return false
}

/**
 * 构造层 P 匹配器：`(message) => RouteHit | null`。纯函数、无 IO。
 * 命中顺序 = 配置顺序（先到先得），便于「更特化的一条写在前面」这一人工约定生效。
 */
export function buildRouteMatcher(routes: readonly RouteEntry[] | null | undefined): (message: string) => RouteHit | null {
  const enabled = (routes ?? []).filter(
    (entry) => entry && typeof entry.id === 'string' && typeof entry.tool === 'string' && entry.enabled !== false,
  )

  return function matchRoute(message: string): RouteHit | null {
    if (!message?.trim()) return null
    for (const entry of enabled) {
      if (!routeMatches(entry, message)) continue
      return {
        id: entry.id,
        tool: entry.tool,
        args: { ...(entry.args ?? {}) },
        title: entry.title,
        render: entry.render,
      }
    }
    return null
  }
}

/** 便于测试与日志：当前层里出现过（并已启用）的工具全名。 */
export function configuredToolsOf(routes: readonly RouteEntry[] | null | undefined): Set<string> {
  const out = new Set<string>()
  for (const entry of routes ?? []) {
    if (entry?.enabled !== false && typeof entry?.tool === 'string') out.add(entry.tool)
  }
  return out
}
