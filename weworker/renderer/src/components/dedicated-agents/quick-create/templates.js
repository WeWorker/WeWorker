// 快速创建 WeWorker Bot：内置模板数据与纯函数。
// 只放纯数据/纯函数（不依赖 React），供 node --test 直接测试。

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

/**
 * 校验单个问题的答案，返回错误文案或 ''（问题未答完时对未到的问题放行）。
 * 问题 id 同时是答案 key；optional 的问题留空直接放行。
 */
export function validateTemplateQuestion(template, questionId, answers) {
  if (!template) return '模板不存在'
  const question = (template.questions || []).find((entry) => entry.id === questionId)
  if (!question) return ''
  if (question.optional && !String(answers?.[question.answerKey] ?? '').trim()) return ''
  if (questionId === 'name') {
    const name = String(answers?.name || '').trim()
    if (!name) return '请给它起个名字'
    if (name.length > 40) return '名称最长 40 个字符'
    return ''
  }
  if (questionId === 'members') {
    const members = parseMembers(answers?.members)
    if (!members.length) return '请至少填写一位团队成员的英文名'
    const invalid = members.find((member) => !MEMBER_PATTERN.test(member))
    if (invalid) return `成员名「${invalid}」不像是有效的英文名（字母开头，可含数字、点、下划线和连字符）`
    return ''
  }
  if (questionId === 'dailyHour') {
    const hour = Number(answers?.dailyHour)
    return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? '' : '请选择每天推送日报的时间'
  }
  if (questionId === 'qccApiKey') {
    const key = String(answers?.qccApiKey ?? '').trim()
    return key.length > 512 ? 'API Key 过长，请核对后重试' : ''
  }
  if (questionId === 'monitor') {
    if (answers?.monitorEnabled === false) return ''
    const start = Number(answers?.monitorStart)
    const end = Number(answers?.monitorEnd)
    const interval = Number(answers?.monitorInterval)
    if (![start, end, interval].every((value) => Number.isInteger(value))) return '额度监控的时间设置无效'
    if (start < 0 || start > 23 || end < 0 || end > 23) return '额度监控的时间范围只能在 0–23 点'
    if (interval < 1 || interval > 12) return '额度监控的执行间隔只能在 1–12 小时'
    return ''
  }
  if (question.type === 'choice') {
    const value = answers?.[question.answerKey]
    return question.options.some((option) => option.value === value) ? '' : `请选择${question.title.replace('？', '')}`
  }
  return ''
}

/** 校验模板全部答案（按问题顺序逐项校验），返回错误文案或 ''。 */
export function validateTemplateAnswers(template, answers) {
  if (!template) return '模板不存在'
  for (const question of template.questions || []) {
    const message = validateTemplateQuestion(template, question.id, answers)
    if (message) return message
  }
  return ''
}

