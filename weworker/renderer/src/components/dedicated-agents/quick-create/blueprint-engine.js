/**
 * BotHub 蓝图引擎：把「纯数据蓝图」渲染成模板 Bot 的全部产物。
 *
 * 蓝图（blueprint.json）只允许声明式数据——问题、变量管线、条件段、文本行，
 * 不携带任何可执行代码；本地 bothub/ 文件夹与未来远程 BotHub 下发的是同一种
 * 数据，本引擎是唯一的解释器，因此远端内容无法注入脚本。
 *
 * DSL 约定：
 * - 条件对象：{"and":[c]} {"or":[c]} {"not":c} {"var":"hasTencent"}
 *   {"answer":"use163","isNot":false} {"allAnswers":["id","key"]}
 *   （{"answer":"k"} 与 allAnswers 的真值 = String(v).trim() 非空；布尔判断一律用 is/isNot）
 * - 变量：{"from":"answerKey","trim":true,"stripBearer":true,"max":512,"json":true,"pad":true,"fallback":"…"}
 *   {"var":"其他变量","fallback":"…"} {"bool":条件} {"if":条件,"then":"…{{var}}…","else":"…"}
 *   {"members":"members","join":"、","fallback":"（待补充）"} {"memberFirst":"members"}
 *   引擎固定注入变量 skillName（蓝图技能名）。
 * - 文本行：字符串（内嵌 {{var}} 占位符）或 {"when":条件,"lines":[…]} 条件块。
 */

/** 解析用户输入的团队成员（逗号/空格/换行分隔，英文名）。 */
export function parseMembers(input) {
  const seen = new Set()
  return String(input || '')
    .split(/[\s,，;；、]+/)
    .map((name) => name.trim().replace(/^@+/, ''))
    .filter(Boolean)
    .filter((name) => {
      if (seen.has(name.toLowerCase())) return false
      seen.add(name.toLowerCase())
      return true
    })
    .slice(0, 30)
}

const MEMBER_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/

/** 企查查 API Key 归一化：剥掉 Bearer 前缀，由配方统一拼接 'Bearer '。 */
export function normalizeQccKey(value) {
  return String(value ?? '').trim().replace(/^Bearer\s+/i, '').trim()
}

export function normalizeAliyunCredential(value) {
  return String(value ?? '').trim()
}

export function normalizeTencentCredential(value) {
  return String(value ?? '').trim()
}

/** 每天整点执行的 cron。 */
export function buildDailyCron(hour) {
  return `0 ${Number(hour)} * * *`
}

/** start..end 点之间每 interval 小时执行的 cron（范围退化为单点时只保留整点）。 */
export function buildMonitoringCron(start, end, interval) {
  const from = Math.min(Number(start), Number(end))
  const to = Math.max(Number(start), Number(end))
  if (from === to) return `0 ${from} * * *`
  return `0 ${from}-${to}/${Math.max(1, Number(interval))} * * *`
}

/** 人类可读的 cron 描述，用于确认界面。 */
export function describeCron(expression) {
  const match = /^0 (\d+)(?:-(\d+))?\/?(\d+)? \* \* \*$/.exec(String(expression || '').trim())
  if (!match) return String(expression || '')
  const from = Number(match[1])
  const to = match[2] ? Number(match[2]) : null
  const step = match[3] ? Number(match[3]) : null
  if (to == null) return `每天 ${from}:00`
  if (step) return `每天 ${from}:00–${to}:00 每 ${step} 小时`
  return `每天 ${from}:00 和 ${to}:00`
}

/* ── 条件求值 ─────────────────────────────────────────────── */

function answerTruthy(answers, key) {
  return String(answers?.[key] ?? '').trim() !== ''
}

function answersEqual(actual, expected) {
  return String(actual ?? '') === String(expected)
}

export function evalCondition(condition, ctx) {
  if (condition === undefined || condition === null) return true
  if (typeof condition !== 'object') return Boolean(condition)
  if (Array.isArray(condition)) return condition.every((entry) => evalCondition(entry, ctx))
  if (condition.var !== undefined) return Boolean(evalVar(ctx, condition.var))
  if (condition.answer !== undefined) {
    if ('is' in condition) return answersEqual(ctx.answers[condition.answer], condition.is)
    if ('isNot' in condition) return !answersEqual(ctx.answers[condition.answer], condition.isNot)
    return answerTruthy(ctx.answers, condition.answer)
  }
  if (Array.isArray(condition.allAnswers)) {
    return condition.allAnswers.every((key) => answerTruthy(ctx.answers, key))
  }
  if (Array.isArray(condition.and)) return condition.and.every((entry) => evalCondition(entry, ctx))
  if (Array.isArray(condition.or)) return condition.or.some((entry) => evalCondition(entry, ctx))
  if (condition.not !== undefined) return !evalCondition(condition.not, ctx)
  return false
}

