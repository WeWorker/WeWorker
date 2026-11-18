import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BUILT_IN_TEMPLATES,
  buildDailyCron,
  buildMonitoringCron,
  buildTemplateDescription,
  buildTemplateExamples,
  buildTemplateTasks,
  describeCron,
  findTemplate,
  parseMembers,
  questionAnswerText,
  renderTemplateSkill,
  templateQuestions,
  validateTemplateAnswers,
  validateTemplateQuestion,
} from '../components/dedicated-agents/quick-create/templates.js'

const template = findTemplate('apikey-usage-helper')
const baseAnswers = { ...template.defaultAnswers, members: 'alice, bob\ncarol', name: '团队 Key 管家' }

test('the built-in apikey template is registered against the aiep site', () => {
  assert.equal(BUILT_IN_TEMPLATES.length, 2)
  assert.equal(template.siteId, 'aiep.weoa.com')
  assert.match(template.skillName, /^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  assert.equal(template.defaultAnswers.dailyHour, 9)
  assert.equal(template.defaultAnswers.monitorEnabled, true)
})

test('parseMembers splits on mixed separators, strips @ and dedupes case-insensitively', () => {
  assert.deepEqual(parseMembers('alice, BOB\ncarol；alice @dave'), ['alice', 'BOB', 'carol', 'dave'])
  assert.deepEqual(parseMembers('  '), [])
  assert.deepEqual(parseMembers(undefined), [])
})

test('validateTemplateAnswers requires members and a valid name', () => {
  assert.equal(validateTemplateAnswers(template, baseAnswers), '')
  assert.match(validateTemplateAnswers(template, { ...baseAnswers, members: '' }), /团队成员/)
  assert.match(validateTemplateAnswers(template, { ...baseAnswers, members: '张三' }), /英文名/)
  assert.match(validateTemplateAnswers(template, { ...baseAnswers, name: '' }), /名字/)
  assert.match(validateTemplateAnswers(template, { ...baseAnswers, monitorInterval: 24 }), /间隔/)
})

test('cron builders render the expected expressions', () => {
  assert.equal(buildDailyCron(9), '0 9 * * *')
  assert.equal(buildMonitoringCron(9, 21, 2), '0 9-21/2 * * *')
  assert.equal(buildMonitoringCron(21, 9, 2), '0 9-21/2 * * *')
  assert.equal(buildMonitoringCron(9, 9, 2), '0 9 * * *')
})

test('renderTemplateSkill fills in members, schedule and monitoring rules', () => {
  const markdown = renderTemplateSkill(template, baseAnswers)
  assert.match(markdown, /^---\nname: apikey-usage-helper\n/)
  assert.ok(markdown.includes('alice、bob、carol'))
  assert.ok(markdown.includes('每天 9:00 推送团队 API Key 用量日报'))
  assert.ok(markdown.includes('每天 9:00–21:00 每 2 小时检查一次'))
  assert.ok(markdown.includes('60%、70%、80%、90%'))
  assert.ok(markdown.includes('apikey-usage-list'))
  assert.ok(markdown.includes('apikey-detail'))
  assert.ok(markdown.includes('codeplan'))
  assert.ok(markdown.includes('腾讯云 MaaS 和火山 CodingPlan'))
  assert.ok(markdown.includes('把主人加为其 API Key 的关注人'))

  const disabled = renderTemplateSkill(template, { ...baseAnswers, monitorEnabled: false })
  assert.ok(disabled.includes('主人未开启定时额度监控任务'))
  assert.ok(!disabled.includes('每 2 小时检查一次'))
})

test('buildTemplateTasks creates the daily report and optional monitoring task', () => {
  const tasks = buildTemplateTasks(template, baseAnswers)
  assert.deepEqual(tasks.map((task) => task.key), ['daily', 'monitor'])
  assert.equal(tasks[0].cron_expression, '0 9 * * *')
  assert.equal(tasks[1].cron_expression, '0 9-21/2 * * *')
  assert.ok(tasks.every((task) => task.prompt_template.includes('send_agent_message')))
  assert.ok(tasks[0].prompt_template.includes('alice、bob、carol'))

  const noMonitor = buildTemplateTasks(template, { ...baseAnswers, monitorEnabled: false, dailyHour: 8 })
  assert.deepEqual(noMonitor.map((task) => task.key), ['daily'])
  assert.equal(noMonitor[0].cron_expression, '0 8 * * *')
})

test('describeCron renders human-readable summaries', () => {
  assert.equal(describeCron('0 9 * * *'), '每天 9:00')
  assert.equal(describeCron('0 9-21/2 * * *'), '每天 9:00–21:00 每 2 小时')
  assert.equal(describeCron('weird'), 'weird')
})

test('description and examples reflect the answers', () => {
  assert.equal(buildTemplateDescription(template, baseAnswers), '每天 9 点推送团队 codeplan API Key 用量；每天 9–21 点每 2 小时监控额度告警。')
  const examples = buildTemplateExamples(template, baseAnswers)
  assert.ok(examples[0].includes('codeplan'))
  assert.ok(examples.includes('alice 的 key 额度还剩多少？'))
  assert.ok(buildTemplateExamples(template, { ...baseAnswers, members: '' }).length >= 2)
})

test('renderTemplateSkill falls back to defaults for partial answers', () => {
  const markdown = renderTemplateSkill(template, null)
  assert.ok(markdown.includes('（待补充）'))
  assert.ok(markdown.includes('每天 9:00 推送团队 API Key 用量日报'))
})

test('template questions render one screen per question with auto-advance options', () => {
  const questions = templateQuestions(template)
  assert.deepEqual(questions.map((question) => question.id), ['name', 'members', 'dailyHour', 'monitor'])
  for (const question of questions) {
    assert.ok(question.emoji, `${question.id} has an emoji`)
    assert.ok(question.title, `${question.id} has a title`)
    assert.ok(question.subtitle, `${question.id} has a subtitle`)
  }
  assert.ok(questions[2].hours.includes(9), 'daily hour chips include the 9:00 default')
  assert.ok(questions[3].intervals.includes(2), 'monitor interval chips include the 2h default')
})

test('validateTemplateQuestion checks one question at a time', () => {
  const answers = { ...template.defaultAnswers, name: '', members: '' }
  assert.match(validateTemplateQuestion(template, 'name', answers), /名字/)
  assert.match(validateTemplateQuestion(template, 'members', answers), /团队成员/)
  assert.equal(validateTemplateQuestion(template, 'dailyHour', { ...answers, dailyHour: 9 }), '')
  assert.equal(validateTemplateQuestion(template, 'monitor', { ...answers, monitorEnabled: false }), '')
  assert.match(validateTemplateQuestion(template, 'monitor', { ...answers, monitorInterval: 24 }), /间隔/)
})

test('questionAnswerText renders answer summary rows', () => {
  assert.equal(questionAnswerText('name', baseAnswers), '团队 Key 管家')
  assert.equal(questionAnswerText('members', baseAnswers), 'alice、bob、carol')
  assert.equal(questionAnswerText('dailyHour', baseAnswers), '每天 09:00')
  assert.equal(questionAnswerText('monitor', baseAnswers), '开！每天 09:00–21:00 每 2 小时查一次')
  assert.equal(questionAnswerText('monitor', { ...baseAnswers, monitorEnabled: false }), '不用了，先不开')
})

test('the costplus template is registered with its own questions and no scheduled tasks', () => {
  const costplus = findTemplate('invoice-self-check-helper')
  assert.ok(costplus, 'costplus template is registered')
  assert.equal(costplus.name, '发票自查助手')
  assert.equal(costplus.defaultAnswers.name, '发票自查助手')
  assert.equal(costplus.siteId, 'costplus.weoa.com')
  assert.match(costplus.skillName, /^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  const questions = templateQuestions(costplus)
  assert.deepEqual(questions.map((question) => question.id), ['name', 'qccApiKey'])
  assert.equal(questions[1].optional, true, 'the API key question is skippable')
  assert.ok(questions[1].subtitle.includes('agent.qcc.com/profile/api-key'), 'tells the user where to get the key')
  assert.deepEqual(buildTemplateTasks(costplus, costplus.defaultAnswers), [])
})

test('costplus validation requires a name and treats the API key as optional', () => {
  const costplus = findTemplate('invoice-self-check-helper')
  const answers = { ...costplus.defaultAnswers }
  assert.equal(validateTemplateAnswers(costplus, answers), '')
  assert.match(validateTemplateAnswers(costplus, { ...answers, name: '' }), /名字/)
  assert.equal(validateTemplateQuestion(costplus, 'qccApiKey', { qccApiKey: '' }), '', 'empty key passes')
  assert.match(validateTemplateQuestion(costplus, 'qccApiKey', { qccApiKey: 'x'.repeat(600) }), /过长/)
  assert.equal(questionAnswerText('qccApiKey', answers), '稍后在对话里提供')
  assert.equal(questionAnswerText('qccApiKey', { qccApiKey: 'qcc-test-key' }), '已提供，将写入专属知识')
})

test('costplus skill renders the fixed review window, data chain and safety rules', () => {
  const costplus = findTemplate('invoice-self-check-helper')
  const markdown = renderTemplateSkill(costplus, costplus.defaultAnswers)
  assert.match(markdown, /^---\nname: invoice-self-check-helper\n/)
  assert.ok(markdown.includes('2024-01-01 至今（含2026年）'))
  for (const command of ['list-subsidy-ledgers', 'get-subsidy-ledger', 'list-subsidy-invoices']) {
    assert.ok(markdown.includes(`costplus.weoa.com.${command}`), `${command} recipe present`)
  }
  assert.ok(markdown.includes('--ledger-id='), 'exact id lookup documented')
  assert.ok(markdown.includes('--to-date'), 'range end parameter documented')
  assert.ok(markdown.includes('foreach'), 'batch loop recipes documented')
  assert.ok(markdown.includes('批量执行原则'), 'batching principle stated')
  assert.ok(!markdown.includes('BT1090012026110271'), 'no concrete ledger numbers from examples')
  assert.ok(!markdown.includes('2261887'), 'no concrete invoice ids from examples')
  assert.ok(markdown.includes('http://weworker.weoa.com/cost/check'))
  assert.ok(markdown.includes('http://weworker.weoa.com/cost/upsert'))
  assert.ok(markdown.includes('get_company_registration_info'))
  assert.ok(markdown.includes('向主人确认'))
  assert.ok(markdown.includes('注册状态异常'))
  assert.ok(!markdown.includes('updateUser'), 'upsert no longer carries updateUser')
  assert.ok(!markdown.includes('allowed-tools'), 'no tool allowlist: PowerShell recipes must stay callable')
})

test('costplus skill embeds the API key when provided and keeps ask-at-runtime otherwise', () => {
  const costplus = findTemplate('invoice-self-check-helper')
  const withoutKey = renderTemplateSkill(costplus, costplus.defaultAnswers)
  assert.ok(withoutKey.includes('Bearer <向主人确认>'), 'recipe falls back to asking the owner')
  assert.ok(withoutKey.includes('https://agent.qcc.com/profile/api-key'), 'points to the key page when missing')
  assert.ok(withoutKey.includes('- 企查查外部查询的 Bearer Token（API Key）。'), 'listed as a runtime confirmation item')

  const withKey = renderTemplateSkill(costplus, { ...costplus.defaultAnswers, qccApiKey: 'qcc-test-key-123' })
  assert.ok(withKey.includes("Authorization = 'Bearer qcc-test-key-123'"), 'recipe embeds the provided key')
  assert.ok(withKey.includes('Token 已内置'))
  assert.ok(!withKey.includes('Bearer <向主人确认>'))
  assert.ok(!withKey.includes('- 企查查外部查询的 Bearer Token（API Key）。'), 'not asked again at runtime')
})

test('costplus description and examples use the fixed review window', () => {
  const costplus = findTemplate('invoice-self-check-helper')
  assert.equal(
    buildTemplateDescription(costplus, {}),
    '复查 CostPlus 费控系统 2024 年至今（含2026年）的历史报销发票，输出注册状态异常的销售方清单。',
  )
  const examples = buildTemplateExamples(costplus, {})
  assert.ok(examples[0].includes('2024 年以来的报销发票'))
  assert.ok(examples.some((example) => example.includes('注册状态异常')))
})
