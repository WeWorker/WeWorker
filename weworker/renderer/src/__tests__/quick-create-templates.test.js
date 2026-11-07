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
  TEMPLATE_QUESTIONS,
  validateTemplateAnswers,
  validateTemplateQuestion,
} from '../components/dedicated-agents/quick-create/templates.js'

const template = findTemplate('apikey-usage-helper')
const baseAnswers = { ...template.defaultAnswers, members: 'alice, bob\ncarol', name: '团队 Key 管家' }

test('the built-in apikey template is registered against the aiep site', () => {
  assert.equal(BUILT_IN_TEMPLATES.length, 1)
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
  assert.deepEqual(TEMPLATE_QUESTIONS.map((question) => question.id), ['name', 'members', 'dailyHour', 'monitor'])
  for (const question of TEMPLATE_QUESTIONS) {
    assert.ok(question.emoji, `${question.id} has an emoji`)
    assert.ok(question.title, `${question.id} has a title`)
    assert.ok(question.subtitle, `${question.id} has a subtitle`)
  }
  assert.ok(TEMPLATE_QUESTIONS[2].hours.includes(9), 'daily hour chips include the 9:00 default')
  assert.ok(TEMPLATE_QUESTIONS[3].intervals.includes(2), 'monitor interval chips include the 2h default')
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
