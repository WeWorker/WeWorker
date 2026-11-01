/**
 * 页面依赖命令的零 LLM 页面准备（`docs/intelligent_routing_design.md` §2 第 17 行）。
 *
 * catalog 里带 `navigate_before` 的直调命令需要先打开页面，才能带页面态发请求。manifest 的
 * `tool_execution[<工具名>].navigate_before` 经 `adapter-parser` → `tool-catalog` 带进 `CatalogTool`；
 * 快路在主 dispatch 前做确定性编排：`open_browser(url)` → 等待 → 主调用。
 *
 * 等待语义：`open_browser` 阻塞至扩展端工具注册完成信号（`tools_ready`，bridge 按 tabId 关联、
 * 8s 超时兜底）才返回，本模块据其响应决定残余等待——
 * - `toolsReady === true` → 零等待；
 * - 超时（响应含 `waitedMs`）→ 只补 `budget − waitedMs` 残余，不叠等；
 * - 无字段（旧 bridge / 系统命令路径 / 解析失败）→ 全额固定等待
 *   （`WEWORKER_PAGE_PREP_WAIT_MS`，默认 5000，对齐第3层 fallback 约定）。
 *
 * 失败语义：`open_browser` best-effort——已有标签页时主调用仍可成功；真失败交主调用的既有
 * 鉴权/缺参落回语义。任何情况都不比「今天盲调」差。
 */
import { getCatalog } from './tool-catalog.js'

export interface PagePrepDispatch {
  (tool: string, argsJson: string, workId: string): Promise<string>
}

export interface PagePrepResult {
  /** true = 已执行 `open_browser` + 等待（主调用应计 `steps + 1`）。 */
  prepared: boolean
  url: string
  ms: number
  /** `open_browser` 响应标注的工具就绪信号；无信号（旧 bridge / 超时 / 系统命令路径）为 false。 */
  toolsReady: boolean
}

export interface PagePrepOptions {
  waitMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 页面准备等待（毫秒）：env `WEWORKER_PAGE_PREP_WAIT_MS`，默认 5000（对齐第3层「至少 5 秒」约定）；非法回默认，负数归 0。 */
export function pagePrepareWaitMs(): number {
  const raw = process.env.WEWORKER_PAGE_PREP_WAIT_MS
  if (raw === undefined || raw.trim() === '') return 5000
  const value = Number(raw)
  if (!Number.isFinite(value)) return 5000
  return Math.max(0, Math.floor(value))
}

/** 急停：`WEWORKER_PAGE_PREP=0` 关闭编排（回到今天盲调行为）。默认开。 */
export function isPagePrepEnabled(): boolean {
  return process.env.WEWORKER_PAGE_PREP !== '0'
}

let _urlMap: Map<string, string> | null = null

/**
 * 工具全名 → `navigate_before` URL 表（随 catalog 启动期快照缓存）。
 * 只取**当前目录里真实存在**的直调工具：配置里没有的工具不会凭空产生页面准备。
 */
export function navigateBeforeUrls(): Map<string, string> {
  if (_urlMap) return _urlMap
  const map = new Map<string, string>()
  for (const tool of getCatalog().directTools) {
    const url = tool.navigateBefore
    if (typeof url === 'string' && url.trim() !== '') map.set(tool.name, url.trim())
  }
  _urlMap = map
  return map
}

/** 测试钩子：重置 URL 表缓存（下次调用从 catalog 快照重建）。 */
export function _resetPagePrepCacheForTests(): void {
  _urlMap = null
}

/** 测试钩子：直接注入 URL 表（null = 空表，跳过 catalog 读盘）。 */
export function _setPagePrepUrlsForTests(map: Map<string, string> | null): void {
  _urlMap = map ?? new Map()
}

/**
 * 主 dispatch 前的页面准备。无 `navigate_before` / 急停 → `{prepared:false}`（零行为变化）。
 * 主调用与落回判定（鉴权失败 / 缺参）由调用方复用既有逻辑。
 */
export async function runPagePrep(
  tool: string,
  dispatch: PagePrepDispatch,
  workId: string,
  opts: PagePrepOptions = {},
): Promise<PagePrepResult> {
  if (!isPagePrepEnabled()) return { prepared: false, url: '', ms: 0, toolsReady: false }
  const url = navigateBeforeUrls().get(tool)
  if (!url) return { prepared: false, url: '', ms: 0, toolsReady: false }

  const now = opts.now ?? Date.now
  const start = now()
  // 解析 open_browser 响应的就绪信号决定残余等待（见模块头）。JSON.parse 失败 / 响应非对象
  // （旧 bridge 文本）都落在无字段分支 → 全额固定等待（今日行为，向后兼容）。
  let toolsReady = false
  let waitedMs = 0
  try {
    const catalogTool = getCatalog().byName.get(tool)
    const adapter = catalogTool?.adapterId
    const parsed = JSON.parse(await dispatch('open_browser', JSON.stringify({ url, ...(adapter ? { adapter } : {}) }), workId)) as {
      toolsReady?: unknown
      waitedMs?: unknown
    } | null
    toolsReady = parsed?.toolsReady === true
    if (typeof parsed?.waitedMs === 'number' && Number.isFinite(parsed.waitedMs)) {
      waitedMs = Math.max(0, parsed.waitedMs)
    }
  } catch {
    // best-effort：页面已开时主调用不受影响；真失败由主调用的鉴权落回语义兜底。
  }
  const budget = opts.waitMs ?? pagePrepareWaitMs()
  const remain = toolsReady ? 0 : Math.max(0, budget - waitedMs)
  if (remain > 0) await (opts.sleep ?? defaultSleep)(remain)
  return { prepared: true, url, ms: now() - start, toolsReady }
}