/* ── 变量求值（惰性 + 记忆化） ────────────────────────────── */

function valueWithFallback(value, spec) {
  if (value === undefined || value === null || value === '') return spec.fallback ?? ''
  return value
}

/** 变量尾部变换：截断 → JSON 引号 → 补零（引用、取数等分支共用）。 */
function finishVar(value, spec) {
  if (spec.max !== undefined && String(value).length > spec.max) value = String(value).slice(0, spec.max)
  if (spec.json) value = JSON.stringify(value)
  if (spec.pad) value = String(Number(value ?? 0)).padStart(2, '0')
  return value
}

function evalVarSpec(spec, ctx) {
  if (spec == null) return ''
  if (typeof spec === 'string') return spec
  if (Array.isArray(spec)) return spec.map((entry) => evalVarSpec(entry, ctx)).join('\n')
  if (spec.var !== undefined) {
    return finishVar(valueWithFallback(evalVar(ctx, spec.var), spec), spec)
  }
  if (spec.if !== undefined) {
    const branch = evalCondition(spec.if, ctx) ? spec.then : spec.else
    return interpolateVars(String(branch ?? ''), ctx)
  }
  if (spec.bool !== undefined) return evalCondition(spec.bool, ctx)
  if (spec.members !== undefined) {
    const members = parseMembers(ctx.answers[spec.members])
    if (!members.length) return spec.fallback ?? ''
    return members.join(spec.join === undefined ? '、' : spec.join)
  }
  if (spec.memberFirst !== undefined) {
    return parseMembers(ctx.answers[spec.memberFirst])[0] ?? spec.fallback ?? ''
  }
  if (spec.from !== undefined) {
    let value = ctx.answers[spec.from]
    if (spec.trim) value = String(value ?? '').trim()
    if (spec.stripBearer) value = normalizeQccKey(value)
    if (spec.num) value = Number(value)
    return finishVar(valueWithFallback(value, spec), spec)
  }
  return ''
}

function evalVar(ctx, name) {
  if (name in ctx.vars) return ctx.vars[name]
  const spec = ctx.template.vars?.[name]
  const value = spec === undefined ? '' : evalVarSpec(spec, ctx)
  ctx.vars[name] = value
  return value
}

function interpolateVars(text, ctx) {
  return String(text ?? '').replace(/\{\{([A-Za-z0-9_.-]+)\}\}/g, (_, name) => String(evalVar(ctx, name)))
}

/* ── 文本行渲染 ───────────────────────────────────────────── */

export function renderLines(lines, ctx) {
  const out = []
  for (const line of Array.isArray(lines) ? lines : []) {
    if (typeof line === 'string') {
      out.push(interpolateVars(line, ctx))
      continue
    }
    if (line && typeof line === 'object' && Array.isArray(line.lines)) {
      if (evalCondition(line.when, ctx)) out.push(...renderLines(line.lines, ctx))
    }
  }
  return out
}

/* ── 蓝图规范化与校验 ─────────────────────────────────────── */

const QUESTION_TYPES = new Set(['text', 'textarea', 'hour', 'choice', 'credentials', 'guide', 'monitor'])
const VALIDATOR_KINDS = new Set(['name', 'members', 'hour', 'apiKey', 'credentialPair', 'monitorWindow'])
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/

