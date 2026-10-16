/**
 * 配置的「按 Adapter 分节」形态：归一化展开。
 *
 * 背景：一份文件里所有 Adapter 的条目混在一起。新增一个 Adapter 时要在几百行里找位置插，
 * 且很容易把「这条到底属于哪个站」写错（写错就会拿到别的站的工具，是误判的一个来源）。
 *
 * 因此改为**按 Adapter 分节**的书写形态。两种层形态各有一套分节写法：
 *
 * ```jsonc
 * // ① 数组型层（routes / aliases / shortcuts / plans）：分节值是条目数组
 * {
 *   "news.ycombinator.com": [
 *     { "id": "hn-top", "tool": "news.ycombinator.com.top", "examples": ["hn头条"] }
 *   ],
 *   "v2ex.com": [ /* … *\/ ]
 * }
 *
 * // ② 记录型层（patterns 的 `configs`）：分节值是「工具名 → 配置」的对象
 * {
 *   "news.ycombinator.com": {
 *     "news.ycombinator.com.search": { "patterns": [ … ] },
 *     "news.ycombinator.com.user":   { "patterns": [ … ] }
 *   }
 * }
 * ```
 *
 * 本模块把它展开回扁平结构，**下游（validate / cascade / replay / routable）零改动**，
 * 分节只是书写方式，不是新的数据结构。
 *
 * 三条硬约束（都是为了让误写「当场撞墙」而不是静默生效）：
 *   1. **兼容旧形态**：`field` 已是数组／已是以完整工具名为 key 的记录则原样返回，
 *      外部注入配置（`WEWORKER_QUERY_ROUTES_CONFIG`）与用户覆盖层不受影响；
 *   2. **分节归属必须自洽**：分节 key 是 Adapter，条目自报的身份（`adapterId` / `tool` 前缀 /
 *      记录型层的 key 前缀）必须与之相符，否则报错——杜绝「hn 的条目写进 v2ex 分节」这类错位；
 *   3. **幂等**：归一化结果再归一化不变，因此可以安全地「读时展开 + 合并后校验」。
 *
 * 归一化失败**不抛异常**，而是把原因并入校验错误：交给 loader 走「坏配置只回退该层」的既有
 * 通道，避免一个手误让整条路由链失效。
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type AdapterGroupedExpansion = {
  /** 展开后的层对象；已是数组或非分节形态时原样返回 */
  raw: unknown
  /** 分节书写相关的错误；空数组表示这一层形态正确 */
  errors: string[]
  /** 是否真的做了展开（用于日志与测试断言） */
  expanded: boolean
}

/**
 * 校验一条条目是否确实属于 `adapterId` 分节。
 *
 * 两种自报身份，按优先级取：`adapterId`（plans 形态显式声明）→ `tool` 前缀
 * （routes/aliases/shortcuts 形态，工具名本身就是 `<adapterId>.<toolName>`）。
 * 都没有时报错：分节形态下不允许「身份不明」的条目，否则归属校验形同虚设。
 *
 * `tool` → 归属**取最后一个点之前的部分**，而不是「以 `adapterId + '.'` 开头」：
 * 后者会把 `a.com.cn.t` 放进 `a.com` 分节视为合法（存在 `a.com` / `a.com.cn`
 * 这类同前缀站点时归属就漏判了）。工具名由 `<adapterName>.<commandId>` 拼成，
 * 而 commandId 不含点（全仓 331 个 command 已核），故反推是确定的。
 */
function checkSectionOwnership(entry: Record<string, unknown>, adapterId: string, label: string, errors: string[]): void {
  const declared = entry.adapterId
  if (typeof declared === 'string') {
    if (declared !== adapterId) {
      errors.push(`${label}.adapterId is "${declared}" but it sits under section "${adapterId}"`)
    }
    return
  }

  const tool = entry.tool
  if (typeof tool === 'string' && tool) {
    const dot = tool.lastIndexOf('.')
    const owner = dot > 0 ? tool.slice(0, dot) : ''
    if (owner !== adapterId) {
      errors.push(`${label}.tool "${tool}" belongs to "${owner || '(unknown)'}", not to section "${adapterId}"`)
    }
    return
  }

  errors.push(`${label} must declare either "adapterId" or "tool" so its adapter section can be verified`)
}

/** 层对象里除条目容器外的合法顶层键：不该被误认成「分节放错了位置」。 */
const NON_SECTION_KEYS = new Set(['version', 'note', 'global', 'schemaVersion', '$schema', 'layers'])

