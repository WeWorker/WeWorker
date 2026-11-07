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

/** 校验模板答案，返回错误文案或 ''。 */
export function validateTemplateAnswers(template, answers) {
  if (!template) return '模板不存在'
  const name = String(answers?.name || '').trim()
  if (!name) return '请给 Bot 起个名字'
  if (name.length > 40) return '名称最长 40 个字符'
  const members = parseMembers(answers?.members)
  if (!members.length) return '请至少填写一位团队成员的英文名'
  const invalid = members.find((member) => !MEMBER_PATTERN.test(member))
  if (invalid) return `成员名「${invalid}」不像是有效的英文名（字母开头，可含数字、点、下划线和连字符）`
  const hour = Number(answers?.dailyHour)
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return '请选择每天推送日报的时间'
  if (answers?.monitorEnabled) {
    const start = Number(answers?.monitorStart)
    const end = Number(answers?.monitorEnd)
    const interval = Number(answers?.monitorInterval)
    if (![start, end, interval].every((value) => Number.isInteger(value))) return '额度监控的时间设置无效'
    if (start < 0 || start > 23 || end < 0 || end > 23) return '额度监控的时间范围只能在 0–23 点'
    if (interval < 1 || interval > 12) return '额度监控的执行间隔只能在 1–12 小时'
  }
  return ''
}

/**
 * 一问一答流程的问题清单（按提问顺序）。
 * 每个问题独占一屏：emoji + 大标题 + 说明 + 一个控件，选中即推进。
 */
export const TEMPLATE_QUESTIONS = [
  {
    id: 'name',
    type: 'text',
    emoji: '🤖',
    title: '先给它起个名字',
    subtitle: '它会用这个名字在 IM 里向你自我介绍。',
    placeholder: 'API Key 使用助手',
  },
  {
    id: 'members',
    type: 'textarea',
    emoji: '👥',
    title: '你的团队成员有哪些？',
    subtitle: '填英文名，逗号或换行分隔。想看到某位同事的用量，需要对方先在 aiep 上把你加为其 API Key 的关注人，没加的话它会在日报里提醒你们。',
    placeholder: 'alice\nbob, carol',
  },
  {
    id: 'dailyHour',
    type: 'hour',
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

/** 校验单个问题的答案，返回错误文案或 ''（问题未答完时对未到的问题放行）。 */
export function validateTemplateQuestion(template, questionId, answers) {
  if (!template) return '模板不存在'
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
  return ''
}

/** 已回答问题的气泡文案。 */
export function questionAnswerText(questionId, answers) {
  if (questionId === 'name') return String(answers?.name || '').trim()
  if (questionId === 'members') return parseMembers(answers?.members).join('、')
  if (questionId === 'dailyHour') return `每天 ${String(Number(answers?.dailyHour ?? 9)).padStart(2, '0')}:00`
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

/** 内置模板清单（当前先做一个，后续扩展）。 */
export const BUILT_IN_TEMPLATES = [
  {
    id: APIKEY_TEMPLATE_ID,
    emoji: '🔑',
    name: 'API Key 使用助手',
    tagline: '盯紧团队 codeplan API Key 的用量与额度，到点主动汇报',
    siteId: 'aiep.weoa.com',
    siteLabel: 'aiep',
    skillName: 'apikey-usage-helper',
    defaultName: 'API Key 使用助手',
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

/** 填空渲染模板 Bot 的专属 Skill（不调用大模型）。 */
export function renderTemplateSkill(template, answers) {
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

/** 由答案构建要创建的定时任务列表（title/cron/prompt）。 */
export function buildTemplateTasks(template, answers) {
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
  const hour = Number(answers?.dailyHour ?? 9)
  const monitor = answers?.monitorEnabled !== false
    ? `；每天 ${Number(answers?.monitorStart ?? 9)}–${Number(answers?.monitorEnd ?? 21)} 点每 ${Number(answers?.monitorInterval ?? 2)} 小时监控额度告警`
    : ''
  return `每天 ${hour} 点推送团队 codeplan API Key 用量${monitor}。`
}

/** 由答案构建示例问题。 */
export function buildTemplateExamples(template, answers) {
  const members = parseMembers(answers?.members)
  const first = members[0]
  return [
    '查一下团队今天的 codeplan key 用量',
    ...(first ? [`${first} 的 key 额度还剩多少？`] : []),
    '这个 key 是哪家供应商的，用量多少？',
  ]
}