/** 校验并规范化一份蓝图数据；不合法直接抛错（加载期暴露坏蓝图，而不是渲染期）。 */
export function normalizeBlueprint(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('蓝图必须是 JSON 对象')
  if (raw.schema_version !== 1) throw new Error('蓝图 schema_version 不支持')
  for (const field of ['id', 'version', 'emoji', 'name', 'tagline']) {
    if (!String(raw[field] ?? '').trim()) throw new Error(`蓝图缺少字段 ${field}`)
  }
  if (!ID_PATTERN.test(raw.id)) throw new Error('蓝图 id 格式不合法')
  if (!VERSION_PATTERN.test(raw.version)) throw new Error('蓝图 version 必须是 X.Y.Z')
  const site = raw.site && typeof raw.site === 'object' ? raw.site : null
  if (!site || !site.id) throw new Error('蓝图缺少 site.id')
  const questions = (Array.isArray(raw.questions) ? raw.questions : []).map((question) => (
    { ...question, answerKey: question.answerKey || question.id }
  ))
  questions.forEach((question, index) => {
    if (!question || !question.id || !QUESTION_TYPES.has(question.type)) {
      throw new Error(`第 ${index + 1} 个问题缺少 id 或题型不支持`)
    }
    if (question.validate && !VALIDATOR_KINDS.has(question.validate.kind)) {
      throw new Error(`问题 ${question.id} 的校验类型不支持：${question.validate.kind}`)
    }
  })
  return {
    id: raw.id,
    version: raw.version,
    emoji: raw.emoji,
    name: raw.name,
    tagline: raw.tagline,
    siteId: site.id,
    siteLabel: site.label || site.id,
    // 派生字段：技能名默认即蓝图 id；默认名字默认即展示名。
    skillName: raw.skillName || raw.id,
    defaultName: raw.defaultName || raw.name,
    defaultAnswers: { ...(raw.defaultAnswers || {}) },
    questions,
    introMarkdown: typeof raw.introMarkdown === 'string' ? raw.introMarkdown : '',
    introCta: typeof raw.introCta === 'string' && raw.introCta.trim() ? raw.introCta.trim() : '',
    vars: raw.vars || {},
    sites: Array.isArray(raw.sites) && raw.sites.length ? raw.sites : [{ id: site.id }],
    skill: Array.isArray(raw.skill) ? raw.skill : [],
    tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
    description: Array.isArray(raw.description) ? raw.description : [],
    examples: Array.isArray(raw.examples) ? raw.examples : [],
  }
}

/* ── skill.md 编译：条件表达式 + if/elif/else/endif 指令 ──── */

/**
 * 条件表达式解析：变量名 + ! && || 与括号（固定文法，parse 而非 eval）。
 * "hasTencent && !hasAliyun" → { and: [{var:'hasTencent'}, {not:{var:'hasAliyun'}}] }
 */
export function parseConditionExpression(source) {
  const tokens = String(source || '').match(/\(|\)|!|&&|\|\||[A-Za-z0-9_.-]+/g) || []
  let pos = 0
  const peek = () => tokens[pos]
  const parseOr = () => {
    let node = parseAnd()
    while (peek() === '||') {
      pos += 1
      node = { or: [node, parseAnd()] }
    }
    return node
  }
  const parseAnd = () => {
    let node = parseUnary()
    while (peek() === '&&') {
      pos += 1
      node = { and: [node, parseUnary()] }
    }
    return node
  }
  const parseUnary = () => {
    if (peek() === '!') {
      pos += 1
      return { not: parseUnary() }
    }
    if (peek() === '(') {
      pos += 1
      const inner = parseOr()
      if (peek() !== ')') throw new Error(`条件表达式括号不匹配：${source}`)
      pos += 1
      return inner
    }
    const name = peek()
    if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error(`条件表达式无法解析：${source}`)
    pos += 1
    return { var: name }
  }
  const node = parseOr()
  if (pos !== tokens.length) throw new Error(`条件表达式有多余内容：${source}`)
  return node
}

const DIRECTIVE = /^<!--\s*(if|elif|else|endif)\s*(?::\s*([^>]*?)\s*)?-->$/

/**
 * 把 skill.md 编译为引擎行数组：普通行原样保留（含 {{var}} 占位符），
 * `<!-- if: expr -->` / `<!-- elif: expr -->` / `<!-- else -->` / `<!-- endif -->`
 * 编译为条件块；else 的条件自动取整条链路条件的否定（保证四选一互斥）。
 */
