/**
 * 智能路由配置——分层配置文件的类型定义（详见 docs/intelligent_routing_design.md §3）。
 *
 * 每个层一个文件；引擎对所有层都是数据驱动，新增/删除/修改一条路由＝改一行配置。
 * 本模块只描述「配置长什么样」，不含任何匹配逻辑。
 */

export const ROUTER_CONFIG_SCHEMA_VERSION = 1

/** 层名 → 配置文件名（不含扩展名） */
export const ROUTER_LAYER_FILES = {
  routes: 'routes',
  aliases: 'aliases',
  shortcuts: 'shortcuts',
  patterns: 'patterns',
  plans: 'plans',
  renderers: 'renderers',
  planTerminals: 'plan-terminals',
  scenarioRoutes: 'scenario-routes',
} as const

export type RouterLayerName = keyof typeof ROUTER_LAYER_FILES

export type RouterConfigManifest = {
  schemaVersion?: number
  /** 逐层开关；缺省或未列出＝启用（空配置等于不生效） */
  layers?: Partial<Record<RouterLayerName, boolean>>
  note?: string
}

/** 正则/关键词对；复用第 11 层与 plan 入口的写法 */
export type RouterPatternSpec = {
  positive?: string[]
  negative?: string[]
}

export type RouterRenderSpec = {
  type?: 'generic' | 'schema'
  schemaId?: string
}

/**
 * 成功示例：**每条路由条目必填**（校验器强制），写「这条配置应当被哪句话命中」的原文。
 *
 * 三重作用，缺一不可：
 * 1. 给人和 LLM 看——加一条配置时不用去别处翻「这条怎么用」；
 * 2. 给测试读——内部回归套件直接拿它当**正例**跑一遍匹配器，
 *    写错的关键词/正则当场红，而不是上线后静默不命中；
 * 3. 防污染——示例就是「这条配置的适用边界」，写不出来往往说明这条配置本来就不该加。
 *
 * 与「写在注释里的示例」的区别：注释机器读不到，等于写了但没验证。
 *
 * 类型上**故意留可选**（层匹配器的单测要能构造最小条目），强制力放在 `validate.ts`：
 * 配置文件里缺 `examples` 的条目一律校验失败，整个用户层回退——写配置的人绕不过去。
 */
export type RouterExamples = string[]

// ── 层 P：配置路由（沿用既有 QueryRouteConfig 结构，向后兼容）──────────────────
export type RouteEntry = {
  id: string
  tool: string
  enabled?: boolean
  match?: { aliases?: string[]; keywords?: string[] }
  args?: Record<string, unknown>
  title?: string
  /** 层 P 的渲染方式；`{type:'schema', schemaId}` 走声明式表格，缺省为通用渲染 */
  render?: RouterRenderSpec
  examples?: RouterExamples
}

/**
 * 数组型层。**这里只声明「加载后」的形态**：磁盘上 `routes` 允许写成 adapter 分节
 * （`{ "<adapterId>": [ 条目… ] }`），加载时被 `adapter-grouped.ts` 展开成这个扁平数组，
 * 因此下游（cascade / replay / validate）看到的恒为数组，无需处理两种形态。
 * 磁盘形态的说明见 `adapter-grouped.ts` 的模块注释。
 */
export type RoutesFile = { routes?: RouteEntry[] }

// ── 层 11：! 别名与守卫式短路 ────────────────────────────────────────────────
export type AliasEntry = {
  id: string
  tool: string
  enabled?: boolean
  /** 形如 "!repos"；省略时用 id 推断 */
  alias?: string
  args?: Record<string, unknown>
  /**
   * 渲染方式。与层 P / 快捷话术同口径：写 `{type:'schema', schemaId}` 才走声明式表格。
   * 少了它，同一个工具经 `!别名` 进来只能渲染成通用表格——同一份数据两条入口两种长相。
   */
  render?: RouterRenderSpec
  /** 成功示例：即这个 `!别名` 的原文，如 `["!hn"]`；必填（见 RouterExamples） */
  examples?: RouterExamples
}

export type AliasesFile = { aliases?: AliasEntry[] }