/** 已回答问题的气泡文案。 */
export function questionAnswerText(questionId, answers) {
  if (questionId === 'name') return String(answers?.name || '').trim()
  if (questionId === 'members') return parseMembers(answers?.members).join('、')
  if (questionId === 'dailyHour') return `每天 ${String(Number(answers?.dailyHour ?? 9)).padStart(2, '0')}:00`
  if (questionId === 'qccApiKey') {
    // 摘要里不回显 Key 本身，只说明是否已提供。
    return String(answers?.qccApiKey ?? '').trim() ? '已提供，将写入专属知识' : '稍后在对话里提供'
  }
  if (questionId === 'monitor') {
    if (answers?.monitorEnabled === false) return '不用了，先不开'
    const start = String(Number(answers?.monitorStart ?? 9)).padStart(2, '0')
    const end = String(Number(answers?.monitorEnd ?? 21)).padStart(2, '0')
    return `开！每天 ${start}:00–${end}:00 每 ${Number(answers?.monitorInterval ?? 2)} 小时查一次`
  }
  return ''
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

const APIKEY_TEMPLATE_ID = 'apikey-usage-helper'
const COSTPLUS_TEMPLATE_ID = 'invoice-self-check-helper'

/** 一问一答流程的问题清单（按提问顺序），挂在各模板上。 */
const APIKEY_QUESTIONS = [
  {
    id: 'name',
    type: 'text',
    answerKey: 'name',
    emoji: '🤖',
    title: '先给它起个名字',
    subtitle: '它会用这个名字在 IM 里向你自我介绍。',
    placeholder: 'API Key 使用助手',
  },
  {
    id: 'members',
    type: 'textarea',
    answerKey: 'members',
    emoji: '👥',
    title: '你的团队成员有哪些？',
    subtitle: '填英文名，逗号或换行分隔。想看到某位同事的用量，需要对方先在 aiep 上把你加为其 API Key 的关注人，没加的话它会在日报里提醒你们。',
    placeholder: 'alice\nbob, carol',
  },
  {
    id: 'dailyHour',
    type: 'hour',
    answerKey: 'dailyHour',
    emoji: '⏰',
    title: '每天几点给你发日报？',
    subtitle: '到点它会自动汇总团队成员 codeplan key 的使用情况，发到你们的对话里。',
    hours: [7, 8, 9, 10, 11, 12],
  },
  {
    id: 'monitor',
    type: 'monitor',
    emoji: '🔔',
    title: '要开启额度监控吗？',
    subtitle: '当周额度用到 60% / 70% / 80% / 90% 时分别提醒你，注明成员、Key 名称、供应商和当前百分比。',
    intervals: [1, 2, 3, 4, 6],
  },
]

const COSTPLUS_QUESTIONS = [
  {
    id: 'name',
    type: 'text',
    answerKey: 'name',
    emoji: '🤖',
    title: '先给它起个名字',
    subtitle: '它会用这个名字在 IM 里向你自我介绍。',
    placeholder: '发票自查助手',
  },
  {
    id: 'qccApiKey',
    type: 'text',
    answerKey: 'qccApiKey',
    optional: true,
    maxLength: 512,
    emoji: '🔑',
    title: '企查查 API Key（可以跳过）',
    subtitle: '复查时用它查询销售方公司的注册状态。登录 https://agent.qcc.com/profile/api-key 即可获取，新用户注册即送 600 积分。现在不方便也行，之后在对话里提供即可。',
    placeholder: '粘贴 API Key，或留空稍后提供',
  },
]

/** 内置模板清单（BotHub 展示顺序即数组顺序）。 */
export const BUILT_IN_TEMPLATES = [
  {
    id: COSTPLUS_TEMPLATE_ID,
    emoji: '🧾',
    name: '发票自查助手',
    tagline: '复查历史报销发票，揪出注册状态异常的销售方',
    siteId: 'costplus.weoa.com',
    siteLabel: 'CostPlus',
    skillName: 'invoice-self-check-helper',
    defaultName: '发票自查助手',
    questions: COSTPLUS_QUESTIONS,
    highlights: [
      '一键复查费控系统 2024 年至今的全部补贴台账报销发票',
      '销售方公司逐个校验注册状态：内部库优先，未知的再查企查查并回写',
      '输出注册状态异常清单，不做提单、报销等写操作',
    ],
    needs: [
      '需要 CostPlus（费控系统）网站能力已启用且已登录',
      '企查查查询 Token 会在对话里按提示确认，不会提前收集',
    ],
    defaultAnswers: {
      name: '发票自查助手',
      qccApiKey: '',
    },
  },
  {
    id: APIKEY_TEMPLATE_ID,
    emoji: '🔑',
    name: 'API Key 使用助手',
    tagline: '盯紧团队 codeplan API Key 的用量与额度，到点主动汇报',
    siteId: 'aiep.weoa.com',
    siteLabel: 'aiep',
    skillName: 'apikey-usage-helper',
    defaultName: 'API Key 使用助手',
    questions: APIKEY_QUESTIONS,
    highlights: [
      '每天定点推送团队成员 codeplan API Key 的使用情况',
      '额度监控：当周额度用到 60% / 70% / 80% / 90% 时自动告警',
      '只基于 aiep 网站能力，绑定后即可使用',
    ],
    needs: [
      '团队成员需要先在 aiep 上把你加为其 API Key 的关注人，你才能看到他们的用量',
      '只关注名称带 codeplan 的 API Key，其他 Key 不计入报告',
    ],
    defaultAnswers: {
      name: 'API Key 使用助手',
      members: '',
      dailyHour: 9,
      monitorEnabled: true,
      monitorStart: 9,
      monitorEnd: 21,
      monitorInterval: 2,
    },
  },
]

export function findTemplate(templateId) {
  return BUILT_IN_TEMPLATES.find((template) => template.id === templateId) || null
}

/** 模板的问题清单（找不到模板时为空数组）。 */
export function templateQuestions(template) {
  return template?.questions ?? []
}

/** 填空渲染模板 Bot 的专属 Skill（不调用大模型）。 */
export function renderTemplateSkill(template, answers) {
  if (template?.id === COSTPLUS_TEMPLATE_ID) return renderCostplusSkill(template, answers)
  return renderApikeySkill(template, answers)
}

function renderApikeySkill(template, answers) {
  const members = parseMembers(answers?.members)
  const hour = Number(answers?.dailyHour ?? template?.defaultAnswers?.dailyHour ?? 9)
  const monitorEnabled = answers?.monitorEnabled !== false
  const start = Number(answers?.monitorStart ?? 9)
  const end = Number(answers?.monitorEnd ?? 21)
  const interval = Number(answers?.monitorInterval ?? 2)
  const memberList = members.join('、') || '（待补充）'
  const monitorSection = monitorEnabled
    ? [
        '',
        '## 额度监控任务',
        '',
        `每天 ${start}:00–${end}:00 每 ${interval} 小时检查一次：`,
        '',
        '- 当周额度使用率到达 60%、70%、80%、90% 时告警，注明成员、Key 名称、供应商和当前百分比。',
        '- 同一轮里已经在上下文中告警过的档位不要重复告警；使用率回落并再次突破同一档位时，可以再次提醒。',
        '- 没有新到达档位的 Key 时，本轮不发消息。',
        '',
      ].join('\n')
    : [
        '',
        '## 额度监控',
        '',
        '主人未开启定时额度监控任务；被问到额度时，按上面的接口说明即时查询即可。',
        '',
      ].join('\n')
  return [
    '---',
    `name: ${template?.skillName || 'apikey-usage-helper'}`,
    'description: 团队 codeplan API Key 用量日报与额度监控（aiep）',
    '---',
    '',
    '# API Key 使用情况助手',
    '',
    '## 网站与接口',
    '',
    '- 只操作 aiep（aiep.weoa.com）：查询列表用 `apikey-usage-list`，查明细用 `apikey-detail`，通过 webcli 调用。',
    '- `apikey-usage-list` 支持用 owner 过滤某个用户名下的 API Key，返回供应商和 API Key 名称等信息。',
    '- 只关注名称带「codeplan」关键字的 API Key，其他 Key 一律忽略，不出现在报告里。',
    '- 目前涉及的供应商为腾讯云 MaaS 和火山 CodingPlan。',
    '',
    '## 团队成员',
    '',
    `主人团队的成员（英文名）：${memberList}`,
    '',
    '## 查同事用量的前提',
    '',
    '- 要查看同事的 API Key 使用情况，同事必须先在 aiep 上把主人加为其 API Key 的关注人。',
    '- 如果 owner 过滤查询结果为空，通常就是还没加关注人：如实说明并提醒，不要编造数据。',
    '',
    '## 日报任务',
    '',
    `每天 ${hour}:00 推送团队 API Key 用量日报：`,
    '',
    '1. 逐个成员调用 `apikey-usage-list`（owner=成员英文名），筛选名称带 codeplan 的 Key。',
    '2. 对每个 Key（腾讯云 MaaS / 火山 CodingPlan）调用 `apikey-detail` 获取当周额度使用率。',
    '3. 按成员汇总：Key 名称、供应商、当周使用率；标注已到告警档位的 Key。',
    '4. 结果简洁，适合在手机 IM 上阅读。',
    monitorSection,
    '## 通用要求',
    '',
    '- 主人问团队用量、某个成员的用量或某个 Key 的额度时，按上面的方法即时查询回答。',
    '- 不要编造任何用量数据；查询失败时说明失败原因。',
  ].join('\n')
}

function renderCostplusSkill(template, answers) {
  // 复查范围固定：2024 年至今（含 2026 年）。
  const from = '2024-01-01'
  // 创建时可选提供企查查 API Key；未提供则运行时向主人确认。
  const qccKey = String(answers?.qccApiKey ?? '').trim().slice(0, 512)
  const tokenNote = qccKey
    ? 'Authorization Bearer Token（即 API Key）已由主人在创建时提供并写在下方配方中；仍属敏感信息，不要在任何输出、日志或回复里展示'
    : 'Authorization Bearer Token（即 API Key）为敏感信息，使用时向主人确认（不要写入任何输出），获取方式：登录 https://agent.qcc.com/profile/api-key（新用户注册即送 600 积分）'
  const tokenRecipe = qccKey || '<向主人确认>'
  const confirmItems = [
    ...(qccKey ? [] : ['- 企查查外部查询的 Bearer Token（API Key）。']),
    '- 「至今」的结束日期边界默认按当前日期。',
  ]
  return [
    '---',
    `name: ${template?.skillName || 'invoice-self-check-helper'}`,
    'description: 在 CostPlus 费控系统复查历史报销发票的销售方注册状态：查询补贴台账、提取销售方全称、内部库校验、企查查外部查询并回写、输出异常清单',
    '---',
    '',
    '# 发票自查助手（CostPlus 历史报销发票复查）',
    '',
    '## 复查范围',
    '',
    `- 月度补贴台账：${from} 至今（含2026年），逐页取完。`,
    '',
    '## 职责边界',
    '',
    `- 查询 CostPlus 月度补贴台账（${from} 至今，含2026年），提取所有已报销发票的销售方全称。`,
    '- 对每个销售方：先查内部库 `http://weworker.weoa.com/cost/check`；未注册/未知的再调企查查外部接口查询注册状态；外部查到后回写内部库。',
    '- 最终输出注册状态异常的销售方清单。',
    '- 不负责提单、报销等写操作（除非用户明确另行要求）。',
    '',
    '## 领域知识',
    '',
    '- 台账数据链路：`list-subsidy-ledgers`（列表，返回每个台账的数值 id 与账本号）→ `get-subsidy-ledger`（详情，`--ledger-id=<数值ID>` 精确匹配〔推荐〕或 `--ledger-no=<账本号>` 模糊匹配，返回 invoiceIds）→ `list-subsidy-invoices`（发票明细，含销售方信息）。',
    '- `list-subsidy-ledgers` 支持 `--from-date` / `--to-date`（YYYY-MM-DD，均含边界）与 `--limit`（默认 20，可放大到 100 减少翻页）。',
    '- 批量执行原则：一个阶段的 ID 先收齐（存入 PowerShell 数组或哈希表），再用 foreach 循环批量调用下一阶段命令，并用 Select-String 只保留需要的字段行；不要一轮对话逐条人工发命令，既慢又占上下文。',
    '- 内部库校验接口：`GET http://weworker.weoa.com/cost/check?companyName=<URL编码后的销售方全称>`，返回该公司是否已内部知晓注册/续存状态。',
    `- 外部查询接口：企查查 MCP \`POST https://agent.qcc.com/mcp/company/stream\`，${tokenNote}，method 为 \`tools/call\`、tool 为 \`get_company_registration_info\`、参数 \`searchKey\` 传公司全称。返回为 UTF-8 字节流，需按 ISO-8859-1 解码回 UTF-8。`,
    '- 回写接口：`POST http://weworker.weoa.com/cost/upsert`，body 为 JSON：`{"companyName":..., "registrationStatus":...}`。',
    '- 「注册状态异常」定义：内部库或外部接口返回 未注册 / Company Not Found / 吊销 / 注销 / 除名 / 已停业等非「存续（在营、开业、在册）」状态。',
    '',
    '## 执行步骤',
    '',
    `1. \`webcli call costplus.weoa.com.list-subsidy-ledgers --from-date=${from} --to-date=<今天日期> --limit=100 --page=1\`，page 递增直到返回条数 < limit（未登录时 WeWorker 会自动处理登录，无需额外步骤）。`,
    '2. 把列表里全部台账的数值 id 收进 PowerShell 数组，foreach 循环批量调 `get-subsidy-ledger --ledger-id=$i`，Select-String 过滤只保留 id / invoiceIds 相关行，整理成「台账 → invoiceIds」映射。',
    '3. 把映射存进有序哈希表，foreach 循环按台账调 `list-subsidy-invoices --fp-ids=<该台账的发票池ID列表>`，每组输出前打印 `=== ledger <台账ID> ===` 分组标题，Select-String 过滤只保留销售方等需要的字段行；从结果提取销售方全称（完整全称，不要缩写）。',
    '4. 对去重后的每个销售方全称，调用内部库 check 接口（PowerShell `Invoke-RestMethod`，companyName 需 `EscapeDataString`）。',
    '5. check 返回未注册/未知 → 调企查查外部接口获取注册状态。',
    '6. 外部查到状态 → 调 upsert 接口回写内部库（每个公司回写一次即可，避免重复提交）。',
    '7. 汇总输出所有注册状态异常的销售方清单。',
    '',
    '## 常用操作配方',
    '',
    '- 查台账列表（大页减少翻页）：',
    `  \`webcli call costplus.weoa.com.list-subsidy-ledgers --from-date=${from} --to-date=<今天日期> --limit=100 --page=1\``,
    '- 批量查台账详情（数值 ID 来自列表结果）：',
    '  `$ids = <台账数值ID，逗号分隔>; foreach ($i in $ids) { webcli call costplus.weoa.com.get-subsidy-ledger --ledger-id=$i | Out-String -Stream | Select-String -Pattern \'"id"|"invoiceIds"\' | Out-String }`',
    '- 单个台账速查（按账本号模糊匹配）：',
    '  `webcli call costplus.weoa.com.get-subsidy-ledger --ledger-no=<账本号>`',
    '- 批量查发票明细（按台账分组，只保留关键字段行；过滤关键字按实际输出字段调整）：',
    '  `$map = [ordered]@{ \'<台账ID>\' = \'<该台账的发票池ID，逗号分隔>\' }; foreach ($k in $map.Keys) { "=== ledger $k ==="; $out = webcli call costplus.weoa.com.list-subsidy-invoices --fp-ids=$($map[$k]); ($out | Out-String) -split "`n" | Select-String -Pattern \'"id"|"seller"|"amount"\' | ForEach-Object { $_.Line.Trim() } }`',
    '- 内部库校验（Bash 中可用 PowerShell）：',
    '  `$name = [Uri]::EscapeDataString(\'<销售方全称>\'); Invoke-RestMethod "http://weworker.weoa.com/cost/check?companyName=$name" | ConvertTo-Json -Compress`',
    `- 外部企查查查询${qccKey ? '（Token 已内置，直接使用，但不要在输出中展示）' : '（Token 向主人确认，不写入输出）'}：`,
    `  \`$resp = Invoke-RestMethod 'https://agent.qcc.com/mcp/company/stream' -Method Post -ContentType 'application/json' -Headers @{ Authorization = 'Bearer ${tokenRecipe}'; Accept = 'application/json, text/event-stream' } -Body ([Text.Encoding]::UTF8.GetBytes('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_company_registration_info","arguments":{"searchKey":"<销售方全称>"}}}')); [Text.Encoding]::UTF8.GetString([Text.Encoding]::GetEncoding('ISO-8859-1').GetBytes([string]$resp))\``,
    '- 回写内部库：',
    '  `$body = \'{"companyName":"<销售方全称>","registrationStatus":"<查询到的状态>"}\'; Invoke-RestMethod \'http://weworker.weoa.com/cost/upsert\' -Method Post -ContentType \'application/json; charset=utf-8\' -Body ([Text.Encoding]::UTF8.GetBytes($body)) | ConvertTo-Json -Compress`',
    '',
    '## 注意事项与约束',
    '',
    '- 优先「收集 ID → foreach 批量循环」一次跑完一个阶段，不要逐条手动发命令。',
    '- webcli 输出用 Select-String 过滤只保留需要的字段行，避免整段 JSON 刷屏占用上下文。',
    '- 销售方名称必须取全称，禁止缩写或截断。',
    '- 企查查接口的 Bearer Token 不写入任何输出；' + (qccKey ? 'Token 已由主人在创建时提供，直接使用配方中的值即可。' : '实际调用时向主人确认。'),
    '- upsert 属于写操作：仅对本次外部查询成功获得状态的公司执行，且每公司一次；查询失败/超时的不回写，记入待处理。',
    '- 外部接口调用有成本，同一公司只查一次；先查内部库，内部已有「存续」等明确状态的不再外呼。',
    '- 分页查询注意 `page` 递增直到返回条数 < limit。',
    '- 公司量可能较大，分批处理并向主人汇报进度（已查台账数/公司数）。',
    '',
    '## 回答方式',
    '',
    '- 中间过程简洁汇报（已查台账数/公司数/进度）。',
    '- 最终输出：注册状态异常销售方清单（公司全称、注册状态、涉及台账/发票），以及查询失败的待处理清单。',
    '',
    '## 首次使用需向主人确认（不要猜）',
    '',
    ...confirmItems,
  ].join('\n')
}

/** 由答案构建要创建的定时任务列表（title/cron/prompt）；无定时任务的模板返回空数组。 */
export function buildTemplateTasks(template, answers) {
  if (template?.id === COSTPLUS_TEMPLATE_ID) return []
  const members = parseMembers(answers?.members)
  const roster = members.join('、') || '（待补充）'
  const tasks = [{
    key: 'daily',
    title: '团队 API Key 用量日报',
    cron_expression: buildDailyCron(Number(answers?.dailyHour ?? 9)),
    prompt_template: [
      '执行「团队 API Key 用量日报」：按照专属 Skill 中的方法，逐个查询团队成员'
      + `（${roster}）名下带 codeplan 的 API Key 当周使用情况，汇总成简短日报，`
      + '并用 send_agent_message 发送给主人。',
      '日报包含：每位成员的 Key 名称、供应商、当周使用率；如果某个成员查询结果为空，'
      + '在日报中提醒他需要先在 aiep 把主人加为其 API Key 的关注人。',
    ].join('\n'),
  }]
  if (answers?.monitorEnabled !== false) {
    const start = Number(answers?.monitorStart ?? 9)
    const end = Number(answers?.monitorEnd ?? 21)
    const interval = Number(answers?.monitorInterval ?? 2)
    tasks.push({
      key: 'monitor',
      title: 'API Key 额度监控',
      cron_expression: buildMonitoringCron(start, end, interval),
      prompt_template: [
        `执行「API Key 额度监控」：检查团队成员（${roster}）名下带 codeplan 的 API Key 的当周额度使用率，`
        + '按照专属 Skill 中的阈值规则（60%/70%/80%/90%）判断是否有新到达档位的 Key。',
        '有新告警时，用 send_agent_message 发送成员、Key 名称、供应商和当前百分比；'
        + '本轮没有新告警就不要发消息。',
      ].join('\n'),
    })
  }
  return tasks
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

/** 由答案构建 Agent 的描述文案。 */
export function buildTemplateDescription(template, answers) {
  if (template?.id === COSTPLUS_TEMPLATE_ID) {
    return '复查 CostPlus 费控系统 2024 年至今（含2026年）的历史报销发票，输出注册状态异常的销售方清单。'
  }
  const hour = Number(answers?.dailyHour ?? 9)
  const monitor = answers?.monitorEnabled !== false
    ? `；每天 ${Number(answers?.monitorStart ?? 9)}–${Number(answers?.monitorEnd ?? 21)} 点每 ${Number(answers?.monitorInterval ?? 2)} 小时监控额度告警`
    : ''
  return `每天 ${hour} 点推送团队 codeplan API Key 用量${monitor}。`
}

/** 由答案构建示例问题。 */
export function buildTemplateExamples(template, answers) {
  if (template?.id === COSTPLUS_TEMPLATE_ID) {
    return [
      '帮我把 2024 年以来的报销发票全面复查一遍',
      '有哪些销售方公司注册状态异常？',
      '复查进度怎么样了？',
    ]
  }
  const members = parseMembers(answers?.members)
  const first = members[0]
  return [
    '查一下团队今天的 codeplan key 用量',
    ...(first ? [`${first} 的 key 额度还剩多少？`] : []),
    '这个 key 是哪家供应商的，用量多少？',
  ]
}