export function compileSkillMarkdown(markdown) {
  const root = []
  const stack = [{ lines: root, chain: [] }]
  // 去掉文件末尾的终止换行（避免编译出多余的空行；作者有意留的空行不受影响）。
  const text = String(markdown || '').replace(/\r?\n$/, '')
  for (const line of text.split(/\r?\n/)) {
    const match = DIRECTIVE.exec(line.trim())
    if (!match) {
      stack[stack.length - 1].lines.push(line)
      continue
    }
    const [, kind, expression] = match
    if (kind === 'if') {
      const when = parseConditionExpression(expression)
      const block = { when, lines: [] }
      stack[stack.length - 1].lines.push(block)
      stack.push({ lines: block.lines, chain: [when] })
    } else if (kind === 'elif') {
      const frame = stack.pop()
      if (!frame || !frame.chain.length) throw new Error(`elif 没有匹配的 if：${line}`)
      const own = parseConditionExpression(expression)
      // elif = 自身条件 且 此前所有分支条件都不成立（严格互斥）。
      const when = { and: [...frame.chain.map((c) => ({ not: c })), own] }
      const block = { when, lines: [] }
      stack[stack.length - 1].lines.push(block)
      stack.push({ lines: block.lines, chain: [...frame.chain, own] })
    } else if (kind === 'else') {
      const frame = stack.pop()
      if (!frame || !frame.chain.length) throw new Error(`else 没有匹配的 if：${line}`)
      // else = 链路中全部前置条件的否定，与 if/elif 严格互斥。
      const when = frame.chain.length === 1 ? { not: frame.chain[0] } : { and: frame.chain.map((c) => ({ not: c })) }
      const block = { when, lines: [] }
      stack[stack.length - 1].lines.push(block)
      stack.push({ lines: block.lines, chain: [...frame.chain, when] })
    } else if (kind === 'endif') {
      const frame = stack.pop()
      if (!frame || !frame.chain.length) throw new Error(`endif 没有匹配的 if：${line}`)
    }
  }
  if (stack.length !== 1) throw new Error('skill.md 存在未闭合的 if 块')
  return root
}

/** 批量加载：坏蓝图跳过并返回错误清单，好蓝图按传入顺序保留。 */
export function loadBlueprints(rawList) {
  const templates = []
  const errors = []
  for (const raw of Array.isArray(rawList) ? rawList : []) {
    try {
      templates.push(normalizeBlueprint(raw))
    } catch (error) {
      errors.push(`${raw?.id || '未知蓝图'}: ${error.message}`)
    }
  }
  return { templates, errors }
}

/* ── 模板查询与校验（消费方签名与旧 templates.js 保持一致） ── */

export function findTemplateIn(templates, templateId) {
  return (templates || []).find((template) => template.id === templateId) || null
}

export function templateQuestions(template) {
  return template?.questions ?? []
}

/** 按当前答案过滤出需要展示的问题清单（支持条件引导步骤）。 */
export function visibleTemplateQuestions(template, answers) {
  const ctx = buildContext(template, answers)
  return templateQuestions(template).filter((question) => (
    question.when === undefined || evalCondition(question.when, ctx)
  ))
}

/** 判断问题是否完全未作答（兼容单字段与 credentials 多字段题型）。 */
export function isQuestionEmpty(question, answers) {
  if (!question) return true
  if (Array.isArray(question.fields) && question.fields.length > 0) {
    return question.fields.every((field) => !String(answers?.[field.answerKey] ?? '').trim())
  }
  return !String(answers?.[question.answerKey] ?? '').trim()
}