export type ShortcutExtractRule = {
  from?: 'message'
  regex: string
  flags?: string
  arg: string
  type?: 'string' | 'integer' | 'number' | 'boolean'
  min?: number
  max?: number
}

export type ShortcutEntry = {
  id: string
  tool: string
  enabled?: boolean
  /** 同类命中时数值大者优先；缺省视为 0 */
  priority?: number
  patterns?: RouterPatternSpec
  args?: Record<string, unknown>
  extract?: ShortcutExtractRule[]
  render?: RouterRenderSpec
  /** 成功示例：应当被本条的 `patterns.positive` 命中的原文；必填（见 RouterExamples） */
  examples?: RouterExamples
}

export type ShortcutsFile = { shortcuts?: ShortcutEntry[] }

// ── 层 -1：提示词配置（正则/关键词 + 负向 + 参数抽取器）──────────────────────
export type PatternRule = {
  type: 'regex' | 'keyword'
  expression?: string
  flags?: string
  keywords?: string[]
  /** 仅 keyword 类型生效：any＝命中任一（缺省） / all＝全含 / phrase＝连成整串 */
  match_mode?: 'any' | 'all' | 'phrase'
  weight?: number
  examples?: string[]
  /** 预留：条件表达式；当前不消费 */
  condition?: string
  default_args?: Record<string, unknown>
}

export type ArgExtractorRule = {
  regex: string
  flags?: string
  arg: string
  type?: 'string' | 'integer' | 'number' | 'boolean'
  min?: number
  max?: number
}

export type PatternConfigEntry = {
  enabled?: boolean
  priority?: number
  patterns?: PatternRule[]
  negative_patterns?: string[]
  arg_extractors?: ArgExtractorRule[]
  default_args?: Record<string, unknown>
  /** Tier -1 命中后的渲染方式；与 route / alias / shortcut 共用同一份声明。 */
  render?: RouterRenderSpec
}

export type PatternsFile = {
  version?: string
  global?: {
    case_sensitive?: boolean
    min_confidence_for_match?: number
  }
  configs?: Record<string, PatternConfigEntry>
}

// ── 层 9：多跳锚点 DAG（声明式 resolver / terminal）─────────────────────────
export type PlanExtractRule = {
  /** 目前仅支持从列表结果行中挑 */
  source?: 'rows'
  /** 结果数组所在路径（`a.b[0].c` 形式）；缺省自动探测主数组 */
  path?: string
  pick?: 'name' | 'latest' | 'contains'
  /** 与用户输入比对的锚点来源，形如 "$productName"（引用入口 input） */
  equals?: string
  /** 取出的字段名 */
  value?: string
  /** 多匹配时的处置：ask＝走确认门（需 askUser 注入）；abort＝直接落回 LLM */
  onAmbiguous?: 'ask' | 'abort'
  /** 确认门问句；仅 onAmbiguous: 'ask' 时有意义，缺省给通用问句 */
  question?: string
}

export type PlanResolver = {
  produces: string
  needs?: string[]
  tool: string
  /** 静态参数；值形如 `$锚点名` 时从已解析锚点取，"$$k" 从入口 input 取 */
  args?: Record<string, unknown>
  extract?: PlanExtractRule
}

export type PlanTerminal = {
  key: string
  needs?: string[]
  tool: string
  args?: Record<string, unknown>
  render?: RouterRenderSpec
}

/**
 * 层 9 一条计划：入口识别 + 该计划专属的 resolver / terminal 注册表。
 * `entry.terminal` 选择命中后跑哪个终端；缺省取 terminals 的第一条（配置顺序即优先级）。
 */
export type PlanEntry = {
  id: string
  enabled?: boolean
  /** 归属 adapter；manifest `route.plan` 形态按此字段反查本计划 */
  adapterId?: string
  entry?: RouterPatternSpec & { terminal?: string }
  resolvers?: PlanResolver[]
  terminals?: PlanTerminal[]
  /** 成功示例：应当被 `entry.positive` 命中且**不被** `entry.negative` 命中的原文；必填 */
  examples?: RouterExamples
}

export type PlansFile = { plans?: PlanEntry[] }

