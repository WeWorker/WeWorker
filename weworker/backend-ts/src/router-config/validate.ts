/**
 * 智能路由配置校验与作用域过滤。
 *
 * 两条原则：
 * 1. 坏配置不得让路由层整体失效——校验只产出「原因列表」，由加载器决定保留上一份可用配置。
 * 2. 配置项只对「当前实际存在的 Adapter」生效——不在当前 Adapter 集合里的条目一律丢弃并记原因，
 *    避免一份通用配置在缺 Adapter 的 Profile 上被误判为缺参/鉴权失败。
 */

import {
  ROUTER_CONFIG_SCHEMA_VERSION,
  type AliasesFile,
  type PlanTerminalsFile,
  type PlansFile,
  type PatternsFile,
  type RenderersFile,
  type RouteEntry,
  type RoutesFile,
  type ScenarioRoutesFile,
  type ShortcutEntry,
  type ShortcutsFile,
} from './types.js'

export type RouterConfigEntryScope = {
  /** 当前生效的 Adapter id 集合（如 github.com） */
  adapterIds: ReadonlySet<string>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function checkString(value: unknown, label: string, errors: string[], { allowEmpty = false } = {}): void {
  if (value === undefined) return
  if (typeof value !== 'string') {
    errors.push(`${label} must be a string`)
    return
  }
  if (!allowEmpty && value.trim() === '') errors.push(`${label} must not be empty`)
}

function checkBoolean(value: unknown, label: string, errors: string[]): void {
  if (value === undefined) return
  if (typeof value !== 'boolean') errors.push(`${label} must be a boolean`)
}

function checkFiniteNumber(value: unknown, label: string, errors: string[]): void {
  if (value === undefined) return
  if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`${label} must be a finite number`)
}

function checkStringArray(value: unknown, label: string, errors: string[]): void {
  if (value === undefined) return
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    errors.push(`${label} must be a string array`)
  }
}

function checkObject(value: unknown, label: string, errors: string[]): void {
  if (value === undefined) return
  if (!isPlainObject(value)) errors.push(`${label} must be an object`)
}

/** 校验正/负向正则可在加载期编译；错误的正则不得等到匹配时才炸 */
function checkRegexList(value: unknown, label: string, errors: string[]): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array of regex strings`)
    return
  }
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string') {
      errors.push(`${label}[${index}] must be a string`)
      continue
    }
    try {
      new RegExp(item)
    } catch (error) {
      errors.push(`${label}[${index}] is not a valid regex: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function checkPatternSpec(value: unknown, label: string, errors: string[]): void {
  if (value === undefined) return
  if (!isPlainObject(value)) {
    errors.push(`${label} must be an object`)
    return
  }
  checkRegexList(value.positive, `${label}.positive`, errors)
  checkRegexList(value.negative, `${label}.negative`, errors)
}

function checkRenderSpec(value: unknown, label: string, errors: string[]): void {
  if (value === undefined) return
  if (!isPlainObject(value)) {
    errors.push(`${label} must be an object`)
    return
  }
  const type = value.type
  if (type !== undefined && type !== 'generic' && type !== 'schema') {
    errors.push(`${label}.type must be "generic" or "schema"`)
  }
  checkString(value.schemaId, `${label}.schemaId`, errors)
  if (type === 'schema' && typeof value.schemaId !== 'string') {
    errors.push(`${label}.schemaId is required when ${label}.type is "schema"`)
  }
}

function checkExtractRules(value: unknown, label: string, errors: string[]): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`)
    return
  }
  for (const [index, item] of value.entries()) {
    const itemLabel = `${label}[${index}]`
    if (!isPlainObject(item)) {
      errors.push(`${itemLabel} must be an object`)
      continue
    }
    if (typeof item.regex !== 'string') {
      errors.push(`${itemLabel}.regex must be a string`)
    } else {
      try {
        new RegExp(item.regex, typeof item.flags === 'string' ? item.flags : undefined)
      } catch (error) {
        errors.push(`${itemLabel}.regex is not a valid regex: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    checkString(item.arg, `${itemLabel}.arg`, errors)
    if (item.from !== undefined && item.from !== 'message') {
      errors.push(`${itemLabel}.from must be "message"`)
    }
    if (item.type !== undefined && !['string', 'integer', 'number', 'boolean'].includes(String(item.type))) {
      errors.push(`${itemLabel}.type must be one of string|integer|number|boolean`)
    }
    checkFiniteNumber(item.min, `${itemLabel}.min`, errors)
    checkFiniteNumber(item.max, `${itemLabel}.max`, errors)
  }
}

