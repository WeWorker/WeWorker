/**
 * manifest 模板直达（Tier -2，详见 docs/intelligent_routing_design.md §2 第 3 行）。
 *
 * adapter 作者在 `manifest.json` 顶层 `route_templates[]` 里逐字策划查询句式模板
 * （固定文案 + 槽位），用户消息 trim 后与模板**锚定全等**（`^(?:...)$`）即零 LLM 直调：
 *   - `${A|B|C}`（token 含 `|`）= 枚举槽：命中的分支词经 `enumArgs` 映射为参数；
 *   - `${名称}`（不含 `|`）= 自由文本槽：捕获文本按 `slots[名称].validate` 校验后抽为参数。
 *
 * 定位：**先于两道硬门**——模板是逐字全等的策划句，没有推断成分，硬门防的是模糊层误抢。
 * 但仍保留两道闸：`!` 前缀让位显式别名；派发后鉴权 / 缺参仍落回 LLM。
 *
 * 加载语义：无效模板一律 **warn + skip**（`skipped` 带稳定 `TPL_*` code），绝不影响 adapter
 * 其余功能与其他模板。索引按 adapters 目录签名失效重建（§4 热重载要求）。
 */

import { parseAllAdapters } from '../adapter-parser.js'
import type { ManifestRouteTemplateDef } from '../adapter-parser.js'
import { getCatalog, type CatalogTool } from './tool-catalog.js'
import { createLogger } from '../logger.js'

const log = createLogger('api-query-router:templates')

/** pattern 长度上限（策划句不应太长；同时 bounding 正则规模）。 */
const MAX_PATTERN_LEN = 120
/** 单条模板槽位数上限。 */
const MAX_SLOTS = 4
/** 全进程模板总数上限。 */
const MAX_TEMPLATES = 200
/** 自由槽 validate 正则长度上限。 */
const MAX_VALIDATE_LEN = 80

/** manifest pattern 中的槽位语法：`${...}`。 */
const SLOT_RE = /\$\{([^}]*)\}/g

/** 编译后的槽位（name = 正则命名捕获组名，与 m.groups 对应）。 */
export type CompiledGroup =
  | { kind: 'enum'; name: string; tokens: string[] }
  | { kind: 'free'; name: string; slot: string; arg: string; validateRe: RegExp }

export type CompiledRouteTemplate = {
  id: string
  adapterId: string
  tool: string
  /** 共享静态参数（合并顺序第 1 位，被槽位参数覆盖）。 */
  args: Record<string, unknown>
  /** 枚举分支词 → 部分参数（合并顺序第 2 位）。自由槽参数最后合并（覆盖前者）。 */
  enumArgs: Record<string, Record<string, unknown>>
  /** 锚定全等正则：`^(?:...)$`，无 flags（大小写敏感，策划句逐字匹配）。 */
  regex: RegExp
  groups: CompiledGroup[]
}

/** 无效模板 / 告警条目（skipped = 整条未加载；warnings = 加载但语义存疑）。 */
export type TemplateIssue = {
  adapterId: string
  id: string
  code: string
  detail: string
}

export type ManifestTemplateIndex = {
  templates: CompiledRouteTemplate[]
  skipped: TemplateIssue[]
  warnings: TemplateIssue[]
}