// ── 声明式渲染 ──────────────────────────────────────────────────────────────
export type RouterRenderColumn = {
  type: 'text' | 'number' | 'date' | 'status' | 'link'
  key: string
  title?: string
}

/**
 * 声明式渲染 schema。**能力边界（必须明确）**：支持 `text` / `number` / `date` / `status` /
 * `link` 五类列、分节、行数截断与「仅显示前 N」尾注；**不支持**任意脚本、跨行计算、条件分支渲染
 * ——需要这些的工具应走通用渲染或落回 LLM，不允许在渲染层写代码。
 */
export type RouterRenderSchema = {
  title?: string
  /** 从工具返回值取主数组的路径（`a.b[0].c` 形式）；缺省自动探测 */
  dataSource?: string
  columns?: RouterRenderColumn[]
  /** 超过则截断并追加「仅显示前 N」尾注 */
  maxRows?: number
  emptyMessage?: string
  /** 分节：每节独立取数、独立列与截断；与顶层 columns 二选一 */
  sections?: RouterRenderSection[]
}

/** 分节：与顶层 schema 同形（不能再嵌套 sections）。 */
export type RouterRenderSection = Omit<RouterRenderSchema, 'sections'>

export type RenderersFile = { schemas?: Record<string, RouterRenderSchema> }

// ── 层 9 入口白名单（编译期与测试期校验，运行时不读）────────────────────────
export type PlanTerminalWhitelistEntry = {
  tool: string
  input?: Record<string, { type?: string; required?: boolean }>
}

export type PlanTerminalsFile = {
  version?: number
  note?: string
  adapters?: Record<string, Record<string, PlanTerminalWhitelistEntry>>
}

// ── 层 1/6/7：manifest 编译产物的运行时形态 ─────────────────────────────────
export type CompiledScenarioArgSpec = {
  const?: unknown
  slot?: string
  type?: string
  enum?: string[]
}

export type CompiledScenarioRoute = {
  adapter: string
  scenarioId: string
  tool?: string
  plan?: { terminal: string; input?: Record<string, CompiledScenarioArgSpec> }
  optout?: boolean
  reason?: string
  enabled?: boolean
  patterns?: { regex: string; flags?: string }[]
  args?: Record<string, CompiledScenarioArgSpec>
  slotNames?: string[]
  promptTemplates?: string[]
  guardNegative?: string[]
}

export type ScenarioRoutesFile = {
  version?: number
  generatedAt?: string
  routes?: CompiledScenarioRoute[]
}

/** 加载来源可以指向某个层，也可以指向 manifest（逐层开关所在的文件） */
export type RouterConfigSourceLayer = RouterLayerName | 'manifest'

/** 单层的加载来源，用于日志与运维观测 */
export type RouterConfigSource = {
  layer: RouterConfigSourceLayer
  /** 命中来源：bundled＝随包默认；user＝用户覆盖层；default＝文件缺失时的内置空结构 */
  origin: 'bundled' | 'user' | 'default'
  filePath?: string
  /** 用户覆盖层展开进来的条目 id（仅 id 级合并的层有值） */
  overriddenIds?: string[]
  /** 校验失败被丢弃的原因（有值时该层回退到上一份可用配置） */
  rejected?: string
}

/** 全量配置束：一次加载的完整视图 */
export type RouterConfigBundle = {
  schemaVersion: number
  manifest: RouterConfigManifest
  routes: RoutesFile
  aliases: AliasesFile
  shortcuts: ShortcutsFile
  patterns: PatternsFile
  plans: PlansFile
  renderers: RenderersFile
  planTerminals: PlanTerminalsFile
  scenarioRoutes: ScenarioRoutesFile
  sources: RouterConfigSource[]
}

export function emptyRouterConfigBundle(): RouterConfigBundle {
  return {
    schemaVersion: ROUTER_CONFIG_SCHEMA_VERSION,
    manifest: {},
    routes: { routes: [] },
    aliases: { aliases: [] },
    shortcuts: { shortcuts: [] },
    patterns: { configs: {} },
    plans: { plans: [] },
    renderers: { schemas: {} },
    planTerminals: { adapters: {} },
    scenarioRoutes: { routes: [] },
    sources: [],
  }
}
