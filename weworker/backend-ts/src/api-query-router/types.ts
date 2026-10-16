/**
 * 智能路由引擎共享类型（详见 docs/intelligent_routing_design.md §2）。
 *
 * 这里只放「引擎内部流通的形状」，**不含任何业务规则**：规则一律来自 router-config。
 */

/** 通用渲染上下文：标题来自命中的配置条目，schemaId 指向 renderers.json 的声明式 schema。 */
export type RenderCtx = {
  title?: string
  schemaId?: string
}

/** 匹配上下文。now 由调用方注入，保证测试可注入固定时钟。 */
export type MatchCtx = {
  workId: string
  now: number
}

/**
 * 命中来源，用于日志、埋点与 SSE 的 routeSource 字段。
 * 与 docs/intelligent_routing_design.md §2 的分层序一一对应。
 */
export type MatchSource =
  /** 层 P：routes.json 的别名全等 / 关键词包含 */
  | 'route'
  /** 层 1/2：manifest 卡片槽位直连（客户端结构化 scenarioId + slots） */
  | 'scenario-a'
  /** 层 6：manifest 卡片话术锚定匹配 */
  | 'scenario'
  /** 层 9：plans.json 锚点 DAG */
  | 'plan'
  /** 层 11：shortcuts.json 守卫式短路 */
  | 'override'
  /** 层 11：aliases.json 的 `!` 显式点名 */
  | 'alias'
  /** 层 8：patterns.json 提示词配置 */
  | 'pattern'
  /** 层 3：manifest route_templates 模板直达 */
  | 'template'
  /** 层 12：词法召回 → LLM 分类 */
  | 'llm'

/** 一次工具命中的完整决策。 */
export type MatchResult = {
  tool: string
  args: Record<string, unknown>
  /** 0~1；1 表示逐字确定（`!别名` / 模板全等），仅作日志与优先级依据 */
  confidence: number
  source: MatchSource
}

/** 客户端结构化 scenario 载荷（层 1/2 形态 A）。 */
export type ScenarioPayload = {
  adapterId: string
  scenarioId: string
  slots?: Record<string, string>
}

/** 渲染入口：把工具原始返回渲染成 markdown。 */
export type RenderInvocation = {
  tool: string
  raw: string
  ctx: RenderCtx
}

/**
 * 一次直答的最终产物。引擎只负责「决策 + 渲染」，推流与落库由调用方（server.ts）完成，
 * 便于单测在不启 HTTP 的情况下断言行为。
 */
export type RoutedAnswer = {
  tool: string
  args: Record<string, unknown>
  text: string
  source: MatchSource
  execMs: number
  renderMs: number
}

/** 只空裁剪工具返回，避免把整包 JSON 灌进日志。 */
export function briefPayload(raw: string, limit = 400): string {
  const text = String(raw ?? '')
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}