/** 该键的值是否「看着就是一份 adapter 分节」：对象数组，且条目自报 `tool` 或 `adapterId`。 */
function looksLikeSection(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false
  return value.every(
    (entry) => isPlainObject(entry) && (typeof entry.tool === 'string' || typeof entry.adapterId === 'string'),
  )
}

/**
 * 层字段缺席时的兜底诊断。
 *
 * 这是**最容易犯且最难发现**的配置错误：把 adapter 分节写在了文件顶层
 * （`{ "wikipedia.org": [ … ] }`）而不是嵌在层字段下（`{ "routes": { "wikipedia.org": [ … ] } }`）。
 * 校验收到的层对象里 `routes` 字段缺席 → 各层校验器（如 `validateRoutesFile`）都按
 * 「这层没配条目」放行 → **整层静默失效，没有任何报错**，路由悄悄退回 LLM。
 *
 * 故此处主动识别该形态并报错，让它走「坏配置只回退该层」的通道：
 * 至少测试期会红、日志里有痕，而不是配了几十条却一条都不生效。
 */
function misplacedSectionErrors(raw: Record<string, unknown>, field: string): string[] {
  const suspects = Object.keys(raw)
    .filter((key) => !NON_SECTION_KEYS.has(key) && looksLikeSection(raw[key]))
  if (suspects.length === 0) return []
  return [
    `"${field}" is missing, but top-level key(s) ${suspects.map((key) => `"${key}"`).join(', ')} ` +
      `look like adapter section(s) placed one level too high — nest them under "${field}", ` +
      `e.g. { "${field}": { "${suspects[0]}": [ … ] } }`,
  ]
}

/**
 * 把 `{ "<adapterId>": [ 条目… ] }` 展开为扁平数组；已是数组则原样返回。
 *
 * @param raw   层对象的原始解析结果
 * @param field 该层承载条目的字段名（如 `routes` / `aliases` / `shortcuts` / `plans`）
 */

export function expandAdapterGroupedField(raw: unknown, field: string): AdapterGroupedExpansion {
  if (!isPlainObject(raw)) return { raw, errors: [], expanded: false }

  const value = raw[field]
  if (value === undefined) {
    return { raw, errors: misplacedSectionErrors(raw, field), expanded: false }
  }
  if (Array.isArray(value)) return { raw, errors: [], expanded: false }
  if (!isPlainObject(value)) {
    return { raw, errors: [`"${field}" must be an array or an adapter-keyed object`], expanded: false }
  }

  const errors: string[] = []
  const flat: unknown[] = []

  for (const [adapterId, entries] of Object.entries(value)) {
    const sectionLabel = `${field}.${adapterId}`
    // 覆盖层删除标记：`null` 表示「这个分节本次不提供条目」，与空数组等价。
    if (entries === null) continue
    if (!Array.isArray(entries)) {
      errors.push(`"${sectionLabel}" must be an array of entries`)
      continue
    }
    entries.forEach((entry, index) => {
      const label = `${sectionLabel}[${index}]`
      if (!isPlainObject(entry)) {
        errors.push(`${label} must be an object`)
        return
      }
      checkSectionOwnership(entry, adapterId, label, errors)
      flat.push(entry)
    })
  }

  return { raw: { ...raw, [field]: flat }, errors, expanded: true }
}

// ── 记录型层（`patterns.json` 的 `configs`）的分节形态 ────────────────────────
//
// 这一层的「旧形态」是 `{ "<完整工具名>": 配置 }`——key 里已经写了 adapter 归属。
// 分节形态把归属**提出来当分组**：`{ "<adapterId>": { "<完整工具名>": 配置 } }`。
//
// 内层 key 仍保留完整工具名（而不是缩写成 `search`）：一来与数组型层保持一致
// （那边的条目也自带完整 `tool`），二来 key → 工具名保持字面一致，grep / `jq`/ 既有
// 用户覆盖层与外部注入配置都不用改。
//
// 为什么只有 patterns 走这条通道：`renderers.schemas` 的 key 是跨工具复用的 schemaId，
// 不归任何 adapter；`plan-terminals.adapters` 本来就已按 adapter 分节。

/**
 * 一条 patterns 配置的「已知字段」。用它来判定 `configs` 下某个 key 是**工具名**还是
 * **adapter 分节**——两层的 key 都带点（`wikipedia.org` / `wikipedia.org.search`），
 * 数点数靠不住，只能看值本身的形状。
 */
const RECORD_ENTRY_KEYS = ['patterns', 'priority', 'negative_patterns', 'arg_extractors', 'default_args', 'enabled']

function looksLikeRecordEntry(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  return Object.keys(value).some((key) => RECORD_ENTRY_KEYS.includes(key))
}

