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

/** 阿里云凭证归一化：去掉首尾空白。 */
export function normalizeAliyunCredential(value) {
  return String(value ?? '').trim()
}

/** 腾讯云凭证归一化：去掉首尾空白。 */
export function normalizeTencentCredential(value) {
  return String(value ?? '').trim()
}

/** 判断问题是否完全未作答（兼容单字段与 credentials 多字段题型）。 */
export function isQuestionEmpty(question, answers) {
  if (!question) return true
  if (Array.isArray(question.fields) && question.fields.length > 0) {
    return question.fields.every((field) => !String(answers?.[field.answerKey] ?? '').trim())
  }
  return !String(answers?.[question.answerKey] ?? '').trim()
}

/**
 * 校验单个问题的答案，返回错误文案或 ''（问题未答完时对未到的问题放行）。
 * 问题 id 同时是答案 key；optional 的问题留空直接放行。
 */
export function validateTemplateQuestion(template, questionId, answers) {
  if (!template) return '模板不存在'
  const question = (template.questions || []).find((entry) => entry.id === questionId)
  if (!question) return ''
  if (question.optional && isQuestionEmpty(question, answers)) return ''
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
  if (questionId === 'tencentAuth') {
    const secretId = normalizeTencentCredential(answers?.tencentSecretId)
    const secretKey = normalizeTencentCredential(answers?.tencentSecretKey)
    if (!secretId && !secretKey) return ''
    if (!secretId) return '请同时填写腾讯云 SecretId（或两项都留空以跳过）'
    if (!secretKey) return '请同时填写腾讯云 SecretKey（或两项都留空以跳过）'
    if (secretId.length > 128) return 'SecretId 过长，请核对后重试'
    if (secretKey.length > 256) return 'SecretKey 过长，请核对后重试'
    return ''
  }
  if (questionId === 'aliyunAuth') {
    const akId = normalizeAliyunCredential(answers?.aliyunAccessKeyId)
    const akSecret = normalizeAliyunCredential(answers?.aliyunAccessKeySecret)
    if (!akId && !akSecret) return ''
    if (!akId) return '请同时填写阿里云 AccessKey ID（或两项都留空以跳过）'
    if (!akSecret) return '请同时填写阿里云 AccessKey Secret（或两项都留空以跳过）'
    if (akId.length > 128) return 'AccessKey ID 过长，请核对后重试'
    if (akSecret.length > 256) return 'AccessKey Secret 过长，请核对后重试'
    return ''
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
  if (questionId === 'tencentAuth') {
    const hasTencent = Boolean(
      normalizeTencentCredential(answers?.tencentSecretId)
      && normalizeTencentCredential(answers?.tencentSecretKey),
    )
    // 摘要里不回显 SecretId/SecretKey 原文，只说明是否已配置。
    return hasTencent ? '已提供，将写入专属知识' : '未配置，已跳过'
  }
  if (questionId === 'aliyunAuth') {
    const hasAk = Boolean(
      normalizeAliyunCredential(answers?.aliyunAccessKeyId)
      && normalizeAliyunCredential(answers?.aliyunAccessKeySecret),
    )
    const hasTencent = Boolean(
      normalizeTencentCredential(answers?.tencentSecretId)
      && normalizeTencentCredential(answers?.tencentSecretKey),
    )
    // 摘要里不回显 AK/SK 原文，只说明是否已配置。
    return hasAk ? '已提供，将写入专属知识' : (hasTencent ? '未配置，已跳过' : '未配置，仅复查销售方状态')
  }
  if (questionId === 'tencentServiceEnable') {
    return '已确认开通发票核验服务'
  }
  if (questionId === 'aliyunServiceEnable') {
    return '已确认开通票证核验服务'
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

const TENCENT_OCR_ENABLE_URL = 'https://cloud.tencent.com/product/vtiv'
const ALIYUN_OCR_ENABLE_URL = 'https://common-buy.aliyun.com/?spm=5176.28059030.0.0.68c21287dXK0hR&commodityCode=ocr_cardverification_public_cn'

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
  {
    id: 'tencentAuth',
    type: 'credentials',
    optional: true,
    emoji: '☁️',
    title: '腾讯云发票核验凭证（可选）',
    subtitle: '用于调用腾讯云 VatInvoiceVerifyNew 核验数电票状态（作废/红冲/真伪）。前往 [[https://console.cloud.tencent.com/cam/capi]] 获取 SecretId / SecretKey；暂不需要可直接跳过，仅复查销售方注册状态。',
    note: '🔒 SecretId / SecretKey 仅保存在客户端本地，不会上传到任何服务端。',
    fields: [
      {
        answerKey: 'tencentSecretId',
        label: 'SecretId',
        placeholder: '粘贴腾讯云 SecretId',
        maxLength: 128,
      },
      {
        answerKey: 'tencentSecretKey',
        label: 'SecretKey',
        placeholder: '粘贴腾讯云 SecretKey',
        maxLength: 256,
        secret: true,
      },
    ],
  },
  {
    id: 'tencentServiceEnable',
    type: 'guide',
    emoji: '✅',
    title: '开通腾讯云发票核验服务',
    subtitle: '调用发票核验接口前，需要先在腾讯云开通「增值税发票核验」服务，开通后您可享 50 次免费额度（已开通可直接继续）。',
    warning: '⚠️ 注意：超出 50 次免费额度后会产生费用，账号里千万不要有余额。',
    actionLabel: '前往开通发票核验服务 ↗',
    actionUrl: TENCENT_OCR_ENABLE_URL,
    confirmLabel: '我已开通，继续',
    when: (answers) => Boolean(
      normalizeTencentCredential(answers?.tencentSecretId)
      && normalizeTencentCredential(answers?.tencentSecretKey),
    ),
  },
  {
    id: 'aliyunAuth',
    type: 'credentials',
    optional: true,
    emoji: '🧾',
    title: '阿里云发票核验凭证（可选）',
    subtitle: '用于调用阿里云 VerifyVATInvoice 核验发票状态（作废/红冲/真伪）。前往 [[https://ram.console.aliyun.com/manage/ak]] 获取 AccessKey；暂不需要可直接跳过，仅复查销售方注册状态。',
    note: '🔒 AccessKey ID / Secret 仅保存在客户端本地，不会上传到任何服务端。',
    fields: [
      {
        answerKey: 'aliyunAccessKeyId',
        label: 'AccessKey ID',
        placeholder: '粘贴阿里云 AccessKey ID',
        maxLength: 128,
      },
      {
        answerKey: 'aliyunAccessKeySecret',
        label: 'AccessKey Secret',
        placeholder: '粘贴阿里云 AccessKey Secret',
        maxLength: 256,
        secret: true,
      },
    ],
  },
  {
    id: 'aliyunServiceEnable',
    type: 'guide',
    emoji: '✅',
    title: '开通阿里云票证核验服务',
    subtitle: '调用发票核验接口前，需要先在阿里云开通「票证核验」服务，开通后您可享 50 次免费额度（已开通可直接进入下一步）。',
    warning: '⚠️ 注意：超出 50 次免费额度后会产生费用，账号里千万不要有余额。',
    actionLabel: '前往开通票证核验服务 ↗',
    actionUrl: ALIYUN_OCR_ENABLE_URL,
    confirmLabel: '我已开通，下一步',
    when: (answers) => Boolean(
      normalizeAliyunCredential(answers?.aliyunAccessKeyId)
      && normalizeAliyunCredential(answers?.aliyunAccessKeySecret),
    ),
  },
]

/** 内置模板清单（BotHub 展示顺序即数组顺序）。 */
export const BUILT_IN_TEMPLATES = [
  {
    id: COSTPLUS_TEMPLATE_ID,
    emoji: '🧾',
    name: '发票自查助手',
    tagline: '复查历史报销发票，揪出注册异常的销售方与异常发票',
    siteId: 'costplus.weoa.com',
    siteLabel: 'CostPlus',
    skillName: 'invoice-self-check-helper',
    defaultName: '发票自查助手',
    questions: COSTPLUS_QUESTIONS,
    highlights: [
      '一键复查费控系统 2024 年至今的全部补贴台账报销发票',
      '销售方公司逐个校验注册状态：内部库优先，未知的再查企查查并回写',
      '可选直连腾讯云 / 阿里云发票核验接口，核验数电票作废/红冲/真伪状态',
      '输出销售方与发票异常清单，不做提单、报销等写操作',
    ],
    needs: [
      '需要 CostPlus（费控系统）网站能力已启用且已登录',
      '创建时需要填写企查查 API Key（agent.qcc.com 注册即送 600 积分）',
      '可选填写腾讯云 SecretId/SecretKey 或阿里云 AccessKey（任选其一或双通道互补，核验数电票状态）',
    ],
    defaultAnswers: {
      name: '发票自查助手',
      qccApiKey: '',
      tencentSecretId: '',
      tencentSecretKey: '',
      aliyunAccessKeyId: '',
      aliyunAccessKeySecret: '',
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

/** 按当前答案过滤出需要展示的问题清单（支持条件引导步骤）。 */
export function visibleTemplateQuestions(template, answers) {
  return templateQuestions(template).filter((question) => (
    typeof question.when === 'function' ? Boolean(question.when(answers)) : true
  ))
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
  // 创建时可选填写的腾讯云 SecretId / SecretKey（直连 VatInvoiceVerifyNew 核验数电票状态）。
  const tencentSecretId = normalizeTencentCredential(answers?.tencentSecretId).slice(0, 128)
  const tencentSecretKey = normalizeTencentCredential(answers?.tencentSecretKey).slice(0, 256)
  const hasTencent = Boolean(tencentSecretId && tencentSecretKey)
  const tencentNote = hasTencent
    ? 'SecretId 与 SecretKey 已由主人在创建时提供并写在下方配方中；仍属敏感信息，不要在任何输出、日志或回复里展示'
    : 'SecretId 与 SecretKey 当前未配置；如需启用腾讯云核验，请向主人获取（前往 https://console.cloud.tencent.com/cam/capi 获取，需开通文字识别 OCR 服务），不要写入任何输出'
  const tencentIdLiteral = JSON.stringify(tencentSecretId || '<向主人确认>')
  const tencentKeyLiteral = JSON.stringify(tencentSecretKey || '<向主人确认>')
  // 创建时可选填写的阿里云 AccessKey（直连 VerifyVATInvoice 核验数电票状态）。
  const aliyunAkId = normalizeAliyunCredential(answers?.aliyunAccessKeyId).slice(0, 128)
  const aliyunAkSecret = normalizeAliyunCredential(answers?.aliyunAccessKeySecret).slice(0, 256)
  const hasAliyun = Boolean(aliyunAkId && aliyunAkSecret)
  const aliyunNote = hasAliyun
    ? 'AccessKey ID 与 AccessKey Secret 已由主人在创建时提供并写在下方配方中；仍属敏感信息，不要在任何输出、日志或回复里展示'
    : 'AccessKey ID 与 AccessKey Secret 当前未配置；如需启用阿里云核验，请向主人获取（前往 https://ram.console.aliyun.com/manage/ak 获取，并开通票证核验服务），不要写入任何输出'
  const aliyunIdLiteral = JSON.stringify(aliyunAkId || '<向主人确认>')
  const aliyunSecretLiteral = JSON.stringify(aliyunAkSecret || '<向主人确认>')
  const invoiceBoundaryLine = hasTencent && hasAliyun
    ? '- 对每张去重后的数电票（20 位 `invoiceNumber`）：已配置腾讯云 + 阿里云双通道，优先直连腾讯云 OCR `VatInvoiceVerifyNew` 核验发票状态（作废/红冲/真伪等），遇到上游省局通道超时或故障时自动改用阿里云 `VerifyVATInvoice` 兜底补查；每张发票查到明确状态即止，非 20 位传统发票直接跳过。'
    : hasTencent
      ? '- 对每张去重后的数电票（20 位 `invoiceNumber`）：直连腾讯云 OCR 发票核验接口（`VatInvoiceVerifyNew`）查询发票状态（作废/红冲/真伪等），每张发票仅查一次；非 20 位传统发票直接跳过。'
      : hasAliyun
        ? '- 对每张去重后的数电票（20 位 `invoiceNumber`）：直连阿里云 OCR 发票核验接口（`VerifyVATInvoice`）查询发票状态（作废/红冲/真伪等），每张发票仅查一次；非 20 位传统发票直接跳过。'
        : '- 发票状态核验（腾讯云 `VatInvoiceVerifyNew` / 阿里云 `VerifyVATInvoice`，仅核验 20 位数电票）：当前均未配置凭证，默认跳过、仅复查销售方注册状态；若主人明确要求核验发票状态并提供腾讯云或阿里云凭证，可按下方配方直连查验。'
  const invoiceStepLine = hasTencent && hasAliyun
    ? '7. 对去重后的数电票（按 20 位 `invoiceNumber` 过滤并去重，非 20 位传统发票直接跳过），优先使用下方腾讯云 `VatInvoiceVerifyNew` Node.js 配方直连核验（每批 ≤20 张）；若单张遇到上游省局超时/通道异常，改用阿里云 `VerifyVATInvoice` 配方兜底补查，每批结束向主人汇报进度，将正常、状态异常与查询失败分开记录。'
    : hasTencent
      ? '7. 对去重后的数电票（按 20 位 `invoiceNumber` 过滤并去重，非 20 位传统发票直接跳过），使用下方腾讯云 Node.js 配方直连 `VatInvoiceVerifyNew`（传 `InvoiceNo`、`InvoiceDate`、`Additional`）核验发票状态；按每批 ≤20 张批量执行，每批结束向主人汇报进度，将正常、状态异常与查询失败分开记录。'
      : hasAliyun
        ? '7. 对去重后的数电票（按 20 位 `invoiceNumber` 过滤并去重，非 20 位传统发票直接跳过），使用下方阿里云 Node.js 配方直连 `VerifyVATInvoice`（传 `InvoiceNo`、`InvoiceDate`、`InvoiceSum`）核验发票状态；按每批 ≤20 张批量执行，每批结束向主人汇报进度，将正常、状态异常与查询失败分开记录。'
        : '7. （可选）当前未配置腾讯云或阿里云发票核验凭证，默认跳过本步；若主人后续提供了任一云商凭证，再按下方对应 Node.js 配方对去重后的 20 位数电票分批（每批 ≤20 张）直连核验状态。'
  const confirmItems = [
    ...(qccKey ? [] : ['- 企查查外部查询的 Bearer Token（API Key）。']),
    '- 「至今」的结束日期边界默认按当前日期。',
  ]
  return [
    '---',
    `name: ${template?.skillName || 'invoice-self-check-helper'}`,
    'description: 在 CostPlus 费控系统复查历史报销发票的销售方注册状态与发票状态：查询补贴台账、提取销售方与发票字段、内部库/企查查校验销售方、可选直连腾讯云 VatInvoiceVerifyNew 或阿里云 VerifyVATInvoice 核验数电票状态、输出异常清单',
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
    `- 查询 CostPlus 月度补贴台账（${from} 至今，含2026年），提取所有已报销发票的销售方全称与数电票核验字段（invoiceNumber、billingDate、amount）。`,
    '- 对每个销售方：先查内部库 `http://weworker.weoa.com/cost/check`；未注册/未知的再调企查查外部接口查询注册状态；外部查到后回写内部库。',
    invoiceBoundaryLine,
    '- 最终输出注册状态异常的销售方清单与状态异常的发票清单（如已执行发票核验）。',
    '- 不负责提单、报销等写操作（除非用户明确另行要求）。',
    '',
    '## 领域知识',
    '',
    '- 台账数据链路：`list-subsidy-ledgers`（列表，返回每个台账的数值 id 与账本号）→ `get-subsidy-ledger`（详情，`--ledger-id=<数值ID>` 精确匹配〔推荐〕或 `--ledger-no=<账本号>` 模糊匹配，返回 invoiceIds）→ `list-subsidy-invoices`（发票明细，含销售方信息及发票号码/开票日期等字段）。',
    '- `list-subsidy-ledgers` 支持 `--from-date` / `--to-date`（YYYY-MM-DD，均含边界）与 `--limit`（默认 20，可放大到 100 减少翻页）。',
    '- 批量执行原则：一个阶段的 ID 先收齐，再把每条 webcli 命令逐字写全、一行一条放进同一次工具调用批量执行（行尾可用管道接 Select-String 过滤输出）；不要一轮对话逐条人工发命令，既慢又占上下文。',
    '- 批次大小：每次工具调用放 6–8 行 webcli 命令为宜（单条估算 ≤10s，工具默认总超时约 120s，更大的批次会被中途截断、只拿到部分结果）；发起 PowerShell/Bash 工具调用时传 timeout: 600000 留足余量。',
    '- 运行时限制：webcli 调用必须是独立命令行、参数逐字写全；嵌进 PowerShell 变量、循环体、子 shell 或 $(...) 会被直接拒绝。纯 PowerShell 命令（如 Invoke-RestMethod）和纯 Node.js 脚本不受此限制，可自由使用循环和变量。',
    '- 内部库校验接口：`GET http://weworker.weoa.com/cost/check?companyName=<URL编码后的销售方全称>`，返回该公司是否已内部知晓注册/续存状态。',
    `- 外部销售方查询接口：企查查 MCP \`POST https://agent.qcc.com/mcp/company/stream\`，${tokenNote}，method 为 \`tools/call\`、tool 为 \`get_company_registration_info\`、参数 \`searchKey\` 传公司全称。返回为 UTF-8 字节流，需按 ISO-8859-1 解码回 UTF-8。`,
    '- 企查查 401 的判别与处理（以下为实测响应，直接对照）：401 时响应体是 JSON，形如 `{"error":"invalid_token","error_description":"...","message":"中文说明"}`。两种情况顶层 error 都是 invalid_token，必须看 error_description——`Invalid or expired token`＝Token 已失效或被吊销（不是积分、不是风控），不要等待或盲目重试，立即提醒主人到 https://agent.qcc.com/profile/api-key 重新生成 API Key 并提供新值；`Missing Authorization header`＝请求头没带上 Token，检查命令是否按配方原样执行（Headers 里 Authorization 是否被意外省略）。只有响应体是限流/风控类提示时才放慢节奏（每次调用间随机等待数秒）逐个重试。',
    '- Token 更换路径：主人提供新企查查 Key 后，用 `update_agent_skill` 更新本 Skill——只把配方中的旧 Bearer 值替换为新值（主人亲自提供、用于替换既有凭证），其余内容保持不变，change_summary 注明「更换企查查 Key」；主人也可以在 WeWorker 桌面端本 Bot 的专属知识里直接编辑。',
    '- 回写接口：`POST http://weworker.weoa.com/cost/upsert`，body 为 JSON：`{"companyName":..., "registrationStatus":...}`。',
    '- 「注册状态异常」定义：内部库或外部接口返回 未注册 / Company Not Found / 吊销 / 注销 / 除名 / 已停业等非「存续（在营、开业、在册）」状态。',
    `- 外部发票状态核验接口（腾讯云）：腾讯云 OCR \`VatInvoiceVerifyNew\`（\`POST https://ocr.tencentcloudapi.com/\`，\`X-TC-Action: VatInvoiceVerifyNew\`，\`X-TC-Version: 2018-11-19\`，\`X-TC-Region: ap-guangzhou\`，API 3.0 签名 \`TC3-HMAC-SHA256\`），${tencentNote}。仅核验 **20 位数字的数电票**，字段映射为 \`invoiceNumber\` → \`InvoiceNo\`、\`billingDate\` → \`InvoiceDate\`（**必须为 \`YYYY-MM-DD\`**）、\`amount\`（价税合计）→ \`Additional\`；返回 \`Response.Invoice.StateCode\` 中 \`0\`＝正常、\`1\`＝未更新、\`2\`＝作废、\`3\`＝已红冲（非 \`0\` 或验真报错视为发票状态异常）。`,
    `- 腾讯云错误码判别与换 Key 路径：\`AuthFailure.SecretIdNotFound\` / \`AuthFailure.SignatureFailure\`＝SecretId/SecretKey 无效或填错，立即停止批量重试，提醒主人到 https://console.cloud.tencent.com/cam/capi 核对或重新生成；\`FailedOperation.UnOpenError\` / \`FailedOperation.ArrearsError\` / \`ResourceInsufficient\`＝未开通增值税发票核验服务或欠费/资源包耗尽，立即停止并提醒主人前往 ${TENCENT_OCR_ENABLE_URL} 开通/续费；\`FailedOperation.DownStreamError\` / \`RequestLimitExceeded\` / \`LimitExceeded\`＝上游税局通道异常或限流，最多重试 1 次，仍失败时若已配置阿里云则切换阿里云补查，否则记入待处理。主人提供新 SecretId/SecretKey 后，用 \`update_agent_skill\` 只替换腾讯云配方中的 \`secretId\` / \`secretKey\` 值，change_summary 注明「更换腾讯云 Key」。`,
    `- 外部发票状态核验接口（阿里云）：阿里云 OCR \`VerifyVATInvoice\`（\`POST https://ocr-api.cn-hangzhou.aliyuncs.com/\`，\`x-acs-action: VerifyVATInvoice\`，\`x-acs-version: 2021-07-07\`，OpenAPI V3 签名 \`ACS3-HMAC-SHA256\`），${aliyunNote}。每张发票号码唯一，直连核验、不走内部库缓存。`,
    '- `VerifyVATInvoice` 数电票入参映射：仅核验 **20 位数字的数电票**（非 20 位传统发票直接跳过，避免无效外呼）；字段映射为 `invoiceNumber` → `InvoiceNo`、`billingDate` → `InvoiceDate`（去掉横杠归一化为 `YYYYMMDD`）、`amount`（价税合计）→ `InvoiceSum`，数电票无需传 `InvoiceCode` 和 `VerifyCode`。',
    '- 「发票状态异常」定义：阿里云返回外层 `Data` 字段为 JSON 字符串，需二次 `JSON.parse`，`invalidMark === "N"` 且查验一致视为正常，`invalidMark !== "N"`（如作废、全额/部分红冲、失控、异常）视为异常；腾讯云返回 `StateCode === "0"` 视为正常，`2`（作废）/ `3`（已红冲）/ 查无此票 / 验真不通过视为异常。若因缺少字段返回「查询发票不规范」类提示，归类为「缺少核验字段」记入待处理，不要误判为假票或作废票。',
    `- 阿里云错误码判别与换 Key 路径：\`InvalidAccessKeyId.NotFound\` 或 \`SignatureDoesNotMatch\`＝AK/SK 无效或填错，立即停止批量重试，提醒主人到 https://ram.console.aliyun.com/manage/ak 核对或重新生成；\`ocrServiceNotOpen\` / \`OcrServiceExpired\`（401）＝未开通票证核验服务或资源包过期/欠费，立即停止并提醒主人前往 ${ALIYUN_OCR_ENABLE_URL} 开通/续费；\`503\` / \`AlgorithmTimeout\` / \`ServiceUnavailable\` / 限流＝对应省份税务局查验通道临时超时或拥堵，最多重试 1 次（间隔数秒），仍失败时若已配置腾讯云可切换腾讯云补查，否则直接记入待处理（标注省码与超时原因，建议稍后/次日复查，不要反复死磕）。主人提供新 AK/SK 后，用 \`update_agent_skill\` 只替换配方中的 \`akId\` / \`akSecret\` 值，change_summary 注明「更换阿里云 Key」。`,
    '',
    '## 执行步骤',
    '',
    `1. \`webcli call costplus.weoa.com.list-subsidy-ledgers --from-date=${from} --to-date=<今天日期> --limit=100 --page=1\`，page 递增直到返回条数 < limit（未登录时 WeWorker 会自动处理登录，无需额外步骤）。`,
    '2. 从列表结果收齐全部台账的数值 id，把每个台账写成一行 `webcli call costplus.weoa.com.get-subsidy-ledger --ledger-id=<具体ID>`（ID 逐字替换，不要用变量），按 6–8 行一批放进同一次工具调用批量执行（并传 timeout: 600000）；行尾接 `| Out-String -Stream | Select-String -Pattern \'"id"|invoiceIds|^\\s+"\\d\'`——模式里的 `^\\s+"\\d` 用来保住 invoiceIds 数组中的纯数字行（只匹配 "id" 会把它们滤掉，导致整批结果不可用），整理成「台账 → invoiceIds」映射。',
    '3. 首次查询发票明细时，先挑一个台账跑一条不带过滤的全量输出，确认实际字段名后再套用过滤模式；之后按台账把 `webcli call costplus.weoa.com.list-subsidy-invoices --fp-ids=<该台账的发票池ID，逗号分隔>` 逐台账写成一行（ID 逐字替换），同样按 6–8 行一批执行；行尾用 `Select-String` 保留 `id`、`seller`、`amount`、`invoiceNumber`、`invoiceType`、`billingDate` 字段——保留 "id" 是为了建立「台账 → 发票 → 销售方」映射，只留 seller 会无法回溯涉及哪些台账；从结果提取销售方全称（完整全称，不要缩写）与数电票核验字段（`invoiceNumber`、`billingDate`、`amount`）。',
    '4. 对去重后的每个销售方全称，调用内部库 check 接口（PowerShell `Invoke-RestMethod`，companyName 需 `EscapeDataString`；不含 webcli，可用 foreach 循环和变量批量执行）。公司数 >40 时按每批 ≤20 分批，每批结束向主人汇报进度。',
    '5. check 返回未注册/未知 → 调企查查外部接口获取注册状态；同样每批 ≤20，成功与失败名单分开记录，失败（超时/报错）的记入待处理、不回写。',
    '6. 外部查到销售方状态 → 调 upsert 接口回写内部库（每个公司回写一次即可，避免重复提交）。',
    invoiceStepLine,
    '8. 汇总输出所有注册状态异常的销售方清单、状态异常的发票清单（如已核验），以及查询失败/缺少核验字段的待处理清单。',
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
    '- 批量查发票明细（每台账一行、fp-ids 逐字替换，放进同一次工具调用执行；保留销售方及数电票核验所需字段）：',
    '  `webcli call costplus.weoa.com.list-subsidy-invoices --fp-ids=<台账1的发票池ID，逗号分隔> | Out-String -Stream | Select-String -Pattern \'"id"|"seller"|"amount"|"invoiceNumber"|"invoiceType"|"billingDate"\'`',
    '  `webcli call costplus.weoa.com.list-subsidy-invoices --fp-ids=<台账2的发票池ID，逗号分隔> | Out-String -Stream | Select-String -Pattern \'"id"|"seller"|"amount"|"invoiceNumber"|"invoiceType"|"billingDate"\'`',
    '- 内部库校验（Bash 中可用 PowerShell）：',
    '  `$name = [Uri]::EscapeDataString(\'<销售方全称>\'); Invoke-RestMethod "http://weworker.weoa.com/cost/check?companyName=$name" | ConvertTo-Json -Compress`',
    `- 外部企查查查询${qccKey ? '（Token 已内置，直接使用，但不要在输出中展示）' : '（Token 向主人确认，不写入输出）'}：`,
    `  \`$resp = Invoke-RestMethod 'https://agent.qcc.com/mcp/company/stream' -Method Post -ContentType 'application/json' -Headers @{ Authorization = 'Bearer ${tokenRecipe}'; Accept = 'application/json, text/event-stream' } -Body ([Text.Encoding]::UTF8.GetBytes('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_company_registration_info","arguments":{"searchKey":"<销售方全称>"}}}')); [Text.Encoding]::UTF8.GetString([Text.Encoding]::GetEncoding('ISO-8859-1').GetBytes([string]$resp))\``,
    '- 回写内部库：',
    '  `$body = \'{"companyName":"<销售方全称>","registrationStatus":"<查询到的状态>"}\'; Invoke-RestMethod \'http://weworker.weoa.com/cost/upsert\' -Method Post -ContentType \'application/json; charset=utf-8\' -Body ([Text.Encoding]::UTF8.GetBytes($body)) | ConvertTo-Json -Compress`',
    `- 腾讯云发票状态核验（Node.js 内联脚本，直连 \`VatInvoiceVerifyNew\`，支持批量数组；${hasTencent ? 'SecretId/SecretKey 已内置，直接使用，但不要在输出中展示' : 'SecretId/SecretKey 向主人确认，不写入输出'}）：`,
    '```js',
    'const crypto = require(\'node:crypto\');',
    `const secretId = ${tencentIdLiteral};`,
    `const secretKey = ${tencentKeyLiteral};`,
    'const sha256 = (s) => crypto.createHash(\'sha256\').update(s, \'utf8\').digest(\'hex\');',
    'const hmac = (key, msg) => crypto.createHmac(\'sha256\', key).update(msg, \'utf8\').digest();',
    'const formatDate = (s) => {',
    '  const d = String(s || \'\').replace(/[^0-9]/g, \'\');',
    '  return d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : String(s || \'\').trim();',
    '};',
    'async function verifyInvoiceTencent(input) {',
    '  const invoiceNo = String(input.InvoiceNo || \'\').trim();',
    '  if (!/^\\d{20}$/.test(invoiceNo)) return { invoiceNo, skipped: true, reason: \'非20位数电票\' };',
    '  const payload = JSON.stringify({',
    '    InvoiceNo: invoiceNo,',
    '    InvoiceDate: formatDate(input.InvoiceDate),',
    '    ...(input.Additional ? { Additional: String(input.Additional).trim() } : {}),',
    '  });',
    '  const host = \'ocr.tencentcloudapi.com\';',
    '  const service = \'ocr\';',
    '  const action = \'VatInvoiceVerifyNew\';',
    '  const timestamp = Math.floor(Date.now() / 1000);',
    '  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);',
    '  const contentType = \'application/json; charset=utf-8\';',
    '  const canonicalHeaders = `content-type:${contentType}\\nhost:${host}\\nx-tc-action:${action.toLowerCase()}\\n`;',
    '  const signedHeaders = \'content-type;host;x-tc-action\';',
    '  const canonicalRequest = [\'POST\', \'/\', \'\', canonicalHeaders, signedHeaders, sha256(payload)].join(\'\\n\');',
    '  const credentialScope = `${date}/${service}/tc3_request`;',
    '  const stringToSign = [\'TC3-HMAC-SHA256\', String(timestamp), credentialScope, sha256(canonicalRequest)].join(\'\\n\');',
    '  const kDate = hmac(`TC3${secretKey}`, date);',
    '  const kService = hmac(kDate, service);',
    '  const kSigning = hmac(kService, \'tc3_request\');',
    '  const signature = crypto.createHmac(\'sha256\', kSigning).update(stringToSign, \'utf8\').digest(\'hex\');',
    '  const res = await fetch(`https://${host}/`, {',
    '    method: \'POST\',',
    '    headers: {',
    '      \'Content-Type\': contentType,',
    '      \'X-TC-Action\': action,',
    '      \'X-TC-Version\': \'2018-11-19\',',
    '      \'X-TC-Timestamp\': String(timestamp),',
    '      \'X-TC-Region\': \'ap-guangzhou\',',
    '      Authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,',
    '    },',
    '    body: payload,',
    '  });',
    '  const json = await res.json();',
    '  const resp = json.Response || {};',
    '  return {',
    '    invoiceNo,',
    '    httpStatus: res.status,',
    '    errorCode: resp.Error?.Code || \'\',',
    '    errorMessage: resp.Error?.Message || \'\',',
    '    stateCode: resp.Invoice?.StateCode ?? \'\',',
    '    sellerName: resp.Invoice?.SellerName || \'\',',
    '    total: resp.Invoice?.Total || \'\',',
    '  };',
    '}',
    '// 按批传入 ≤20 张数电票（invoiceNumber → InvoiceNo，billingDate → InvoiceDate，amount → Additional），通过 `node -` 执行：',
    '(async () => {',
    '  const batch = [{ InvoiceNo: \'<invoiceNumber>\', InvoiceDate: \'<billingDate>\', Additional: \'<amount>\' }];',
    '  for (const item of batch) console.log(JSON.stringify(await verifyInvoiceTencent(item)));',
    '})();',
    '```',
    `- 阿里云发票状态核验（Node.js 内联脚本，直连 \`VerifyVATInvoice\`，支持批量数组；${hasAliyun ? 'AK/SK 已内置，直接使用，但不要在输出中展示' : 'AK/SK 向主人确认，不写入输出'}）：`,
    '```js',
    'const crypto = require(\'node:crypto\');',
    `const akId = ${aliyunIdLiteral};`,
    `const akSecret = ${aliyunSecretLiteral};`,
    'const enc = (s) => encodeURIComponent(String(s)).replace(/[!\'()*]/g, (c) => \'%\' + c.charCodeAt(0).toString(16).toUpperCase());',
    'const sha256 = (s) => crypto.createHash(\'sha256\').update(s, \'utf8\').digest(\'hex\');',
    'async function verifyInvoice(input) {',
    '  const invoiceNo = String(input.InvoiceNo || \'\').trim();',
    '  if (!/^\\d{20}$/.test(invoiceNo)) return { invoiceNo, skipped: true, reason: \'非20位数电票\' };',
    '  const params = {',
    '    InvoiceNo: invoiceNo,',
    '    InvoiceDate: String(input.InvoiceDate || \'\').replace(/-/g, \'\').trim(),',
    '    ...(input.InvoiceSum ? { InvoiceSum: String(input.InvoiceSum).trim() } : {}),',
    '  };',
    '  const qs = Object.keys(params).sort().map((k) => `${enc(k)}=${enc(params[k])}`).join(\'&\');',
    '  const host = \'ocr-api.cn-hangzhou.aliyuncs.com\';',
    '  const bodyHash = sha256(\'\');',
    '  const headers = {',
    '    host,',
    '    \'x-acs-action\': \'VerifyVATInvoice\',',
    '    \'x-acs-content-sha256\': bodyHash,',
    '    \'x-acs-date\': new Date().toISOString().replace(/\\.\\d{3}Z$/, \'Z\'),',
    '    \'x-acs-signature-nonce\': crypto.randomUUID(),',
    '    \'x-acs-version\': \'2021-07-07\',',
    '  };',
    '  const keys = Object.keys(headers).sort();',
    '  const canonicalHeaders = keys.map((k) => `${k}:${headers[k]}\\n`).join(\'\');',
    '  const signedHeaders = keys.join(\';\');',
    '  const canonicalRequest = [\'POST\', \'/\', qs, canonicalHeaders, signedHeaders, bodyHash].join(\'\\n\');',
    '  const stringToSign = `ACS3-HMAC-SHA256\\n${sha256(canonicalRequest)}`;',
    '  const signature = crypto.createHmac(\'sha256\', akSecret).update(stringToSign, \'utf8\').digest(\'hex\');',
    '  const res = await fetch(`https://${host}/?${qs}`, {',
    '    method: \'POST\',',
    '    headers: {',
    '      ...headers,',
    '      Authorization: `ACS3-HMAC-SHA256 Credential=${akId},SignedHeaders=${signedHeaders},Signature=${signature}`,',
    '    },',
    '  });',
    '  const json = await res.json();',
    '  const data = typeof json.Data === \'string\' && json.Data ? JSON.parse(json.Data) : (json.Data || null);',
    '  return {',
    '    invoiceNo: params.InvoiceNo,',
    '    httpStatus: res.status,',
    '    code: json.Code || data?.code || \'\',',
    '    message: json.Message || data?.message || \'\',',
    '    invalidMark: data?.data?.invalidMark ?? data?.invalidMark ?? \'\',',
    '    cyjgxx: data?.data?.cyjgxx ?? data?.cyjgxx ?? \'\',',
    '  };',
    '}',
    '// 按批传入 ≤20 张数电票（invoiceNumber → InvoiceNo，billingDate → InvoiceDate，amount → InvoiceSum），通过 `node -` 执行：',
    '(async () => {',
    '  const batch = [{ InvoiceNo: \'<invoiceNumber>\', InvoiceDate: \'<billingDate>\', InvoiceSum: \'<amount>\' }];',
    '  for (const item of batch) console.log(JSON.stringify(await verifyInvoice(item)));',
    '})();',
    '```',
    '',
    '## 注意事项与约束',
    '',
    '- 批量时把 webcli 命令逐字写全、一行一条放进同一次工具调用；不要逐条手动发命令，也不要试图用变量、循环或子 shell 包住 webcli（会被运行时拒绝）。',
    '- 超时或中断后按台账 ID 顺序记录断点，只补跑未完成的批次；已拿到结果的行不要重发，避免成倍浪费调用。',
    '- webcli 输出用 Select-String 过滤只保留需要的字段行，避免整段 JSON 刷屏占用上下文。',
    '- 销售方名称必须取全称，禁止缩写或截断。',
    '- 企查查接口的 Bearer Token 不写入任何输出；' + (qccKey ? 'Token 已由主人在创建时提供，直接使用配方中的值即可。' : '实际调用时向主人确认。'),
    '- 腾讯云 SecretId / SecretKey 不写入任何输出；' + (hasTencent ? 'SecretId/SecretKey 已由主人在创建时提供，直接使用配方中的值即可。' : '当前未配置，仅在主人主动提供后使用。'),
    '- 阿里云 AccessKey ID / Secret 不写入任何输出；' + (hasAliyun ? 'AK/SK 已由主人在创建时提供，直接使用配方中的值即可。' : '当前未配置，仅在主人主动提供后使用。'),
    '- 连续 401 时先读响应体的 error_description 再定策略：Invalid or expired token 立即停止重试、提醒主人换 Key；Missing Authorization header 检查请求头写法；限流类提示才放慢节奏重试，不要把鉴权失败当风控硬等。',
    '- 腾讯云 / 阿里云调用报错时先按错误码分流：鉴权错误（AuthFailure.* / InvalidAccessKeyId.NotFound / SignatureDoesNotMatch）立即停止重试并提醒换 Key；未开通或欠费（UnOpenError / ArrearsError / ocrServiceNotOpen / OcrServiceExpired）立即停止并提醒开通/续费；上游省局通道超时（AlgorithmTimeout / DownStreamError / 503 / 限流）最多重试 1 次，双通道时可切换另一通道补查，否则记入待处理。',
    '- upsert 属于写操作：仅对本次外部查询成功获得状态的公司执行，且每公司一次；查询失败/超时的不回写，记入待处理。',
    '- 外部接口调用有成本，同一公司只查一次、同一发票号码只查一次；销售方先查内部库（已有「存续」等明确状态的不再外呼），发票状态直连核验。',
    '- 分页查询注意 `page` 递增直到返回条数 < limit。',
    '- 公司量与发票量可能较大，分批处理并向主人汇报进度（已查台账数/公司数/发票数）。',
    '',
    '## 回答方式',
    '',
    '- 中间过程简洁汇报（已查台账数/公司数/发票数/进度）。',
    '- 最终输出：注册状态异常销售方清单（公司全称、注册状态、涉及台账/发票）、状态异常发票清单（发票号码、开票日期、销售方、发票状态/核验结论、涉及台账，如已核验），以及查询失败/缺少核验字段的待处理清单。',
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

/** 判断是否已配置任意一家发票核验服务凭证（腾讯云或阿里云）。 */
function hasInvoiceVerifyCredentials(answers) {
  const hasTencent = Boolean(
    normalizeTencentCredential(answers?.tencentSecretId)
    && normalizeTencentCredential(answers?.tencentSecretKey),
  )
  const hasAliyun = Boolean(
    normalizeAliyunCredential(answers?.aliyunAccessKeyId)
    && normalizeAliyunCredential(answers?.aliyunAccessKeySecret),
  )
  return hasTencent || hasAliyun
}

/** 由答案构建 Agent 的描述文案。 */
export function buildTemplateDescription(template, answers) {
  if (template?.id === COSTPLUS_TEMPLATE_ID) {
    return hasInvoiceVerifyCredentials(answers)
      ? '复查 CostPlus 费控系统 2024 年至今（含2026年）的历史报销发票，输出注册状态异常的销售方及状态异常的发票清单。'
      : '复查 CostPlus 费控系统 2024 年至今（含2026年）的历史报销发票，输出注册状态异常的销售方清单。'
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
      '帮我把 2024 年以来的报销发票查一遍，有哪些销售方公司注册状态异常？**不要查发票是否作废/红冲**',
      '帮我把 2024 年以来的报销发票查一遍，有哪些销售方公司注册状态异常？**同时查发票是否作废/红冲， 每个api供应商只查询50次免费额度即可**',
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
