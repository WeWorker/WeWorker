// BotHub 蓝图测试：从仓库根 bothub/ 磁盘加载蓝图（与运行时 Vite glob 同源），
// 经 blueprint-engine 渲染后对照断言与基线快照（fixtures/bothub-parity，重构前旧实现产物）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildDailyCron,
  buildMonitoringCron,
  buildTemplateDescription,
  buildTemplateExamples,
  buildTemplateSiteIds,
  buildTemplateTasks,
  compileSkillMarkdown,
  describeCron,
  findTemplateIn,
  isQuestionEmpty,
  normalizeAliyunCredential,
  normalizeBlueprint,
  normalizeQccKey,
  normalizeTencentCredential,
  parseMembers,
  questionAnswerText,
  renderTemplateSkill,
  templateQuestions,
  validateTemplateAnswers,
  validateTemplateQuestion,
  visibleTemplateQuestions,
} from '../components/dedicated-agents/quick-create/blueprint-engine.js'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const BOTHUB_DIR = path.join(REPO_ROOT, 'bothub')
const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'bothub-parity')

/** 与运行时加载器（templates.js）同构：blueprint.json + skill.md + intro.md 组装成蓝图。 */
function loadPackage(id) {
  const read = (file) => fs.readFileSync(path.join(BOTHUB_DIR, id, file), 'utf8')
  const blueprint = JSON.parse(read('blueprint.json'))
  return normalizeBlueprint({
    ...blueprint,
    skill: compileSkillMarkdown(read('skill.md')),
    introMarkdown: fs.existsSync(path.join(BOTHUB_DIR, id, 'intro.md')) ? read('intro.md') : '',
  })
}

const index = JSON.parse(fs.readFileSync(path.join(BOTHUB_DIR, 'index.json'), 'utf8'))
const BUILT_IN_TEMPLATES = index.order.map((id) => loadPackage(id))
const findTemplate = (id) => findTemplateIn(BUILT_IN_TEMPLATES, id)

const template = findTemplate('apikey-usage-helper')
const baseAnswers = { ...template.defaultAnswers, members: 'alice, bob\ncarol', name: '团队 Key 管家' }

test('bothub folder registers the three built-in blueprints in index order', () => {
  assert.equal(BUILT_IN_TEMPLATES.length, 3)
  assert.deepEqual(BUILT_IN_TEMPLATES.map((entry) => entry.id), [
    'fannisi-reimburse-helper',
    'invoice-self-check-helper',
    'apikey-usage-helper',
  ])
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
  assert.equal(questionAnswerText(template, 'name', baseAnswers), '团队 Key 管家')
  assert.equal(questionAnswerText(template, 'members', baseAnswers), 'alice、bob、carol')
  assert.equal(questionAnswerText(template, 'dailyHour', baseAnswers), '每天 09:00')
  assert.equal(questionAnswerText(template, 'monitor', baseAnswers), '开！每天 09:00–21:00 每 2 小时查一次')
  assert.equal(questionAnswerText(template, 'monitor', { ...baseAnswers, monitorEnabled: false }), '不用了，先不开')
})