export function validateTemplateQuestion(template, questionId, answers) {
  if (!template) return '模板不存在'
  const question = (template.questions || []).find((entry) => entry.id === questionId)
  if (!question) return ''
  if (question.optional && isQuestionEmpty(question, answers)) return ''
  const validate = question.validate || {}
  const key = question.answerKey || question.id
  switch (validate.kind) {
    case 'name': {
      const name = String(answers?.[key] || '').trim()
      if (!name) return '请给它起个名字'
      if (name.length > 40) return '名称最长 40 个字符'
      return ''
    }
    case 'members': {
      const members = parseMembers(answers?.[key])
      if (!members.length) return '请至少填写一位团队成员的英文名'
      const invalid = members.find((member) => !MEMBER_PATTERN.test(member))
      if (invalid) return `成员名「${invalid}」不像是有效的英文名（字母开头，可含数字、点、下划线和连字符）`
      return ''
    }
    case 'hour': {
      const hour = Number(answers?.[key])
      return Number.isInteger(hour) && hour >= (validate.min ?? 0) && hour <= (validate.max ?? 23)
        ? ''
        : (validate.message || '请选择时间')
    }
    case 'apiKey': {
      const value = String(answers?.[key] ?? '').trim()
      if (validate.required && !value) return validate.requiredMessage || '请先填写'
      if (validate.max && value.length > validate.max) return validate.maxMessage || '过长，请核对后重试'
      return ''
    }
    case 'credentialPair': {
      const idValue = String(answers?.[validate.idField] ?? '').trim()
      const keyValue = String(answers?.[validate.keyField] ?? '').trim()
      if (!idValue && !keyValue) return ''
      if (!idValue) return `请同时填写${validate.idLabel}（或两项都留空以跳过）`
      if (!keyValue) return `请同时填写${validate.keyLabel}（或两项都留空以跳过）`
      if (idValue.length > (validate.idMax || 128)) return `${validate.idLabel} 过长，请核对后重试`
      if (keyValue.length > (validate.keyMax || 256)) return `${validate.keyLabel} 过长，请核对后重试`
      return ''
    }
    case 'monitorWindow': {
      if (answers?.monitorEnabled === false) return ''
      const start = Number(answers?.monitorStart)
      const end = Number(answers?.monitorEnd)
      const interval = Number(answers?.monitorInterval)
      if (![start, end, interval].every((value) => Number.isInteger(value))) return '额度监控的时间设置无效'
      if (start < 0 || start > 23 || end < 0 || end > 23) return '额度监控的时间范围只能在 0–23 点'
      if (interval < 1 || interval > 12) return '额度监控的执行间隔只能在 1–12 小时'
      return ''
    }
    default:
      break
  }
  if (question.type === 'choice') {
    const value = answers?.[question.answerKey]
    return (question.options || []).some((option) => option.value === value) ? '' : `请选择${question.title.replace('？', '')}`
  }
  return ''
}

export function validateTemplateAnswers(template, answers) {
  if (!template) return '模板不存在'
  for (const question of template.questions || []) {
    const message = validateTemplateQuestion(template, question.id, answers)
    if (message) return message
  }
  return ''
}

/* ── 产物构建 ─────────────────────────────────────────────── */

function buildContext(template, rawAnswers) {
  const answers = { ...(template?.defaultAnswers || {}), ...(rawAnswers || {}) }
  return { template: template || {}, answers, vars: { skillName: template?.skillName || '' } }
}

/** 已回答问题的气泡文案。 */
export function questionAnswerText(template, questionId, answers) {
  const question = (template?.questions || []).find((entry) => entry.id === questionId)
  if (!question || !Array.isArray(question.summary) || !question.summary.length) return ''
  const ctx = buildContext(template, answers)
  for (const entry of question.summary) {
    if (entry.when === undefined || evalCondition(entry.when, ctx)) return interpolateVars(String(entry.text ?? ''), ctx)
  }
  return ''
}

/** 填空渲染模板 Bot 的专属 Skill（不调用大模型）。 */
export function renderTemplateSkill(template, answers) {
  if (!template) return ''
  return renderLines(template.skill, buildContext(template, answers)).join('\n')
}

/** 模板要绑定的站点列表（含条件附加站点）。 */
export function buildTemplateSiteIds(template, answers) {
  if (!template) return []
  const ctx = buildContext(template, answers)
  return template.sites
    .filter((site) => site.when === undefined || evalCondition(site.when, ctx))
    .map((site) => site.id)
}

/** 由答案构建要创建的定时任务列表；无定时任务的模板返回空数组。 */
export function buildTemplateTasks(template, answers) {
  if (!template) return []
  const ctx = buildContext(template, answers)
  const tasks = []
  for (const task of template.tasks || []) {
    if (task.when !== undefined && !evalCondition(task.when, ctx)) continue
    let cron = ''
    if (task.cron?.kind === 'daily') cron = buildDailyCron(evalVarSpec(task.cron.hour, ctx))
    if (task.cron?.kind === 'window') {
      cron = buildMonitoringCron(
        evalVarSpec(task.cron.start, ctx),
        evalVarSpec(task.cron.end, ctx),
        evalVarSpec(task.cron.interval, ctx),
      )
    }
    tasks.push({
      key: task.key,
      title: task.title,
      cron_expression: cron,
      prompt_template: renderLines(task.prompt, ctx).join('\n'),
    })
  }
  return tasks
}

/** 由答案构建 Agent 的描述文案。 */
export function buildTemplateDescription(template, answers) {
  if (!template) return ''
  return renderLines(template.description, buildContext(template, answers)).join('\n')
}

/** 由答案构建示例问题。 */
export function buildTemplateExamples(template, answers) {
  if (!template) return []
  return renderLines(template.examples, buildContext(template, answers))
}