export type ManifestTemplateMatch = {
  template: CompiledRouteTemplate
  /** 合并后最终派发参数（shared args ← 枚举槽 ← 自由槽）。 */
  args: Record<string, unknown>
  /** 命中的槽位值（仅日志观测用，不进 SSE / 持久化）。 */
  slotValues: { name: string; kind: 'enum' | 'free'; raw: string }[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 与 recall.ts mentionsAdapter 同款转义。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 自由槽 validate 约束（防自由槽吞掉模板固定文案之外的任意后缀 / 前缀）。黑名单启发式，
 * 非沙箱：拒绝已知「过宽」形态，作者仍须遵守 README 约定（闭合形式如 `\d{5,}`、
 * `[A-Z]{3}-\d{4}`，两侧由模板固定文案锚定）。返回错误描述；null = 合法。
 */
export function checkTemplateValidate(validate: string): string | null {
  if (!validate) return 'validate 为空'
  if (validate.length > MAX_VALIDATE_LEN) return `长度 ${validate.length} 超过上限 ${MAX_VALIDATE_LEN}`
  if (/[$^]/.test(validate)) return '不允许包含 ^ 或 $（引擎已对整个模板首尾锚定）'
  if (/(^|[^\\])\.\s*[+*]/.test(validate)) return '不允许裸通配 .+ / .*（须为闭合形式，如 \\d{5,}）'
  if (/\[[^\]]*\^([^\]]*)\]\s*[*+{]/.test(validate)) {
    return '不允许否定字符类接量词（[^…]+ 会吞掉几乎任意文本）'
  }
  if (/\[[^\]]*(?:\\s|\\S)[^\]]*\]\s*[*+]/.test(validate)) return '不允许含 \\s/\\S 的字符类接 * 或 +'
  try {
    if (new RegExp(`^(?:${validate})$`).test('')) return 'validate 可匹配空串（等价可选槽，风险过高）'
  } catch (error) {
    return `非法正则：${error instanceof Error ? error.message : String(error)}`
  }
  return null
}

/**
 * 编译并校验单条模板。合法返回 `{ template }`，非法返回 `{ skipped }`（整条跳过）。
 * `warnings` 由调用方传入收集（不影响加载）。
 */