// ── 防污染校验 ──────────────────────────────────────────────────────────────
//
// 这一节回答的是「加配置的人会把路由层写坏吗」。四类真实事故：
//
//   ① 凭印象加一条词，既没示例也没验证 → 上线后从来没命中过，无人发现（死条目）；
//   ② 「热榜」这种裸词先命中，把「头条热榜」的长词永远挡在后面（遮蔽）；
//   ③ 两条指向不同工具的条目用了同一个词 → 先命中者赢，另一条永远拿不到；
//   ④ 条目写进了别的 adapter 的分节 → 归属错位（由 `adapter-grouped.ts` 负责）。
//
// 前三条在本文件拦（配置一写错就整层回退并记原因），第四条在归一化时拦。
// 剩下的「示例真的能命中吗」由 `shipped-router-config.test.ts` 拿 examples 当正例实跑。

/** 取字符串数组里的非空串；非数组或含非字符串元素一律视为空（类型错误已由 checkStringArray 报） */
function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
}

/**
 * `examples` 必填且非空。
 *
 * 这是「每条配置都要有成功示例」的落点。示例不用来给人看（那是文件头注释的活），
 * 而是**这条配置的适用边界**：写不出示例往往说明这条配置本来就不该加。
 */
function checkExamples(value: unknown, label: string, errors: string[]): void {
  if (value === undefined) {
    errors.push(
      `${label} is required: 写一条「应当命中本条」的完整原文（如 "hn头条"），` +
        '它会作为正例进硬门实跑；写不出来说明这条配置还不该加',
    )
    return
  }
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${label} must be a non-empty string array`)
    return
  }
  value.forEach((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      errors.push(`${label}[${index}] must be a non-empty string`)
    }
  })
}

/** 词归一化：与层 P 的包含匹配同口径（去全部空白 + 小写） */
function normalizeTerm(term: string): string {
  return term.replace(/\s+/g, '').toLowerCase()
}

/**
 * 包含式匹配词的最小长度（归一化后）。
 *
 * 「新闻」「列表」「热榜」这类裸词会被任意一句含同词的话命中，命中一次就把用户钉死在
 * 错误的路由上，而它省下的只是几个字。宁可要求写全「36氪资讯」这种带站点限定的词。
 */
const MIN_CONTAINMENT_TERM_LENGTH = 3

type TermOwner = { label: string; tool: string; term: string }

/**
 * 包含式匹配词的冲突检测（第 ①②③ 类事故）。
 *
 * 只比较**指向不同工具**的条目：同一工具的多个词互为子串是正常的（如 `hackernews最佳`
 * 与 `hackernews最佳帖子` 同属一条）。工具不同时，先命中者赢，另一条永远拿不到——
 * 而这种「配了不生效」不带任何日志，是最难排查的一类。
 */
function checkTermConflicts(owners: TermOwner[], errors: string[]): void {
  const items = owners.map((owner) => ({ ...owner, key: normalizeTerm(owner.term) }))

  for (const item of items) {
    if (!item.key) {
      errors.push(`${item.label} 的匹配词是空白串`)
    } else if (item.key.length < MIN_CONTAINMENT_TERM_LENGTH) {
      errors.push(
        `${item.label} 的匹配词 "${item.term}" 归一化后仅 ${item.key.length} 个字符（至少 ${MIN_CONTAINMENT_TERM_LENGTH}）：` +
          '裸词会大面积误伤，请写成带站点或限定语的词',
      )
    }
  }

  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i]!
      const b = items[j]!
      if (!a.key || !b.key || a.tool === b.tool) continue
      if (a.key === b.key) {
        errors.push(
          `${a.label} 与 ${b.label} 的匹配词相同（"${a.key}"）但工具不同（${a.tool} / ${b.tool}）：` +
            '先命中者赢，另一条永远拿不到',
        )
        continue
      }
      const [shorter, longer] = a.key.length < b.key.length ? [a, b] : [b, a]
      if (longer.key.includes(shorter.key)) {
        errors.push(
          `${shorter.label} 的匹配词 "${shorter.term}" 是 ${longer.label} 的 "${longer.term}" 的子串，且工具不同` +
            `（${shorter.tool} / ${longer.tool}）：短的先命中，长的永远拿不到`,
        )
      }
    }
  }
}

/** 全等式匹配词的重复检测：`!别名` 走全等，重名即死条目（不改最小长度约束） */
function checkExactDuplicates(owners: TermOwner[], errors: string[]): void {
  const seen = new Map<string, TermOwner>()
  for (const owner of owners) {
    const key = normalizeTerm(owner.term)
    if (!key) continue
    const previous = seen.get(key)
    if (!previous) {
      seen.set(key, owner)
      continue
    }
    if (previous.tool !== owner.tool) {
      errors.push(
        `${owner.label} 的 "${owner.term}" 与 ${previous.label} 重复但工具不同（${previous.tool} / ${owner.tool}）：` +
          '先命中者赢，另一条永远拿不到',
      )
    }
  }
}

/** 同层内 id 必须唯一：重复 id 会被覆盖层合并按 id 静默覆盖，表现为「配了两条只生效一条」 */
function checkUniqueIds(items: { label: string; id: unknown }[], errors: string[]): void {
  const seen = new Map<string, string>()
  for (const { label, id } of items) {
    if (typeof id !== 'string' || !id) continue
    const previous = seen.get(id)
    if (previous) {
      errors.push(`${label}.id "${id}" 与 ${previous} 重复：同层 id 必须唯一，否则会被静默覆盖`)
      continue
    }
    seen.set(id, label)
  }
}

/**
 * 正则全等重复检测。
 *
 * `flagSameTool=false`（shortcut 层）：同一工具的重复正则只是冗余，跨工具才是死条目；
 * `flagSameTool=true`（plan 层）：plan 一旦命中就整条接管，同一 adapter 下两条同正则的
 * 入口必然有一条永远轮不到，故只要重复就报。
 */
function checkDuplicateRegexes(
  items: { label: string; tool: string; regex: string }[],
  errors: string[],
  { flagSameTool = false }: { flagSameTool?: boolean } = {},
): void {
  const seen = new Map<string, { label: string; tool: string }>()
  for (const item of items) {
    if (!item.regex) continue
    const previous = seen.get(item.regex)
    if (!previous) {
      seen.set(item.regex, { label: item.label, tool: item.tool })
      continue
    }
    if (flagSameTool || previous.tool !== item.tool) {
      const scope = previous.tool === item.tool ? `同属 ${item.tool}` : `${previous.tool} / ${item.tool}`
      errors.push(
        `${item.label} 的入口正则与 ${previous.label} 完全相同（${scope}）：先判定者赢，另一条永远轮不到`,
      )
    }
  }
}

// ── 逐层校验 ────────────────────────────────────────────────────────────────

function validateRouteEntry(entry: unknown, label: string, errors: string[]): void {
  if (!isPlainObject(entry)) {
    errors.push(`${label} must be an object`)
    return
  }
  checkString(entry.id, `${label}.id`, errors)
  checkString(entry.tool, `${label}.tool`, errors)
  checkBoolean(entry.enabled, `${label}.enabled`, errors)
  checkString(entry.title, `${label}.title`, errors)
  checkObject(entry.args, `${label}.args`, errors)
  if (entry.match !== undefined) {
    if (!isPlainObject(entry.match)) {
      errors.push(`${label}.match must be an object`)
    } else {
      checkStringArray(entry.match.aliases, `${label}.match.aliases`, errors)
      checkStringArray(entry.match.keywords, `${label}.match.keywords`, errors)
    }
  }
  checkRenderSpec(entry.render, `${label}.render`, errors)
}

export function validateRoutesFile(raw: unknown): string[] {
  const errors: string[] = []
  if (!isPlainObject(raw)) return ['routes.json must be an object']
  if (raw.routes !== undefined) {
    if (!Array.isArray(raw.routes)) {
      errors.push('"routes" must be an array')
    } else {
      const ids: { label: string; id: unknown }[] = []
      const keywords: TermOwner[] = []
      const aliases: TermOwner[] = []
      raw.routes.forEach((entry, index) => {
        const label = `routes[${index}]`
        validateRouteEntry(entry, label, errors)
        if (!isPlainObject(entry)) return
        checkExamples(entry.examples, `${label}.examples`, errors)
        ids.push({ label, id: entry.id })
        const tool = typeof entry.tool === 'string' ? entry.tool : ''
        if (isPlainObject(entry.match)) {
          // keywords 走包含匹配 → 参与子串遮蔽检测；aliases 走全等 → 只判重复
          for (const term of stringsOf(entry.match.keywords)) keywords.push({ label: `${label}.match.keywords`, tool, term })
          for (const term of stringsOf(entry.match.aliases)) aliases.push({ label: `${label}.match.aliases`, tool, term })
        }
      })
      checkUniqueIds(ids, errors)
      checkTermConflicts(keywords, errors)
      checkExactDuplicates(aliases, errors)
    }
  }
  return errors
}

export function validateAliasesFile(raw: unknown): string[] {
  const errors: string[] = []
  if (!isPlainObject(raw)) return ['aliases.json must be an object']
  if (raw.aliases !== undefined) {
    if (!Array.isArray(raw.aliases)) {
      errors.push('"aliases" must be an array')
    } else {
      const ids: { label: string; id: unknown }[] = []
      const aliases: TermOwner[] = []
      raw.aliases.forEach((entry, index) => {
        const label = `aliases[${index}]`
        if (!isPlainObject(entry)) {
          errors.push(`${label} must be an object`)
          return
        }
        checkString(entry.id, `${label}.id`, errors)
        checkString(entry.tool, `${label}.tool`, errors)
        checkBoolean(entry.enabled, `${label}.enabled`, errors)
        checkObject(entry.args, `${label}.args`, errors)
        checkRenderSpec(entry.render, `${label}.render`, errors)
        checkExamples(entry.examples, `${label}.examples`, errors)
        ids.push({ label, id: entry.id })
        if (entry.alias !== undefined) {
          if (typeof entry.alias !== 'string' || !entry.alias.startsWith('!')) {
            errors.push(`${label}.alias must be a string starting with "!"`)
          } else {
            aliases.push({ label: `${label}.alias`, tool: typeof entry.tool === 'string' ? entry.tool : '', term: entry.alias })
          }
        }
      })
      checkUniqueIds(ids, errors)
      checkExactDuplicates(aliases, errors)
    }
  }
  return errors
}

export function validateShortcutsFile(raw: unknown): string[] {
  const errors: string[] = []
  if (!isPlainObject(raw)) return ['shortcuts.json must be an object']
  if (raw.shortcuts !== undefined) {
    if (!Array.isArray(raw.shortcuts)) {
      errors.push('"shortcuts" must be an array')
    } else {
      const ids: { label: string; id: unknown }[] = []
      const positives: { label: string; tool: string; regex: string }[] = []
      raw.shortcuts.forEach((entry: unknown, index: number) => {
        const label = `shortcuts[${index}]`
        if (!isPlainObject(entry)) {
          errors.push(`${label} must be an object`)
          return
        }
        checkString(entry.id, `${label}.id`, errors)
        checkString(entry.tool, `${label}.tool`, errors)
        checkBoolean(entry.enabled, `${label}.enabled`, errors)
        checkFiniteNumber(entry.priority, `${label}.priority`, errors)
        checkObject(entry.args, `${label}.args`, errors)
        checkPatternSpec(entry.patterns, `${label}.patterns`, errors)
        checkExtractRules(entry.extract, `${label}.extract`, errors)
        checkRenderSpec(entry.render, `${label}.render`, errors)
        checkExamples(entry.examples, `${label}.examples`, errors)
        ids.push({ label, id: entry.id })
        // 本层的匹配是「正则 + 门槛」，故不做子串检测（正则之间无法按子串判定遮蔽），
        // 只拦「同一正则原样抄第二遍」这种确定的死条目；真正的遮蔽由负例硬门实跑发现。
        if (isPlainObject(entry.patterns)) {
          const tool = typeof entry.tool === 'string' ? entry.tool : ''
          for (const regex of stringsOf(entry.patterns.positive)) {
            positives.push({ label: `${label}.patterns.positive`, tool, regex })
          }
        }
      })
      checkUniqueIds(ids, errors)
      checkDuplicateRegexes(positives, errors)
    }
  }
  return errors
}

export function validatePatternsFile(raw: unknown): string[] {
  const errors: string[] = []
  if (!isPlainObject(raw)) return ['patterns.json must be an object']
  if (raw.global !== undefined) {
    if (!isPlainObject(raw.global)) {
      errors.push('"global" must be an object')
    } else {
      checkBoolean(raw.global.case_sensitive, 'global.case_sensitive', errors)
      checkFiniteNumber(raw.global.min_confidence_for_match, 'global.min_confidence_for_match', errors)
    }
  }
  if (raw.configs === undefined) return errors
  if (!isPlainObject(raw.configs)) return [...errors, '"configs" must be an object keyed by tool name']

  // 走到这里的 `configs` 已被 loader 归一化成「工具名为 key」的扁平记录（文件里是按
  // adapter 分节的 `{ "<adapterId>": { "<工具名>": … } }`，分节归属另有校验）；
  // keywords 型规则参与跨工具遮蔽检测
  const keywords: TermOwner[] = []

  for (const [tool, config] of Object.entries(raw.configs)) {
    const label = `configs["${tool}"]`
    if (!isPlainObject(config)) {
      errors.push(`${label} must be an object`)
      continue
    }
    checkBoolean(config.enabled, `${label}.enabled`, errors)
    checkFiniteNumber(config.priority, `${label}.priority`, errors)
    checkObject(config.default_args, `${label}.default_args`, errors)
    checkRegexList(config.negative_patterns, `${label}.negative_patterns`, errors)
    if (config.patterns !== undefined) {
      if (!Array.isArray(config.patterns)) {
        errors.push(`${label}.patterns must be an array`)
      } else {
        config.patterns.forEach((rule: unknown, index: number) => {
          const ruleLabel = `${label}.patterns[${index}]`
          if (!isPlainObject(rule)) {
            errors.push(`${ruleLabel} must be an object`)
            return
          }
          if (rule.type !== 'regex' && rule.type !== 'keyword') {
            errors.push(`${ruleLabel}.type must be "regex" or "keyword"`)
            return
          }
          if (rule.type === 'regex') {
            if (typeof rule.expression !== 'string') {
              errors.push(`${ruleLabel}.expression must be a string`)
            } else {
              try {
                new RegExp(rule.expression, typeof rule.flags === 'string' ? rule.flags : undefined)
              } catch (error) {
                errors.push(
                  `${ruleLabel}.expression is not a valid regex: ${error instanceof Error ? error.message : String(error)}`,
                )
              }
            }
          } else {
            checkStringArray(rule.keywords, `${ruleLabel}.keywords`, errors)
            if (!Array.isArray(rule.keywords) || rule.keywords.length === 0) {
              errors.push(`${ruleLabel}.keywords must be a non-empty string array for keyword patterns`)
            }
            for (const term of stringsOf(rule.keywords)) {
              keywords.push({ label: `${ruleLabel}.keywords`, tool, term })
            }
            if (rule.match_mode !== undefined && !['any', 'all', 'phrase'].includes(rule.match_mode as string)) {
              errors.push(`${ruleLabel}.match_mode must be one of "any" / "all" / "phrase"`)
            }
          }
          checkFiniteNumber(rule.weight, `${ruleLabel}.weight`, errors)
          // 逐条规则都要有成功示例：本层是正则/关键词层，示例是**唯一**能证明规则写对了的东西
          checkExamples(rule.examples, `${ruleLabel}.examples`, errors)
          checkObject(rule.default_args, `${ruleLabel}.default_args`, errors)
        })
      }
    }
    checkExtractRules(config.arg_extractors, `${label}.arg_extractors`, errors)
  }
  checkTermConflicts(keywords, errors)
  return errors
}

export function validatePlansFile(raw: unknown): string[] {
  const errors: string[] = []
  if (!isPlainObject(raw)) return ['plans.json must be an object']
  if (raw.plans === undefined) return errors
  if (!Array.isArray(raw.plans)) return ['"plans" must be an array']

  const planIds: { label: string; id: unknown }[] = []
  const planPositives: { label: string; tool: string; regex: string }[] = []

  raw.plans.forEach((plan: unknown, index: number) => {
    const label = `plans[${index}]`
    if (!isPlainObject(plan)) {
      errors.push(`${label} must be an object`)
      return
    }
    checkString(plan.id, `${label}.id`, errors)
    checkExamples(plan.examples, `${label}.examples`, errors)
    planIds.push({ label, id: plan.id })
    if (isPlainObject(plan.entry)) {
      const tool = typeof plan.adapterId === 'string' ? plan.adapterId : ''
      for (const regex of stringsOf(plan.entry.positive)) {
        planPositives.push({ label: `${label}.entry.positive`, tool, regex })
      }
    }
    checkBoolean(plan.enabled, `${label}.enabled`, errors)
    checkString(plan.adapterId, `${label}.adapterId`, errors)
    checkPatternSpec(plan.entry, `${label}.entry`, errors)
    if (isPlainObject(plan.entry) && plan.entry.terminal !== undefined) {
      checkString(plan.entry.terminal, `${label}.entry.terminal`, errors)
    }

    const terminalKeys = new Set<string>()
    if (Array.isArray(plan.terminals)) {
      for (const terminal of plan.terminals) {
        if (isPlainObject(terminal) && typeof terminal.key === 'string') terminalKeys.add(terminal.key)
      }
    }
    if (
      isPlainObject(plan.entry) &&
      typeof plan.entry.terminal === 'string' &&
      !terminalKeys.has(plan.entry.terminal)
    ) {
      errors.push(`${label}.entry.terminal "${plan.entry.terminal}" 不在本计划的 terminals 里`)
    }
    if (Array.isArray(plan.terminals) && plan.terminals.length === 0) {
      errors.push(`${label}.terminals 不能为空数组（没有可跑的终端）`)
    }

    const produced = new Set<string>()
    if (plan.resolvers !== undefined) {
      if (!Array.isArray(plan.resolvers)) {
        errors.push(`${label}.resolvers must be an array`)
      } else {
        plan.resolvers.forEach((resolver: unknown, rIndex: number) => {
          const rLabel = `${label}.resolvers[${rIndex}]`
          if (!isPlainObject(resolver)) {
            errors.push(`${rLabel} must be an object`)
            return
          }
          checkString(resolver.produces, `${rLabel}.produces`, errors)
          checkString(resolver.tool, `${rLabel}.tool`, errors)
          checkStringArray(resolver.needs, `${rLabel}.needs`, errors)
          checkObject(resolver.args, `${rLabel}.args`, errors)
          if (isPlainObject(resolver.extract)) {
            const pick = resolver.extract.pick
            if (pick !== undefined && !['name', 'latest', 'contains'].includes(String(pick))) {
              errors.push(`${rLabel}.extract.pick must be one of name|latest|contains`)
            }
            const onAmbiguous = resolver.extract.onAmbiguous
            if (onAmbiguous !== undefined && onAmbiguous !== 'ask' && onAmbiguous !== 'abort') {
              errors.push(`${rLabel}.extract.onAmbiguous must be "ask" or "abort"`)
            }
            checkString(resolver.extract.equals, `${rLabel}.extract.equals`, errors)
            checkString(resolver.extract.value, `${rLabel}.extract.value`, errors)
            checkString(resolver.extract.path, `${rLabel}.extract.path`, errors)
            checkString(resolver.extract.question, `${rLabel}.extract.question`, errors)
          } else if (resolver.extract !== undefined) {
            errors.push(`${rLabel}.extract must be an object`)
          }
          if (typeof resolver.produces === 'string') produced.add(resolver.produces)
        })
      }
    }

    if (plan.terminals !== undefined) {
      if (!Array.isArray(plan.terminals)) {
        errors.push(`${label}.terminals must be an array`)
      } else {
        plan.terminals.forEach((terminal: unknown, tIndex: number) => {
          const tLabel = `${label}.terminals[${tIndex}]`
          if (!isPlainObject(terminal)) {
            errors.push(`${tLabel} must be an object`)
            return
          }
          checkString(terminal.key, `${tLabel}.key`, errors)
          checkString(terminal.tool, `${tLabel}.tool`, errors)
          checkObject(terminal.args, `${tLabel}.args`, errors)
          checkRenderSpec(terminal.render, `${tLabel}.render`, errors)
          if (Array.isArray(terminal.needs)) {
            for (const need of terminal.needs) {
              if (typeof need !== 'string') {
                errors.push(`${tLabel}.needs must be a string array`)
              } else if (!produced.has(need)) {
                // 依赖了没人产出的锚点＝链路永远断，属于配置错而非运行时未命中
                errors.push(`${tLabel}.needs references "${need}" which no resolver in this plan produces`)
              }
            }
          } else {
            checkStringArray(terminal.needs, `${tLabel}.needs`, errors)
          }
        })
      }
    }
  })
  checkUniqueIds(planIds, errors)
  checkDuplicateRegexes(planPositives, errors, { flagSameTool: true })
  return errors
}

export function validateRenderersFile(raw: unknown): string[] {
  const errors: string[] = []
  if (!isPlainObject(raw)) return ['renderers.json must be an object']
  if (raw.schemas === undefined) return errors
  if (!isPlainObject(raw.schemas)) return ['"schemas" must be an object']

  for (const [schemaId, schema] of Object.entries(raw.schemas)) {
    checkRenderSchema(schema, `schemas["${schemaId}"]`, errors, true)
  }
  return errors
}

/** 声明式渲染 schema 校验；allowSections=false 时禁止再嵌套 sections（上限两节深）。 */
function checkRenderSchema(raw: unknown, label: string, errors: string[], allowSections: boolean): void {
  if (!isPlainObject(raw)) {
    errors.push(`${label} must be an object`)
    return
  }
  checkString(raw.title, `${label}.title`, errors)
  checkString(raw.dataSource, `${label}.dataSource`, errors)
  checkString(raw.emptyMessage, `${label}.emptyMessage`, errors)
  checkFiniteNumber(raw.maxRows, `${label}.maxRows`, errors)
  if (raw.columns !== undefined) {
    if (!Array.isArray(raw.columns)) {
      errors.push(`${label}.columns must be an array`)
    } else {
      raw.columns.forEach((column: unknown, index: number) => {
        const cLabel = `${label}.columns[${index}]`
        if (!isPlainObject(column)) {
          errors.push(`${cLabel} must be an object`)
          return
        }
        if (!['text', 'number', 'date', 'status', 'link'].includes(String(column.type))) {
          errors.push(`${cLabel}.type must be one of text|number|date|status|link`)
        }
        checkString(column.key, `${cLabel}.key`, errors)
        checkString(column.title, `${cLabel}.title`, errors)
      })
    }
  }
  if (raw.sections === undefined) return
  if (!allowSections) {
    errors.push(`${label}.sections 不可嵌套（分节最多一层）`)
    return
  }
  if (!Array.isArray(raw.sections)) {
    errors.push(`${label}.sections must be an array`)
    return
  }
  raw.sections.forEach((section: unknown, index: number) => {
    checkRenderSchema(section, `${label}.sections[${index}]`, errors, false)
  })
}

export function validatePlanTerminalsFile(raw: unknown): string[] {
  const errors: string[] = []
  if (!isPlainObject(raw)) return ['plan-terminals.json must be an object']
  if (raw.adapters === undefined) return errors
  if (!isPlainObject(raw.adapters)) return ['"adapters" must be an object']

  for (const [adapterId, terminals] of Object.entries(raw.adapters)) {
    const label = `adapters["${adapterId}"]`
    if (!isPlainObject(terminals)) {
      errors.push(`${label} must be an object`)
      continue
    }
    for (const [terminalKey, entry] of Object.entries(terminals)) {
      const tLabel = `${label}["${terminalKey}"]`
      if (!isPlainObject(entry)) {
        errors.push(`${tLabel} must be an object`)
        continue
      }
      checkString(entry.tool, `${tLabel}.tool`, errors)
      checkObject(entry.input, `${tLabel}.input`, errors)
    }
  }
  return errors
}

export function validateScenarioRoutesFile(raw: unknown): string[] {
  const errors: string[] = []
  if (!isPlainObject(raw)) return ['scenario-routes.json must be an object']
  if (raw.routes === undefined) return errors
  if (!Array.isArray(raw.routes)) return ['"routes" must be an array']

  raw.routes.forEach((route: unknown, index: number) => {
    const label = `routes[${index}]`
    if (!isPlainObject(route)) {
      errors.push(`${label} must be an object`)
      return
    }
    checkString(route.adapter, `${label}.adapter`, errors)
    checkString(route.scenarioId, `${label}.scenarioId`, errors)
    checkString(route.tool, `${label}.tool`, errors)
    checkBoolean(route.enabled, `${label}.enabled`, errors)
    checkBoolean(route.optout, `${label}.optout`, errors)
    // 三种形态互斥：tool / plan / optout 恰有其一（旧版引擎读到无 tool 的条目会静默忽略，
    // 这里提前判成配置错，避免「声明了却不生效」）
    const forms = [route.tool !== undefined, route.plan !== undefined, route.optout === true].filter(Boolean).length
    if (forms !== 1) {
      errors.push(`${label} must declare exactly one of tool / plan / optout`)
    }
    if (route.patterns !== undefined) {
      if (!Array.isArray(route.patterns)) {
        errors.push(`${label}.patterns must be an array`)
      } else {
        route.patterns.forEach((pattern: unknown, pIndex: number) => {
          const pLabel = `${label}.patterns[${pIndex}]`
          if (!isPlainObject(pattern)) {
            errors.push(`${pLabel} must be an object`)
            return
          }
          if (typeof pattern.regex !== 'string') {
            errors.push(`${pLabel}.regex must be a string`)
            return
          }
          try {
            new RegExp(pattern.regex, typeof pattern.flags === 'string' ? pattern.flags : undefined)
          } catch (error) {
            errors.push(`${pLabel}.regex is not a valid regex: ${error instanceof Error ? error.message : String(error)}`)
          }
        })
      }
    }
    checkRegexList(route.guardNegative, `${label}.guardNegative`, errors)
  })
  return errors
}

export function validateManifestFile(raw: unknown): string[] {
  const errors: string[] = []
  if (!isPlainObject(raw)) return ['manifest.json must be an object']
  if (raw.schemaVersion !== undefined) {
    if (typeof raw.schemaVersion !== 'number' || !Number.isFinite(raw.schemaVersion)) {
      errors.push('manifest.schemaVersion must be a finite number')
    } else if (raw.schemaVersion > ROUTER_CONFIG_SCHEMA_VERSION) {
      errors.push(
        `manifest.schemaVersion ${raw.schemaVersion} is newer than supported ${ROUTER_CONFIG_SCHEMA_VERSION}`,
      )
    }
  }
  if (raw.layers !== undefined) {
    if (!isPlainObject(raw.layers)) {
      errors.push('manifest.layers must be an object')
    } else {
      for (const value of Object.values(raw.layers)) {
        if (typeof value !== 'boolean') errors.push('manifest.layers values must be booleans')
      }
    }
  }
  checkString(raw.note, 'manifest.note', errors, { allowEmpty: true })
  return errors
}

// ── 作用域过滤：配置项只对当前存在的 Adapter 生效 ────────────────────────────

/** tool 名是否属于 adapter 集合中的某一个（adapter id 形如 github.com，tool 形如 github.com.list-repos） */
export function isToolInAdapterScope(tool: string, adapterIds: ReadonlySet<string>): boolean {
  if (typeof tool !== 'string' || tool === '') return false
  if (adapterIds.has(tool)) return true
  for (const adapterId of adapterIds) {
    if (adapterId && tool.startsWith(`${adapterId}.`)) return true
  }
  return false
}

export type RouterConfigScopeResult = {
  bundle: ScopeAppliedBundle
  /** 因 Adapter 不在当前集合内被丢弃的条目，形如 `shortcuts[2] tool=example.com.x` */
  dropped: string[]
}

/** 与 RouterConfigBundle 同构，只改动逐条目层 */
export type ScopeAppliedBundle = {
  routes: RoutesFile
  aliases: AliasesFile
  shortcuts: ShortcutsFile
  patterns: PatternsFile
  plans: PlansFile
  planTerminals: PlanTerminalsFile
  scenarioRoutes: ScenarioRoutesFile
}

function keepInScope<T>(
  items: T[] | undefined,
  describe: (item: T, index: number) => { label: string; tool?: string },
  adapterIds: ReadonlySet<string>,
  dropped: string[],
): T[] {
  const kept: T[] = []
  ;(items ?? []).forEach((item, index) => {
    const { label, tool } = describe(item, index)
    if (tool !== undefined && !isToolInAdapterScope(tool, adapterIds)) {
      dropped.push(`${label} tool=${tool}`)
      return
    }
    kept.push(item)
  })
  return kept
}

/**
 * 按当前 Adapter 集合过滤各层条目。
 *
 * 只过滤「引用具体工具/适配器」的层；renderers 按 schemaId 引用、不绑定 Adapter，故不过滤。
 * 未在配置里出现的 Adapter 一律不生效——这是「配置只对当前 Profile 的 Adapter 生效」的落点。
 */
export function applyRouterConfigScope(bundle: ScopeAppliedBundle, adapterIds: ReadonlySet<string>): RouterConfigScopeResult {
  const dropped: string[] = []

  const routes: RoutesFile = {
    routes: keepInScope<RouteEntry>(
      bundle.routes.routes,
      (entry, index) => ({ label: `routes[${index}] id=${entry?.id ?? '?'}`, tool: entry?.tool }),
      adapterIds,
      dropped,
    ),
  }

  const aliases: AliasesFile = {
    aliases: keepInScope(
      bundle.aliases.aliases,
      (entry, index) => ({ label: `aliases[${index}] id=${entry?.id ?? '?'}`, tool: entry?.tool }),
      adapterIds,
      dropped,
    ),
  }

  const shortcuts: ShortcutsFile = {
    shortcuts: keepInScope<ShortcutEntry>(
      bundle.shortcuts.shortcuts,
      (entry, index) => ({ label: `shortcuts[${index}] id=${entry?.id ?? '?'}`, tool: entry?.tool }),
      adapterIds,
      dropped,
    ),
  }

  const patterns: PatternsFile = { version: bundle.patterns.version, global: bundle.patterns.global, configs: {} }
  for (const [tool, config] of Object.entries(bundle.patterns.configs ?? {})) {
    if (!isToolInAdapterScope(tool, adapterIds)) {
      dropped.push(`patterns.configs["${tool}"]`)
      continue
    }
    patterns.configs![tool] = config
  }

  const plans: PlansFile = { plans: [] }
  for (const [index, plan] of (bundle.plans.plans ?? []).entries()) {
    const label = `plans[${index}] id=${plan?.id ?? '?'}`
    if (plan?.adapterId && !adapterIds.has(plan.adapterId)) {
      dropped.push(`${label} adapterId=${plan.adapterId}`)
      continue
    }
    const tools = [
      ...(plan?.resolvers ?? []).map((resolver) => resolver?.tool),
      ...(plan?.terminals ?? []).map((terminal) => terminal?.tool),
    ].filter((tool): tool is string => typeof tool === 'string')
    const outOfScope = tools.find((tool) => !isToolInAdapterScope(tool, adapterIds))
    if (outOfScope) {
      dropped.push(`${label} tool=${outOfScope}`)
      continue
    }
    plans.plans!.push(plan)
  }

  const planTerminals: PlanTerminalsFile = { version: bundle.planTerminals.version, note: bundle.planTerminals.note, adapters: {} }
  for (const [adapterId, terminals] of Object.entries(bundle.planTerminals.adapters ?? {})) {
    if (!adapterIds.has(adapterId)) {
      dropped.push(`planTerminals.adapters["${adapterId}"]`)
      continue
    }
    planTerminals.adapters![adapterId] = terminals
  }

  const scenarioRoutes: ScenarioRoutesFile = {
    version: bundle.scenarioRoutes.version,
    generatedAt: bundle.scenarioRoutes.generatedAt,
    routes: keepInScope(
      bundle.scenarioRoutes.routes,
      (route, index) => ({
        label: `scenarioRoutes[${index}] ${route?.adapter ?? '?'}:${route?.scenarioId ?? '?'}`,
        tool: route?.tool ?? route?.adapter,
      }),
      adapterIds,
      dropped,
    ),
  }

  return { bundle: { routes, aliases, shortcuts, patterns, plans, planTerminals, scenarioRoutes }, dropped }
}