/**
 * 该值是否「看着就是一份记录型分节」：非空对象，且每个成员要么是配置条目、要么是 `null`
 * （覆盖层的删除标记）。要求非空——空对象说明不了任何事，宁可报错让人写清楚。
 *
 * 必须先跑 `looksLikeRecordEntry`：`{ "default_args": {…} }` 这种「只写了默认参数」的
 * 条目成员全是对象，否则会被误判成分节。
 */
function looksLikeRecordSection(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false
  const values = Object.values(value)
  if (values.length === 0) return false
  return values.every((item) => item === null || isPlainObject(item))
}

/**
 * 校验 `configs` 下的内层 key（完整工具名）确实属于该分节。
 *
 * 判据与数组型层同源：工具名由 `<adapterName>.<commandId>` 拼成，commandId 不含点，
 * 故「去掉最后一段」反推出的 owner 必须逐字等于分节 key。**不能**用
 * `startsWith(adapterId + '.')`：存在 `a.com` 与 `a.com.cn` 这类同前缀站点时，
 * 后者会被前者「吃掉」。
 */
function checkRecordSectionOwnership(toolName: string, adapterId: string, label: string, errors: string[]): void {
  const dot = toolName.lastIndexOf('.')
  const owner = dot > 0 ? toolName.slice(0, dot) : ''
  if (owner !== adapterId) {
    errors.push(`${label} "${toolName}" belongs to "${owner || '(unknown)'}", not to section "${adapterId}"`)
  }
}

/** 记录型层的「分节写高了一层」诊断（`configs` 缺席但顶层看着像分节）。 */
function misplacedRecordSectionErrors(raw: Record<string, unknown>, field: string): string[] {
  const suspects = Object.keys(raw)
    .filter((key) => !NON_SECTION_KEYS.has(key) && looksLikeRecordSection(raw[key]))
  if (suspects.length === 0) return []
  return [
    `"${field}" is missing, but top-level key(s) ${suspects.map((key) => `"${key}"`).join(', ')} ` +
      `look like adapter section(s) placed one level too high — nest them under "${field}", ` +
      `e.g. { "${field}": { "${suspects[0]}": { "<tool>": { … } } } }`,
  ]
}

/**
 * 把 `{ "<adapterId>": { "<完整工具名>": 配置 } }` 展开为 `{ "<完整工具名>": 配置 }`；
 * 已是记录形态则原样返回。两种形态允许**逐 key 混写**（用户覆盖层在分节基线上补一条扁平
 * 条目是很自然的用法），因此判定是按 key 逐个做的，不是整份文件二选一。
 *
 * @param raw   层对象的原始解析结果
 * @param field 该层承载条目的字段名（`patterns` 为 `configs`）
 */
export function expandAdapterGroupedRecordField(raw: unknown, field: string): AdapterGroupedExpansion {
  if (!isPlainObject(raw)) return { raw, errors: [], expanded: false }

  const value = raw[field]
  if (value === undefined) {
    return { raw, errors: misplacedRecordSectionErrors(raw, field), expanded: false }
  }
  if (!isPlainObject(value)) return { raw, errors: [`"${field}" must be an object keyed by tool name`], expanded: false }

  const errors: string[] = []
  const flat: Record<string, unknown> = {}
  let expanded = false

  for (const [key, item] of Object.entries(value)) {
    // 旧形态：key 本身就是完整工具名。`null` 是覆盖层的删除标记。
    if (item === null || looksLikeRecordEntry(item)) {
      flat[key] = item
      continue
    }
    if (!looksLikeRecordSection(item)) {
      errors.push(
        `"${field}.${key}" is neither a config entry (needs one of: ${RECORD_ENTRY_KEYS.join(' / ')}) ` +
          `nor an adapter section ({ "<adapterId>": { "<adapterId>.<tool>": { … } } })`,
      )
      continue
    }

    expanded = true
    for (const [toolName, entry] of Object.entries(item)) {
      const label = `${field}.${key}`
      if (entry === null) {
        flat[toolName] = null // 删除标记同样交给合并逻辑消费
        continue
      }
      if (!isPlainObject(entry)) {
        errors.push(`"${label}"."${toolName}" must be an object or null`)
        continue
      }
      checkRecordSectionOwnership(toolName, key, label, errors)
      if (Object.prototype.hasOwnProperty.call(flat, toolName)) {
        errors.push(`"${toolName}" is configured more than once (spread across sections or mixed with the flat form)`)
        continue
      }
      flat[toolName] = entry
    }
  }

  if (!expanded) return { raw, errors, expanded: false }
  return { raw: { ...raw, [field]: flat }, errors, expanded: true }
}