function compileTemplate(
  def: ManifestRouteTemplateDef,
  adapterId: string,
  canonicalByTool: ReadonlyMap<string, string>,
  disabledTools: ReadonlySet<string>,
  seenIds: Set<string>,
  warnings: TemplateIssue[],
): { template?: CompiledRouteTemplate; skipped?: TemplateIssue } {
  const skip = (id: string, code: string, detail: string): { skipped: TemplateIssue } => ({
    skipped: { adapterId, id, code, detail },
  })

  const id = typeof def?.id === 'string' ? def.id.trim() : ''
  if (!id) return skip('', 'TPL_ID_MISSING', 'id 缺失或为空')
  if (seenIds.has(id)) return skip(id, 'TPL_ID_DUP', 'id 与已加载模板重复（先到先得）')

  if (typeof def.pattern !== 'string') return skip(id, 'TPL_PATTERN_MISSING', 'pattern 缺失或非字符串')
  const pattern = def.pattern.trim()
  if (!pattern) return skip(id, 'TPL_PATTERN_EMPTY', 'pattern trim 后为空')
  if (pattern.length > MAX_PATTERN_LEN) {
    return skip(id, 'TPL_SIZE_LIMIT', `pattern 长度 ${pattern.length} 超过上限 ${MAX_PATTERN_LEN}`)
  }

  const slotMatches = [...pattern.matchAll(SLOT_RE)]
  if (slotMatches.length === 0) {
    return skip(id, 'TPL_NO_SLOT', '零槽位=全等别名，应走 routes.json / aliases.json，不收模板')
  }
  if (slotMatches.length > MAX_SLOTS) {
    return skip(id, 'TPL_SIZE_LIMIT', `槽位数 ${slotMatches.length} 超过上限 ${MAX_SLOTS}`)
  }

  const tool = typeof def.tool === 'string' ? def.tool.trim() : ''
  if (!tool) return skip(id, 'TPL_TOOL_MISSING', 'tool 缺失或为空')
  // 规范名或别名 / 兼容名都接受；派发与 kill-switch 一律用解析后的规范名。
  const canonical = canonicalByTool.get(tool)
  if (!canonical) {
    return skip(id, 'TPL_TOOL_NOT_DIRECT', `${tool} 不在可直调目录（需 execution: api + background，或 directCapable）`)
  }
  if (disabledTools.has(canonical) || disabledTools.has(tool)) {
    return skip(id, 'TPL_TOOL_DISABLED', `${tool} 已被配置禁用（enabled:false）`)
  }
  // 红线：只读是路由面准入硬门。写操作 / 需二次确认的工具一律不进 Tier -2。
  if (canonicalByTool.get(`${canonical}\u0000readonly`) === undefined) {
    // 只读性由 catalog 在构建 canonicalByTool 时用哨兵键登记
    return skip(id, 'TPL_TOOL_NOT_READONLY', `${tool} 未显式声明 safety:"read"（写操作不进路由面）`)
  }

  const args = def.args === undefined ? {} : def.args
  const enumArgs = def.enumArgs === undefined ? {} : def.enumArgs
  const slotsCfg = def.slots === undefined ? {} : def.slots
  if (!isPlainObject(args) || !isPlainObject(enumArgs) || !isPlainObject(slotsCfg)) {
    return skip(id, 'TPL_ARGS_TYPE', 'args / enumArgs / slots 必须是对象')
  }

  // ── Pass A：槽位分类 + 自由槽 spec / validate 校验（先全量收集，再做覆盖检查）──
  const enumTokens: string[] = []
  const freeSpecs = new Map<number, { name: string; arg: string; validate: string; validateRe: RegExp }>()
  for (let i = 0; i < slotMatches.length; i++) {
    const token = (slotMatches[i][1] ?? '').trim()
    if (token.includes('|')) {
      const branches = token
        .split('|')
        .map((branch) => branch.trim())
        .filter(Boolean)
      if (!branches.length) return skip(id, 'TPL_COMPILE_FAILED', '枚举槽分支全为空')
      enumTokens.push(...branches)
      continue
    }
    const spec = slotsCfg[token]
    if (!isPlainObject(spec)) return skip(id, 'TPL_SLOT_NO_CONFIG', `自由槽 ${token} 在 slots 无配置`)
    const arg = typeof spec.arg === 'string' ? spec.arg.trim() : ''
    if (!arg) return skip(id, 'TPL_SLOT_NO_ARG', `自由槽 ${token} 缺少 arg`)
    const validate = typeof spec.validate === 'string' ? spec.validate.trim() : ''
    if (!validate) return skip(id, 'TPL_SLOT_NO_VALIDATE', `自由槽 ${token} 缺少 validate（自由槽必须显式约束）`)
    const validateError = checkTemplateValidate(validate)
    if (validateError) return skip(id, 'TPL_VALIDATE_INVALID', `自由槽 ${token} validate 非法：${validateError}`)
    freeSpecs.set(i, { name: token, arg, validate, validateRe: new RegExp(`^(?:${validate})$`) })
  }

  // ── 覆盖检查：枚举分支词 ↔ enumArgs key 双向一致（漂移 = 作者意图已变，显式报错优于静默）──
  const enumTokenSet = new Set(enumTokens)
  const uncovered = enumTokens.find((token) => !(token in enumArgs))
  if (uncovered) {
    return skip(id, 'TPL_ENUM_TOKEN_UNCOVERED', `枚举分支词「${uncovered}」在 enumArgs 无映射`)
  }
  const drift = Object.keys(enumArgs).find((key) => !enumTokenSet.has(key))
  if (drift) return skip(id, 'TPL_ENUM_KEY_DRIFT', `enumArgs key「${drift}」不属于任何枚举槽分支词`)
  // warn：枚举分支词同时出现在 slots（枚举槽不读 slots，配置冗余）
  for (const key of Object.keys(slotsCfg)) {
    if (enumTokenSet.has(key)) {
      warnings.push({
        adapterId,
        id,
        code: 'TPL_SLOT_KIND_CONFLICT',
        detail: `「${key}」既是枚举分支词又在 slots 中，已忽略该 slots 项`,
      })
      delete slotsCfg[key]
    }
  }
  // warn：两个自由槽写同一 arg（保留，按槽位顺序后者覆盖）
  const seenArgs = new Map<string, string>()
  for (const spec of freeSpecs.values()) {
    if (seenArgs.has(spec.arg)) {
      warnings.push({
        adapterId,
        id,
        code: 'TPL_SLOT_ARG_DUP',
        detail: `arg「${spec.arg}」被多个自由槽使用（${seenArgs.get(spec.arg)} 与 ${spec.name}），后者覆盖`,
      })
    } else {
      seenArgs.set(spec.arg, spec.name)
    }
  }

  // ── Pass B：拼正则（枚举分支按长度降序防互吞；命名捕获组 g{i}，不用 CJK 组名）──
  const groups: CompiledGroup[] = []
  const parts: string[] = []
  let last = 0
  slotMatches.forEach((slotMatch, i) => {
    const at = slotMatch.index ?? 0
    parts.push(escapeRegExp(pattern.slice(last, at)))
    const token = (slotMatch[1] ?? '').trim()
    const name = `g${i}`
    const free = freeSpecs.get(i)
    if (free) {
      parts.push(`(?<${name}>${free.validate})`)
      groups.push({ kind: 'free', name, slot: free.name, arg: free.arg, validateRe: free.validateRe })
    } else {
      const tokens = token
        .split('|')
        .map((branch) => branch.trim())
        .filter(Boolean)
        .sort((a, b) => b.length - a.length)
      parts.push(`(?<${name}>${tokens.map(escapeRegExp).join('|')})`)
      groups.push({ kind: 'enum', name, tokens })
    }
    last = at + slotMatch[0].length
  })
  parts.push(escapeRegExp(pattern.slice(last)))

  let regex: RegExp
  try {
    regex = new RegExp(`^(?:${parts.join('')})$`)
  } catch (error) {
    return skip(id, 'TPL_COMPILE_FAILED', `正则编译失败：${error instanceof Error ? error.message : String(error)}`)
  }

  return {
    template: {
      id,
      adapterId,
      tool: canonical,
      args: { ...args },
      enumArgs,
      regex,
      groups,
    },
  }
}

