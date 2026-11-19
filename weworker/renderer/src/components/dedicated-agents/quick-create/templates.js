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
 * 企查查 API Key 归一化：从 agent.qcc.com 复制时往往带着 Bearer 前缀，
 * 剥掉后统一由配方里的 'Bearer ' 拼接，避免出现 Bearer Bearer。
 */
export function normalizeQccKey(value) {
  return String(value ?? '').trim().replace(/^Bearer\s+/i, '').trim()
}

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
    if (!key) return '请先填写企查查 API Key'
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
    return String(answers?.qccApiKey ?? '').trim() ? '已提供，将写入专属知识' : ''
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
    maxLength: 512,
    emoji: '🔑',
    title: '企查查 API Key',
    // 说明里的 [[url]] 会渲染成可点击链接，用系统默认浏览器打开。
    subtitle: '复查时用它查询销售方公司的注册状态，点击 [[https://agent.qcc.com/profile/api-key]] 获取（新用户注册即送 600 积分）。',
    placeholder: '粘贴企查查 API Key',
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
      '创建时需要填写企查查 API Key（agent.qcc.com 注册即送 600 积分）',
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
  // 创建时填写的企查查 API Key（粘贴值可能带 Bearer 前缀，先归一化）；未提供则运行时向主人确认。
  const qccKey = normalizeQccKey(answers?.qccApiKey).slice(0, 512)
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
    '- 批量执行原则：一个阶段的 ID 先收齐，再把每条 webcli 命令逐字写全、一行一条放进同一次工具调用批量执行（行尾可用管道接 Select-String 过滤输出）；不要一轮对话逐条人工发命令，既慢又占上下文。',
    '- 批次大小：每次工具调用放 6–8 行 webcli 命令为宜（单条估算 ≤10s，工具默认总超时约 120s，更大的批次会被中途截断、只拿到部分结果）；发起 PowerShell/Bash 工具调用时传 timeout: 600000 留足余量。',
    '- 运行时限制：webcli 调用必须是独立命令行、参数逐字写全；嵌进 PowerShell 变量、循环体、子 shell 或 $(...) 会被直接拒绝。纯 PowerShell 命令（如 Invoke-RestMethod）不受此限制，可自由使用 foreach 和变量。',
    '- 内部库校验接口：`GET http://weworker.weoa.com/cost/check?companyName=<URL编码后的销售方全称>`，返回该公司是否已内部知晓注册/续存状态。',
    `- 外部查询接口：企查查 MCP \`POST https://agent.qcc.com/mcp/company/stream\`，${tokenNote}，method 为 \`tools/call\`、tool 为 \`get_company_registration_info\`、参数 \`searchKey\` 传公司全称。返回为 UTF-8 字节流，需按 ISO-8859-1 解码回 UTF-8。`,
    '- 企查查 401 的判别与处理（以下为实测响应，直接对照）：401 时响应体是 JSON，形如 `{"error":"invalid_token","error_description":"...","message":"中文说明"}`。两种情况顶层 error 都是 invalid_token，必须看 error_description——`Invalid or expired token`＝Token 已失效或被吊销（不是积分、不是风控），不要等待或盲目重试，立即提醒主人到 https://agent.qcc.com/profile/api-key 重新生成 API Key 并提供新值；`Missing Authorization header`＝请求头没带上 Token，检查命令是否按配方原样执行（Headers 里 Authorization 是否被意外省略）。只有响应体是限流/风控类提示时才放慢节奏（每次调用间随机等待数秒）逐个重试。',
    '- Token 更换路径：主人提供新 Key 后，用 `update_agent_skill` 更新本 Skill——只把配方中的旧 Bearer 值替换为新值（主人亲自提供、用于替换既有凭证），其余内容保持不变，change_summary 注明「更换企查查 Key」；主人也可以在 WeWorker 桌面端本 Bot 的专属知识里直接编辑。',
    '- 回写接口：`POST http://weworker.weoa.com/cost/upsert`，body 为 JSON：`{"companyName":..., "registrationStatus":...}`。',
    '- 「注册状态异常」定义：内部库或外部接口返回 未注册 / Company Not Found / 吊销 / 注销 / 除名 / 已停业等非「存续（在营、开业、在册）」状态。',
    '',
    '## 执行步骤',
    '',
    `1. \`webcli call costplus.weoa.com.list-subsidy-ledgers --from-date=${from} --to-date=<今天日期> --limit=100 --page=1\`，page 递增直到返回条数 < limit（未登录时 WeWorker 会自动处理登录，无需额外步骤）。`,
    '2. 从列表结果收齐全部台账的数值 id，把每个台账写成一行 `webcli call costplus.weoa.com.get-subsidy-ledger --ledger-id=<具体ID>`（ID 逐字替换，不要用变量），按 6–8 行一批放进同一次工具调用批量执行（并传 timeout: 600000）；行尾接 `| Out-String -Stream | Select-String -Pattern \'"id"|invoiceIds|^\\s+"\\d\'`——模式里的 `^\\s+"\\d` 用来保住 invoiceIds 数组中的纯数字行（只匹配 "id" 会把它们滤掉，导致整批结果不可用），整理成「台账 → invoiceIds」映射。',
    '3. 首次查询发票明细时，先挑一个台账跑一条不带过滤的全量输出，确认实际字段名后再套用过滤模式；之后按台账把 `webcli call costplus.weoa.com.list-subsidy-invoices --fp-ids=<该台账的发票池ID，逗号分隔>` 逐台账写成一行（ID 逐字替换），同样按 6–8 行一批执行；行尾接 `| Out-String -Stream | Select-String -Pattern \'"id"|"seller"|"amount"\'`——保留 "id" 是为了建立「台账 → 发票 → 销售方」映射，只留 seller 会无法回溯涉及哪些台账；从结果提取销售方全称（完整全称，不要缩写）。',
    '4. 对去重后的每个销售方全称，调用内部库 check 接口（PowerShell `Invoke-RestMethod`，companyName 需 `EscapeDataString`；不含 webcli，可用 foreach 循环和变量批量执行）。公司数 >40 时按每批 ≤20 分批，每批结束向主人汇报进度。',
    '5. check 返回未注册/未知 → 调企查查外部接口获取注册状态；同样每批 ≤20，成功与失败名单分开记录，失败（超时/报错）的记入待处理、不回写。',
    '6. 外部查到状态 → 调 upsert 接口回写内部库（每个公司回写一次即可，避免重复提交）。',
    '7. 汇总输出所有注册状态异常的销售方清单。',
    '',
    '## 常用操作配方',
    '',
    '- 查台账列表（大页减少翻页）：',
    `  \`webcli call costplus.weoa.com.list-subsidy-ledgers --from-date=${from} --to-date=<今天日期> --limit=100 --page=1\``,
    '- 批量查台账详情（数值 ID 来自列表结果；每行一条、ID 逐字替换，6–8 行一批放进同一次工具调用执行）：',
    '  `webcli call costplus.weoa.com.get-subsidy-ledger --ledger-id=<ID1> | Out-String -Stream | Select-String -Pattern \'"id"|invoiceIds|^\\s+"\\d\'`',
    '  `webcli call costplus.weoa.com.get-subsidy-ledger --ledger-id=<ID2> | Out-String -Stream | Select-String -Pattern \'"id"|invoiceIds|^\\s+"\\d\'`',
    '- 单个台账速查（按账本号模糊匹配）：',
    '  `webcli call costplus.weoa.com.get-subsidy-ledger --ledger-no=<账本号>`',
    '- 批量查发票明细（每台账一行、fp-ids 逐字替换，放进同一次工具调用执行；过滤关键字按实际输出字段调整）：',
    '  `webcli call costplus.weoa.com.list-subsidy-invoices --fp-ids=<台账1的发票池ID，逗号分隔> | Out-String -Stream | Select-String -Pattern \'"id"|"seller"|"amount"\'`',
    '  `webcli call costplus.weoa.com.list-subsidy-invoices --fp-ids=<台账2的发票池ID，逗号分隔> | Out-String -Stream | Select-String -Pattern \'"id"|"seller"|"amount"\'`',
    '- 内部库校验（Bash 中可用 PowerShell）：',
    '  `$name = [Uri]::EscapeDataString(\'<销售方全称>\'); Invoke-RestMethod "http://weworker.weoa.com/cost/check?companyName=$name" | ConvertTo-Json -Compress`',
    `- 外部企查查查询${qccKey ? '（Token 已内置，直接使用，但不要在输出中展示）' : '（Token 向主人确认，不写入输出）'}：`,
    `  \`$resp = Invoke-RestMethod 'https://agent.qcc.com/mcp/company/stream' -Method Post -ContentType 'application/json' -Headers @{ Authorization = 'Bearer ${tokenRecipe}'; Accept = 'application/json, text/event-stream' } -Body ([Text.Encoding]::UTF8.GetBytes('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_company_registration_info","arguments":{"searchKey":"<销售方全称>"}}}')); [Text.Encoding]::UTF8.GetString([Text.Encoding]::GetEncoding('ISO-8859-1').GetBytes([string]$resp))\``,
    '- 回写内部库：',
    '  `$body = \'{"companyName":"<销售方全称>","registrationStatus":"<查询到的状态>"}\'; Invoke-RestMethod \'http://weworker.weoa.com/cost/upsert\' -Method Post -ContentType \'application/json; charset=utf-8\' -Body ([Text.Encoding]::UTF8.GetBytes($body)) | ConvertTo-Json -Compress`',
    '',
    '## 注意事项与约束',
    '',
    '- 批量时把 webcli 命令逐字写全、一行一条放进同一次工具调用；不要逐条手动发命令，也不要试图用变量、循环或子 shell 包住 webcli（会被运行时拒绝）。',
    '- 超时或中断后按台账 ID 顺序记录断点，只补跑未完成的批次；已拿到结果的行不要重发，避免成倍浪费调用。',
    '- webcli 输出用 Select-String 过滤只保留需要的字段行，避免整段 JSON 刷屏占用上下文。',
    '- 销售方名称必须取全称，禁止缩写或截断。',
    '- 企查查接口的 Bearer Token 不写入任何输出；' + (qccKey ? 'Token 已由主人在创建时提供，直接使用配方中的值即可。' : '实际调用时向主人确认。'),
    '- 连续 401 时先读响应体的 error_description 再定策略：Invalid or expired token 立即停止重试、提醒主人换 Key；Missing Authorization header 检查请求头写法；限流类提示才放慢节奏重试，不要把鉴权失败当风控硬等。',
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