test('the costplus template is registered with its own questions and no scheduled tasks', () => {
  const costplus = findTemplate('invoice-self-check-helper')
  assert.ok(costplus, 'costplus template is registered')
  assert.equal(costplus.name, '发票自查助手')
  assert.equal(costplus.defaultAnswers.name, '发票自查助手')
  assert.equal(costplus.siteId, 'costplus.weoa.com')
  assert.match(costplus.skillName, /^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  const questions = templateQuestions(costplus)
  assert.deepEqual(
    questions.map((question) => question.id),
    ['name', 'qccApiKey', 'tencentAuth', 'tencentServiceEnable', 'aliyunAuth', 'aliyunServiceEnable'],
  )
  assert.notEqual(questions[1].optional, true, 'the API key question is required')
  assert.ok(questions[1].subtitle.includes('[[https://agent.qcc.com/profile/api-key]]'), 'subtitle carries a clickable link token')
  assert.ok(!questions[1].subtitle.includes('之后在对话里提供'), 'no skip wording left')
  assert.equal(questions[2].type, 'credentials')
  assert.equal(questions[2].optional, true, 'the tencent credentials question is optional')
  assert.deepEqual(questions[2].fields.map((field) => field.answerKey), ['tencentSecretId', 'tencentSecretKey'])
  assert.equal(questions[2].fields[1].secret, true, 'SecretKey uses masked input')
  assert.ok(questions[2].subtitle.includes('[[https://console.cloud.tencent.com/cam/capi]]'), 'tencent subtitle carries CAM CAPI link')
  assert.ok(questions[2].subtitle.includes('暂不需要可直接跳过，仅复查销售方注册状态。'), 'tencent subtitle keeps skip explanation')
  assert.ok(questions[2].note.includes('仅保存在客户端本地'), 'tencent step reminds user credentials stay local')
  assert.equal(questions[3].type, 'guide')
  assert.equal(questions[3].actionUrl, 'https://cloud.tencent.com/product/vtiv')
  assert.ok(questions[3].subtitle.includes('开通后您可享 50 次免费额度'), 'tencent guide mentions 50 free calls')
  assert.ok(questions[3].warning.includes('千万不要有余额'), 'tencent guide warns about balance after free quota')
  assert.equal(questions[4].type, 'credentials')
  assert.equal(questions[4].optional, true, 'the aliyun credentials question is optional')
  assert.deepEqual(questions[4].fields.map((field) => field.answerKey), ['aliyunAccessKeyId', 'aliyunAccessKeySecret'])
  assert.equal(questions[4].fields[1].secret, true, 'AccessKey Secret uses masked input')
  assert.ok(questions[4].subtitle.includes('[[https://ram.console.aliyun.com/manage/ak]]'), 'aliyun subtitle carries RAM AK link')
  assert.ok(questions[4].note.includes('仅保存在客户端本地'), 'aliyun step reminds user credentials stay local')
  assert.equal(questions[5].type, 'guide')
  assert.ok(questions[5].actionUrl.includes('commodityCode=ocr_cardverification_public_cn'), 'guide step carries the Aliyun service enable URL')
  assert.ok(questions[5].subtitle.includes('开通后您可享 50 次免费额度'), 'aliyun guide mentions 50 free calls')
  assert.ok(questions[5].warning.includes('千万不要有余额'), 'aliyun guide warns about balance after free quota')
  // 未填写对应凭证时自动隐藏开通引导步；填写后出现在对应 AK/SK 的下一步。
  assert.deepEqual(
    visibleTemplateQuestions(costplus, costplus.defaultAnswers).map((q) => q.id),
    ['name', 'qccApiKey', 'tencentAuth', 'aliyunAuth'],
  )
  assert.deepEqual(
    visibleTemplateQuestions(costplus, {
      ...costplus.defaultAnswers,
      tencentSecretId: 'TEST_TC_ID_PLACEHOLDER',
      tencentSecretKey: 'TEST_TC_KEY_PLACEHOLDER',
    }).map((q) => q.id),
    ['name', 'qccApiKey', 'tencentAuth', 'tencentServiceEnable', 'aliyunAuth'],
  )
  assert.deepEqual(
    visibleTemplateQuestions(costplus, {
      ...costplus.defaultAnswers,
      aliyunAccessKeyId: 'TEST_AK_ID_PLACEHOLDER',
      aliyunAccessKeySecret: 'TEST_AK_SECRET_PLACEHOLDER',
    }).map((q) => q.id),
    ['name', 'qccApiKey', 'tencentAuth', 'aliyunAuth', 'aliyunServiceEnable'],
  )
  assert.equal(questionAnswerText(costplus, 'tencentServiceEnable', costplus.defaultAnswers), '已确认开通发票核验服务')
  assert.equal(questionAnswerText(costplus, 'aliyunServiceEnable', costplus.defaultAnswers), '已确认开通票证核验服务')
  assert.deepEqual(buildTemplateTasks(costplus, costplus.defaultAnswers), [])
})

test('costplus validation requires a name and qcc key, and validates optional aliyun credentials as a pair', () => {
  const costplus = findTemplate('invoice-self-check-helper')
  const aliyunQuestion = templateQuestions(costplus).find((q) => q.id === 'aliyunAuth')
  const answers = { ...costplus.defaultAnswers, qccApiKey: 'qcc-test-key' }
  assert.equal(validateTemplateAnswers(costplus, answers), '')
  assert.match(validateTemplateAnswers(costplus, { ...answers, name: '' }), /名字/)
  assert.match(validateTemplateAnswers(costplus, { ...costplus.defaultAnswers }), /API Key/)
  assert.match(validateTemplateQuestion(costplus, 'qccApiKey', { qccApiKey: '' }), /请先填写/)
  assert.match(validateTemplateQuestion(costplus, 'qccApiKey', { qccApiKey: 'x'.repeat(600) }), /过长/)
  assert.equal(questionAnswerText(costplus, 'qccApiKey', answers), '已提供，将写入专属知识')

  // 腾讯云凭证：全空允许跳过，半填报错，成对填写通过，摘要不回显原文。
  const tencentQuestion = templateQuestions(costplus).find((q) => q.id === 'tencentAuth')
  assert.equal(isQuestionEmpty(tencentQuestion, answers), true)
  assert.equal(validateTemplateQuestion(costplus, 'tencentAuth', answers), '')
  assert.equal(questionAnswerText(costplus, 'tencentAuth', answers), '未配置，已跳过')

  const onlyTencentId = { ...answers, tencentSecretId: 'TEST_TC_ID_PLACEHOLDER' }
  assert.equal(isQuestionEmpty(tencentQuestion, onlyTencentId), false)
  assert.match(validateTemplateQuestion(costplus, 'tencentAuth', onlyTencentId), /SecretKey/)

  const onlyTencentKey = { ...answers, tencentSecretKey: 'TEST_TC_KEY_PLACEHOLDER' }
  assert.equal(isQuestionEmpty(tencentQuestion, onlyTencentKey), false)
  assert.match(validateTemplateQuestion(costplus, 'tencentAuth', onlyTencentKey), /SecretId/)

  const withTencent = {
    ...answers,
    tencentSecretId: '  TEST_TC_ID_PLACEHOLDER  ',
    tencentSecretKey: '  TEST_TC_KEY_PLACEHOLDER  ',
  }
  assert.equal(normalizeTencentCredential('  TEST_TC_ID_PLACEHOLDER  '), 'TEST_TC_ID_PLACEHOLDER')
  assert.equal(validateTemplateAnswers(costplus, withTencent), '')
  assert.equal(questionAnswerText(costplus, 'tencentAuth', withTencent), '已提供，将写入专属知识')
  assert.ok(!questionAnswerText(costplus, 'tencentAuth', withTencent).includes('TEST_TC_KEY_PLACEHOLDER'))

  // 阿里云凭证：全空允许跳过，半填报错，成对填写通过，摘要不回显原文。
  assert.equal(isQuestionEmpty(aliyunQuestion, answers), true)
  assert.equal(validateTemplateQuestion(costplus, 'aliyunAuth', answers), '')
  assert.equal(questionAnswerText(costplus, 'aliyunAuth', answers), '未配置，仅复查销售方状态')

  const onlyId = { ...answers, aliyunAccessKeyId: 'TEST_AK_ID_PLACEHOLDER' }
  assert.equal(isQuestionEmpty(aliyunQuestion, onlyId), false)
  assert.match(validateTemplateQuestion(costplus, 'aliyunAuth', onlyId), /AccessKey Secret/)

  const onlySecret = { ...answers, aliyunAccessKeySecret: 'TEST_AK_SECRET_PLACEHOLDER' }
  assert.equal(isQuestionEmpty(aliyunQuestion, onlySecret), false)
  assert.match(validateTemplateQuestion(costplus, 'aliyunAuth', onlySecret), /AccessKey ID/)

  assert.match(
    validateTemplateQuestion(costplus, 'aliyunAuth', {
      ...answers,
      aliyunAccessKeyId: 'a'.repeat(129),
      aliyunAccessKeySecret: 'TEST_AK_SECRET_PLACEHOLDER',
    }),
    /AccessKey ID 过长/,
  )
  assert.match(
    validateTemplateQuestion(costplus, 'aliyunAuth', {
      ...answers,
      aliyunAccessKeyId: 'TEST_AK_ID_PLACEHOLDER',
      aliyunAccessKeySecret: 's'.repeat(257),
    }),
    /AccessKey Secret 过长/,
  )

  const withAliyun = {
    ...answers,
    aliyunAccessKeyId: '  TEST_AK_ID_PLACEHOLDER  ',
    aliyunAccessKeySecret: '  TEST_AK_SECRET_PLACEHOLDER  ',
  }
  assert.equal(normalizeAliyunCredential('  TEST_AK_ID_PLACEHOLDER  '), 'TEST_AK_ID_PLACEHOLDER')
  assert.equal(validateTemplateAnswers(costplus, withAliyun), '')
  assert.equal(questionAnswerText(costplus, 'aliyunAuth', withAliyun), '已提供，将写入专属知识')
  assert.ok(!questionAnswerText(costplus, 'aliyunAuth', withAliyun).includes('TEST_AK_SECRET_PLACEHOLDER'))
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
  assert.ok(markdown.includes('独立命令行'), 'standalone-command constraint documented')
  assert.ok(markdown.includes('批量执行原则'), 'batching principle stated')
  assert.ok(!markdown.includes('foreach ($i in $ids)'), 'webcli must not be wrapped in loops')
  assert.ok(!/--ledger-id=\$i/.test(markdown), 'webcli arguments must be literal, not variables')
  assert.ok(markdown.includes('6–8 行'), 'explicit batch size guidance')
  assert.ok(markdown.includes('timeout: 600000'), 'tool timeout parameter advised')
  assert.ok(markdown.includes('^\\s+"\\d'), 'ledger filter keeps pure-number invoiceIds lines')
  assert.ok(!markdown.includes('Pattern \'"id"|"invoiceIds"\''), 'the broken two-term ledger filter is gone')
  assert.ok(markdown.includes('断点'), 'resume from breakpoint after timeouts')
  assert.ok(markdown.includes('不带过滤'), 'first unfiltered probe to confirm field names')
  assert.ok(markdown.includes('≤20'), 'company queries batched by 20')
  assert.ok(markdown.includes('台账 → 发票 → 销售方'), 'invoice id kept for backtracking')
  assert.ok(markdown.includes('invalid_token'), '401 diagnosis guidance present')
  assert.ok(markdown.includes('error_description'), 'diagnosis keyed on error_description, not the shared error field')
  assert.ok(markdown.includes('Invalid or expired token'), 'expired-token branch documented')
  assert.ok(markdown.includes('Missing Authorization header'), 'missing-header branch documented')
  assert.ok(markdown.includes('重新生成 API Key'), 'owner is told to regenerate the token')
  assert.ok(markdown.includes('更换企查查 Key'), 'token replacement path via update_agent_skill documented')
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

test('costplus skill renders the tab-separated problem list format with the paste hint', () => {
  const costplus = findTemplate('invoice-self-check-helper')
  const markdown = renderTemplateSkill(costplus, costplus.defaultAnswers)
  const headerLine = markdown.split('\n').find((line) => line.startsWith('发票号码\t'))
  assert.ok(headerLine, 'tab-separated header row present')
  assert.equal(headerLine.split('\t').length, 31, 'the header has exactly 31 columns')
  assert.ok(headerLine.endsWith('涉及月份\t企查查状态'), 'column order ends with month and qcc status')
  const exampleRow = markdown.split('\n').find((line) => line.startsWith('25462000000003977123\t'))
  assert.ok(exampleRow, 'placeholder example row present')
  assert.equal(exampleRow.split('\t').length, 31, 'the example row has exactly 31 columns')
  assert.ok(markdown.includes('每行字段数必须与表头完全一致'), 'rows must match the header column count')
  assert.ok(markdown.includes('企查查状态=该行销售方的注册状态查询结论'), 'qcc status column source documented')
  assert.ok(markdown.includes('制表符（Tab 字符）'), 'rows must be tab-separated, not space-aligned')
  assert.ok(markdown.includes('不要写「无」「-」'), 'empty cells stay empty')
  assert.ok(markdown.includes('doc.weixin.qq.com/sheet/'), 'paste hint links the company sheet')
  assert.ok(markdown.includes('分列（不要选智能分列）'), 'Excel split-column hint present')
  assert.ok(markdown.includes('只勾选「Tab 键」'), 'split wizard only checks Tab')
  // 2026-11 起识别号不再从发票 PDF 补查（--include-tax-no 已移除）：
  // 销方识别号来自内部库打包串/企查查，购方识别号用固定值，取不到一律「待补充」。
  assert.ok(!markdown.includes('include-tax-no'), 'no include-tax-no backfill step')
  assert.ok(!markdown.includes('sellerTaxNo') && !markdown.includes('purchaserTaxNo'), 'tax ids no longer come from invoice details')
  assert.ok(markdown.includes('"purchaser"|"amount"|"tax"'), 'invoice filter keeps purchaser and tax fields')
  assert.ok(markdown.includes('"ledgerNo"|"employee"|"department"|"applyDate"'), 'ledger filter keeps ledger-level columns')
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

  // 企查查页面复制的 Key 常带 Bearer 前缀：归一化后拼接，不会出现 Bearer Bearer。
  assert.equal(normalizeQccKey('Bearer abc.def-123'), 'abc.def-123')
  assert.equal(normalizeQccKey('bearer   abc'), 'abc')
  assert.equal(normalizeQccKey('  abc  '), 'abc')
  assert.equal(normalizeQccKey(undefined), '')
  const prefixed = renderTemplateSkill(costplus, { ...costplus.defaultAnswers, qccApiKey: 'Bearer qcc-test-key-123' })
  assert.ok(prefixed.includes("Authorization = 'Bearer qcc-test-key-123'"), 'a pasted Bearer prefix is not doubled')
  assert.ok(!prefixed.includes('Bearer Bearer'))
})

test('costplus skill embeds aliyun VerifyVATInvoice Node.js recipe and handles optional credentials', () => {
  const costplus = findTemplate('invoice-self-check-helper')
  const withoutAliyun = renderTemplateSkill(costplus, { ...costplus.defaultAnswers, qccApiKey: 'qcc-test-key-123' })
  assert.ok(withoutAliyun.includes('VerifyVATInvoice'))
  assert.ok(withoutAliyun.includes('ocr-api.cn-hangzhou.aliyuncs.com'))
  assert.ok(withoutAliyun.includes('ACS3-HMAC-SHA256'))
  assert.ok(withoutAliyun.includes('const akId = "<向主人确认>";'))
  assert.ok(withoutAliyun.includes('const akSecret = "<向主人确认>";'))
  assert.ok(withoutAliyun.includes('默认跳过'))
  assert.ok(withoutAliyun.includes('invalidMark'))
  assert.ok(withoutAliyun.includes('InvalidAccessKeyId.NotFound'))
  assert.ok(withoutAliyun.includes('ocrServiceNotOpen'))
  assert.ok(withoutAliyun.includes('commodityCode=ocr_cardverification_public_cn'))
  assert.ok(withoutAliyun.includes('ServiceUnavailable'))
  assert.ok(withoutAliyun.includes('更换阿里云 Key'))

  const withAliyun = renderTemplateSkill(costplus, {
    ...costplus.defaultAnswers,
    qccApiKey: 'qcc-test-key-123',
    aliyunAccessKeyId: '  TEST_AK_ID_PLACEHOLDER  ',
    aliyunAccessKeySecret: '  TEST_AK_SECRET_PLACEHOLDER  ',
  })
  assert.ok(withAliyun.includes('const akId = "TEST_AK_ID_PLACEHOLDER";'))
  assert.ok(withAliyun.includes('const akSecret = "TEST_AK_SECRET_PLACEHOLDER";'))
  assert.ok(withAliyun.includes('AK/SK 已内置'))
  assert.ok(!withAliyun.includes('const akId = "<向主人确认>";'))
  assert.ok(withAliyun.includes('"invoiceNumber"|"invoiceType"|"billingDate"'), 'Select-String keeps billingDate and invoiceNumber')
  assert.ok(withAliyun.includes('InvoiceSum: \'<amount>\''), 'batch example passes InvoiceSum for e-invoices')
  assert.ok(withAliyun.includes('非20位数电票'), 'non-20-digit invoices are skipped before calling Aliyun')

  // 提取全部 Node.js 内联脚本（腾讯云 + 阿里云），确认语法均合法。
  const blocks = [...withAliyun.matchAll(/```js\n([\s\S]*?)\n```/g)]
  assert.equal(blocks.length, 2, 'both Tencent and Aliyun Node.js code blocks are rendered')
  for (const [, code] of blocks) {
    assert.doesNotThrow(() => new Function(code), 'rendered Node.js recipe has valid syntax')
  }

  // 腾讯云凭证单独配置与双通道互补配置。
  const withTencent = renderTemplateSkill(costplus, {
    ...costplus.defaultAnswers,
    qccApiKey: 'qcc-test-key-123',
    tencentSecretId: '  TEST_TC_ID_PLACEHOLDER  ',
    tencentSecretKey: '  TEST_TC_KEY_PLACEHOLDER  ',
  })
  assert.ok(withTencent.includes('VatInvoiceVerifyNew'))
  assert.ok(withTencent.includes('ocr.tencentcloudapi.com'))
  assert.ok(withTencent.includes('TC3-HMAC-SHA256'))
  assert.ok(withTencent.includes('const secretId = "TEST_TC_ID_PLACEHOLDER";'))
  assert.ok(withTencent.includes('const secretKey = "TEST_TC_KEY_PLACEHOLDER";'))
  assert.ok(withTencent.includes('SecretId/SecretKey 已内置'))
  assert.ok(withTencent.includes('StateCode'))
  assert.ok(withTencent.includes('Amount: \'<amount>\''), 'batch example passes Amount (the real VatInvoiceVerifyNew field)')
  assert.ok(withTencent.includes('{ Amount: String(input.Amount).trim() }'), 'payload maps amount to Amount')
  assert.ok(!withTencent.includes('input.Additional'), 'the unknown Additional parameter is gone from the payload')
  assert.ok(withTencent.includes('UnknownParameter'), 'the skill warns why Additional must not be sent')
  assert.ok(withTencent.includes('ResourcePackageRunOut'), 'resource package exhaustion is a stop-and-renew error')
  assert.ok(withTencent.includes('AlgorithmTimeout'))
  assert.ok(withTencent.includes('更换腾讯云 Key'))

  const withBoth = renderTemplateSkill(costplus, {
    ...costplus.defaultAnswers,
    qccApiKey: 'qcc-test-key-123',
    tencentSecretId: 'TEST_TC_ID_PLACEHOLDER',
    tencentSecretKey: 'TEST_TC_KEY_PLACEHOLDER',
    aliyunAccessKeyId: 'TEST_AK_ID_PLACEHOLDER',
    aliyunAccessKeySecret: 'TEST_AK_SECRET_PLACEHOLDER',
  })
  assert.ok(withBoth.includes('双通道'), 'both Tencent and Aliyun enabled describes dual-channel fallback')
})

test('fannisi template registers with the weoa site and toggles the 163 mailbox capability', () => {
  const fannisi = findTemplate('fannisi-reimburse-helper')
  assert.ok(fannisi, 'fannisi template is registered')
  assert.equal(fannisi.name, '范妮思助手')
  assert.equal(fannisi.defaultAnswers.name, '范妮思助手')
  assert.equal(fannisi.siteId, 'weoa.webank.com')
  assert.match(fannisi.skillName, /^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  assert.deepEqual(
    templateQuestions(fannisi).map((question) => question.id),
    ['name', 'use163'],
  )
  const use163Question = templateQuestions(fannisi)[1]
  assert.equal(use163Question.type, 'choice')
  assert.deepEqual(use163Question.options.map((option) => option.value), [true, false])
  assert.equal(fannisi.defaultAnswers.use163, true)

  // 介绍页：三个内置模板都带 intro.md（markdown 形态）。
  assert.ok(fannisi.introMarkdown, 'fannisi carries an intro.md')
  assert.ok(fannisi.introMarkdown.includes('# 报销发票，随手丢给它'))
  assert.ok(fannisi.introMarkdown.includes('|'))
  assert.ok(fannisi.introCta)
  const costplus = findTemplate('invoice-self-check-helper')
  assert.ok(costplus.introMarkdown, 'costplus carries an intro.md')
  assert.ok(costplus.introMarkdown.includes('开票机构异常经营'), 'the notice focus item is listed')
  assert.ok(costplus.introMarkdown.includes('作废/红冲'), 'voided/red-flush item is listed')
  assert.ok(costplus.introMarkdown.includes('6 类情形') && costplus.introMarkdown.includes('2024'), 'notice scope stated')
  const apikey = findTemplate('apikey-usage-helper')
  assert.ok(apikey.introMarkdown, 'apikey carries an intro.md')
  assert.ok(apikey.introMarkdown.includes('60 / 70 / 80 / 90%'), 'alert thresholds stated')
  assert.ok(apikey.introMarkdown.includes('关注人'), 'the follower prerequisite is disclosed up front')
  for (const entry of BUILT_IN_TEMPLATES) assert.ok(entry.introMarkdown, `${entry.id} has an intro.md`)

  // 校验走通用 choice 分支：默认答案有效，非法值报「请选择」。
  const answers = { ...fannisi.defaultAnswers }
  assert.equal(validateTemplateAnswers(fannisi, answers), '')
  assert.match(validateTemplateQuestion(fannisi, 'use163', { ...answers, use163: '也许' }), /请选择/)
  assert.equal(questionAnswerText(fannisi, 'use163', answers), '163 邮箱，自动搜索下载')
  assert.equal(questionAnswerText(fannisi, 'use163', { ...answers, use163: false }), '不用 163，直接提供发票文件')

  // 163 开关驱动站点绑定：开=范妮思+163 邮箱，关=仅范妮思；其他模板保持单站点。
  assert.deepEqual(buildTemplateSiteIds(fannisi, answers), ['weoa.webank.com', 'mail.163.com'])
  assert.deepEqual(buildTemplateSiteIds(fannisi, { ...answers, use163: false }), ['weoa.webank.com'])
  assert.deepEqual(buildTemplateSiteIds(findTemplate('apikey-usage-helper'), answers), ['aiep.weoa.com'])
  assert.deepEqual(buildTemplateSiteIds(null, answers), [])

  // Skill 正文原文嵌入（frontmatter name 换成模板技能名），按答案追加能力状态。
  const enabled = renderTemplateSkill(fannisi, answers)
  assert.match(enabled, /^---\nname: fannisi-reimburse-helper\n/)
  assert.ok(enabled.includes('# 范妮思月度报销助手'))
  assert.ok(enabled.includes('upload-allowance-invoices'), 'skill body embedded')
  assert.ok(enabled.includes('webcli call weoa.webank.com.submit'), 'submit recipe embedded')
  assert.ok(enabled.includes('餐饮：680 元'), 'allowance amounts embedded')
  assert.ok(enabled.includes('当天开具的发票次日起才能查验'), 'same-day invoice check rule documented')
  assert.ok(enabled.includes('## 163 邮箱能力状态'))
  assert.ok(enabled.includes('已启用：发票可从主人的 163 邮箱'))
  const disabled = renderTemplateSkill(fannisi, { ...answers, use163: false })
  assert.ok(disabled.includes('未启用：主人不使用 163 邮箱'))
  assert.ok(disabled.includes('不要尝试从邮箱搜索或下载发票'))
  assert.ok(!disabled.includes('已启用：'))
  assert.ok(disabled.includes('# 范妮思月度报销助手'), 'skill body unchanged by the toggle')

  // 无定时任务；描述与示例问题反映 163 开关。
  assert.deepEqual(buildTemplateTasks(fannisi, answers), [])
  assert.equal(
    buildTemplateDescription(fannisi, answers),
    '处理范妮思月度补贴报销：从163邮箱自动搜索下载发票、上传卡包核验、绑定月度补贴并提交报销。',
  )
  assert.ok(buildTemplateDescription(fannisi, { ...answers, use163: false }).includes('发票由主人直接提供'))
  const examples = buildTemplateExamples(fannisi, answers)
  assert.ok(examples.some((example) => example.includes('163邮箱')))
  assert.ok(buildTemplateExamples(fannisi, { ...answers, use163: false }).every((example) => !example.includes('163邮箱')))
})

test('costplus description and examples use the fixed review window', () => {
  const costplus = findTemplate('invoice-self-check-helper')
  assert.equal(
    buildTemplateDescription(costplus, {}),
    '复查 CostPlus 费控系统 2024 年至今（含2026年）的历史报销发票，输出注册状态异常的销售方清单。',
  )
  assert.equal(
    buildTemplateDescription(costplus, {
      tencentSecretId: 'TEST_TC_ID_PLACEHOLDER',
      tencentSecretKey: 'TEST_TC_KEY_PLACEHOLDER',
    }),
    '复查 CostPlus 费控系统 2024 年至今（含2026年）的历史报销发票，输出注册状态异常的销售方及状态异常的发票清单。',
  )
  assert.equal(
    buildTemplateDescription(costplus, {
      aliyunAccessKeyId: 'TEST_AK_ID_PLACEHOLDER',
      aliyunAccessKeySecret: 'TEST_AK_SECRET_PLACEHOLDER',
    }),
    '复查 CostPlus 费控系统 2024 年至今（含2026年）的历史报销发票，输出注册状态异常的销售方及状态异常的发票清单。',
  )
  const expectedExamples = [
    '帮我把 2024 年以来的报销发票查一遍，有哪些销售方公司注册状态异常？不要查发票是否作废/红冲',
    '帮我把 2024 年以来的报销发票查一遍，有哪些销售方公司注册状态异常？同时查发票是否作废/红冲， 每个api供应商只查询50次免费额度即可',
  ]
  assert.deepEqual(buildTemplateExamples(costplus, {}), expectedExamples)
  assert.deepEqual(
    buildTemplateExamples(costplus, {
      tencentSecretId: 'TEST_TC_ID_PLACEHOLDER',
      tencentSecretKey: 'TEST_TC_KEY_PLACEHOLDER',
    }),
    expectedExamples,
  )
  assert.deepEqual(
    buildTemplateExamples(costplus, {
      aliyunAccessKeyId: 'TEST_AK_ID_PLACEHOLDER',
      aliyunAccessKeySecret: 'TEST_AK_SECRET_PLACEHOLDER',
    }),
    expectedExamples,
  )
})

/* ── 引擎 DSL 单元测试 ────────────────────────────────────── */

test('engine evaluates conditions, vars and conditional lines', async () => {
  const { evalCondition, renderLines, normalizeBlueprint } = await import('../components/dedicated-agents/quick-create/blueprint-engine.js')
  const blueprint = normalizeBlueprint({
    schema_version: 1,
    id: 'dsl-check', version: '0.0.1', emoji: '🧪', name: 'DSL', tagline: 't',
    site: { id: 'example.com', label: 'Example' }, skillName: 'dsl-check', defaultName: 'DSL',
    defaultAnswers: { use: true, key: ' Bearer abc ' },
    vars: {
      cleanKey: { 'from': 'key', 'trim': true, 'stripBearer': true, 'max': 2 },
      recipe: { 'var': 'cleanKey', 'fallback': '<待确认>' },
      flag: { 'bool': { 'allAnswers': ['use'] } },
      note: { 'if': { 'var': 'flag' }, 'then': 'on {{recipe}}', 'else': 'off' },
    },
    skill: ['{{skillName}}|{{recipe}}|{{note}}', { 'when': { 'answer': 'use', 'is': false }, 'lines': ['hidden'] }, { 'lines': ['always'] }],
  })
  const ctx = { template: blueprint, answers: { ...blueprint.defaultAnswers }, vars: { skillName: blueprint.skillName } }
  assert.ok(evalCondition({ allAnswers: ['use'] }, ctx))
  assert.ok(!evalCondition({ not: { allAnswers: ['use'] } }, ctx))
  assert.ok(evalCondition({ and: [{ answer: 'use', is: true }, { or: [{ answer: 'nope' }] }] }, { ...ctx, answers: { ...ctx.answers, nope: 1 } }))
  const lines = renderLines(blueprint.skill, ctx)
  assert.deepEqual(lines, ['dsl-check|ab|on ab', 'always'])
  // max 截断 + fallback：key 清洗后为 abc，截到 2 位 = ab；空 key 时 fallback。
  const ctxEmpty = { template: blueprint, answers: { ...blueprint.defaultAnswers, key: '' }, vars: { skillName: blueprint.skillName } }
  assert.deepEqual(renderLines(blueprint.skill, ctxEmpty), ['dsl-check|<待确认>|on <待确认>', 'always'])
})

test('blueprint loader rejects invalid blueprints and keeps valid ones', async () => {
  const { loadBlueprints } = await import('../components/dedicated-agents/quick-create/blueprint-engine.js')
  const good = {
    schema_version: 1, id: 'good-bot', version: '1.0.0', emoji: '🤖', name: 'Good', tagline: 't',
    site: { id: 'example.com' }, questions: [],
  }
  const bad = { schema_version: 1, id: 'bad bot!', version: '1.0', questions: [] }
  const { templates, errors } = loadBlueprints([good, bad])
  assert.equal(templates.length, 1)
  assert.equal(templates[0].id, 'good-bot')
  assert.equal(templates[0].skillName, 'good-bot', 'skillName derives from id')
  assert.equal(templates[0].defaultName, 'Good', 'defaultName derives from name')
  assert.equal(errors.length, 1)
  assert.match(errors[0], /bad bot!/)
})

test('compileSkillMarkdown turns if/elif/else directives into mutually exclusive blocks', async () => {
  const { parseConditionExpression, evalCondition } = await import('../components/dedicated-agents/quick-create/blueprint-engine.js')
  const ctx = (vars) => ({ template: {}, answers: {}, vars })
  // 表达式解析：! && || 与括号。
  assert.deepEqual(parseConditionExpression('a && !b'), { and: [{ var: 'a' }, { not: { var: 'b' } }] })
  assert.ok(evalCondition(parseConditionExpression('a && (b || !c)'), ctx({ a: true, b: false, c: false })))
  assert.throws(() => parseConditionExpression('a &&'), /无法解析|多余/)

  const compiled = compileSkillMarkdown([
    'static {{var}}',
    '<!-- if: tencent && aliyun -->',
    'both',
    '<!-- elif: tencent -->',
    'tencent',
    '<!-- else -->',
    'none',
    '<!-- endif -->',
    '<!-- if: nested -->',
    'outer',
    '<!-- if: inner -->',
    'inner',
    '<!-- endif -->',
    '<!-- endif -->',
  ].join('\n'))
  assert.equal(compiled[0], 'static {{var}}')
  // 四选一块：互斥条件自动生成。
  assert.deepEqual(compiled[1].when, { and: [{ var: 'tencent' }, { var: 'aliyun' }] })
  assert.deepEqual(
    compiled[2].when,
    { and: [{ not: { and: [{ var: 'tencent' }, { var: 'aliyun' }] } }, { var: 'tencent' }] },
    'elif negates earlier branches',
  )
  assert.deepEqual(
    compiled[3].when,
    { and: [{ not: { and: [{ var: 'tencent' }, { var: 'aliyun' }] } }, { not: { var: 'tencent' } }] },
    'else negates the whole if/elif chain',
  )
  // 嵌套块。
  assert.deepEqual(compiled[4].when, { var: 'nested' })
  assert.deepEqual(compiled[4].lines[1].when, { var: 'inner' })
  // 未闭合 if 报错。
  assert.throws(() => compileSkillMarkdown('<!-- if: a -->\nx'), /未闭合/)
})

/* ── 与旧实现的产物基线全量对比（fixtures/bothub-parity） ──── */

test('blueprint rendering matches the pre-refactor baseline for every fixture combo', () => {
  const combos = {
    'fannisi-default': ['fannisi-reimburse-helper', (tpl) => tpl.defaultAnswers],
    'fannisi-no163': ['fannisi-reimburse-helper', (tpl) => ({ ...tpl.defaultAnswers, use163: false })],
    'costplus-default': ['invoice-self-check-helper', (tpl) => tpl.defaultAnswers],
    'costplus-qcc': ['invoice-self-check-helper', (tpl) => ({ ...tpl.defaultAnswers, qccApiKey: 'qcc-test-key-123' })],
    'costplus-qcc-tencent': ['invoice-self-check-helper', (tpl) => ({ ...tpl.defaultAnswers, qccApiKey: 'Bearer qcc-test-key-123', tencentSecretId: '  TC_ID  ', tencentSecretKey: 'TC_KEY' })],
    'costplus-qcc-aliyun': ['invoice-self-check-helper', (tpl) => ({ ...tpl.defaultAnswers, qccApiKey: 'qcc-test-key-123', aliyunAccessKeyId: 'AK_ID', aliyunAccessKeySecret: ' AK_SECRET ' })],
    'costplus-both': ['invoice-self-check-helper', (tpl) => ({ ...tpl.defaultAnswers, qccApiKey: 'qcc-test-key-123', tencentSecretId: 'TC_ID', tencentSecretKey: 'TC_KEY', aliyunAccessKeyId: 'AK_ID', aliyunAccessKeySecret: 'AK_SECRET' })],
    'apikey-default': ['apikey-usage-helper', (tpl) => ({ ...tpl.defaultAnswers, members: 'alice, bob\ncarol', name: '团队 Key 管家' })],
    'apikey-nomonitor': ['apikey-usage-helper', (tpl) => ({ ...tpl.defaultAnswers, members: '张三', monitorEnabled: false, dailyHour: 8 })],
  }
  for (const [name, [id, buildAnswers]] of Object.entries(combos)) {
    const template = findTemplate(id)
    assert.ok(template, `${name}: blueprint ${id} registered`)
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, `${name}.json`), 'utf8'))
    const answers = buildAnswers(template)
    const actual = {
      skill: renderTemplateSkill(template, answers),
      description: buildTemplateDescription(template, answers),
      examples: buildTemplateExamples(template, answers),
      tasks: buildTemplateTasks(template, answers),
      siteIds: buildTemplateSiteIds(template, answers),
      summaries: Object.fromEntries(template.questions.map((q) => [q.id, questionAnswerText(template, q.id, answers)])),
      visibleQuestions: visibleTemplateQuestions(template, answers).map((q) => q.id),
    }
    for (const field of Object.keys(fixture)) {
      assert.deepEqual(
        actual[field],
        fixture[field],
        `${name}.${field} 与重构前基线不一致`,
      )
    }
  }
})