/** 只读哨兵键：canonicalByTool 里以 `<name>\0readonly` 标记「该工具显式声明了 safety:read」。 */
const READONLY_SUFFIX = '\u0000readonly'

/**
 * 从全部 adapter 的 `routeTemplates` 构建模板索引。
 *
 * `directTools` 若带 aliases，则别名 / legacy 名同样可被模板引用（解析回规范名）。规范名
 * 优先于别名占位：先种全部规范名，再补别名（同名先到先得），避免某工具的别名遮蔽另一
 * 工具的规范名。
 */
export function buildManifestTemplateIndex(
  raw: readonly { adapterId: string; defs: readonly ManifestRouteTemplateDef[] }[],
  directTools: readonly Pick<CatalogTool, 'name' | 'aliases' | 'safety' | 'requiresConfirmation'>[],
  disabledTools: ReadonlySet<string> = new Set<string>(),
): ManifestTemplateIndex {
  const templates: CompiledRouteTemplate[] = []
  const skipped: TemplateIssue[] = []
  const warnings: TemplateIssue[] = []
  const seenIds = new Set<string>()
  const canonicalByTool = new Map<string, string>()
  for (const tool of directTools) {
    if (tool.name && !canonicalByTool.has(tool.name)) canonicalByTool.set(tool.name, tool.name)
  }
  for (const tool of directTools) {
    if (!tool.name) continue
    for (const alias of tool.aliases) {
      if (alias && !canonicalByTool.has(alias)) canonicalByTool.set(alias, tool.name)
    }
  }
  // 红线：只读准入。写操作 / 需确认的工具不进路由面，模板引用它们一律 TPL_TOOL_NOT_READONLY。
  for (const tool of directTools) {
    if (tool.safety === 'read' && tool.requiresConfirmation !== true) {
      canonicalByTool.set(`${tool.name}${READONLY_SUFFIX}`, tool.name)
    }
  }

  outer: for (const { adapterId, defs } of raw) {
    if (!Array.isArray(defs)) continue
    for (const def of defs) {
      if (templates.length >= MAX_TEMPLATES) {
        skipped.push({
          adapterId,
          id: '',
          code: 'TPL_SIZE_LIMIT',
          detail: `模板总数超过 ${MAX_TEMPLATES}，停止加载`,
        })
        break outer
      }
      const result = compileTemplate(def, adapterId, canonicalByTool, disabledTools, seenIds, warnings)
      if (result.skipped) skipped.push(result.skipped)
      if (result.template) {
        seenIds.add(result.template.id)
        templates.push(result.template)
      }
    }
  }

  return { templates, skipped, warnings }
}

/**
 * Tier -2 匹配：message trim 后逐条锚定全等（adapter 顺序 → 数组顺序，首中即返）。
 * index 为空即零开销返回 null（不落 fast-path）。
 */
export function matchManifestTemplate(
  message: string,
  index: ManifestTemplateIndex | null | undefined,
): ManifestTemplateMatch | null {
  if (!index || index.templates.length === 0) return null
  const text = (message ?? '').trim()
  if (!text) return null
  for (const template of index.templates) {
    let match: RegExpExecArray | null
    try {
      match = template.regex.exec(text)
    } catch {
      continue
    }
    if (!match) continue
    // 正则本身已锚定，此处防御 exec 行为差异：捕获整体必须覆盖全文
    if (match[0] !== text) continue
    const extracted = extractTemplateArgs(match, template)
    if (extracted) return { template, ...extracted }
  }
  return null
}

/** 从 exec 结果抽槽位参数并合并（shared args ← 枚举槽 ← 自由槽）。防御性失败返回 null。 */
function extractTemplateArgs(
  match: RegExpExecArray,
  template: CompiledRouteTemplate,
): { args: Record<string, unknown>; slotValues: ManifestTemplateMatch['slotValues'] } | null {
  const args: Record<string, unknown> = { ...template.args }
  const slotValues: ManifestTemplateMatch['slotValues'] = []
  for (const group of template.groups) {
    const raw = match.groups?.[group.name]
    if (raw === undefined) return null
    if (group.kind === 'enum') {
      const extra = template.enumArgs[raw]
      if (!extra) return null // 编译期已保证覆盖；防御 enumArgs 被运行时改动
      Object.assign(args, extra)
      slotValues.push({ name: raw, kind: 'enum', raw })
    } else {
      if (!group.validateRe.test(raw)) return null
      args[group.arg] = raw
      slotValues.push({ name: group.slot, kind: 'free', raw })
    }
  }
  return { args, slotValues }
}

// ── 生产索引：按 adapters 目录签名缓存（改 manifest → 下次决策即生效）──────────

type IndexCache = { signature: string; index: ManifestTemplateIndex }
let cache: IndexCache | null = null

/** 生产索引入口：目录签名变化即重建。 */
export function getManifestTemplateIndex(disabledTools: ReadonlySet<string> = new Set<string>()): ManifestTemplateIndex {
  const catalog = getCatalog()
  const signature = `${catalog.directTools.length}|${catalog.tools.length}|${[...disabledTools].sort().join(',')}|${adapterTemplateSignature()}`
  if (cache && cache.signature === signature) return cache.index

  const raw: { adapterId: string; defs: ManifestRouteTemplateDef[] }[] = []
  for (const [adapterId, adapter] of parseAllAdapters()) {
    if (adapter.routeTemplates?.length) raw.push({ adapterId, defs: adapter.routeTemplates })
  }
  const index = buildManifestTemplateIndex(raw, catalog.directTools, disabledTools)
  cache = { signature, index }

  if (index.skipped.length || index.warnings.length) {
    const detail =
      index.skipped.map((s) => `\n  [skip] ${s.adapterId}/${s.id || '(no id)'}: ${s.code} ${s.detail}`).join('') +
      index.warnings.map((w) => `\n  [warn] ${w.adapterId}/${w.id}: ${w.code} ${w.detail}`).join('')
    log.warn(`route_templates: ${index.templates.length} 生效, ${index.skipped.length} 跳过, ${index.warnings.length} 告警${detail}`)
  } else {
    log.info(`route_templates loaded: ${index.templates.length} template(s)`)
  }
  return index
}

/** manifest 内容签名：route_templates 变化必须能失效缓存。 */
function adapterTemplateSignature(): string {
  const parts: string[] = []
  try {
    for (const [adapterId, adapter] of parseAllAdapters()) {
      parts.push(`${adapterId}:${JSON.stringify(adapter.routeTemplates ?? [])}`)
    }
  } catch {
    return '-'
  }
  return parts.sort().join(';')
}

/** 测试钩子：重置懒加载索引。 */
export function resetManifestTemplatesForTests(): void {
  cache = null
}
