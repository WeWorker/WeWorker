import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SKILL_MODES,
  agentAccessMode,
  agentAccessModeLabel,
  AGENT_ACCESS_MODES,
  agentBotId,
  agentChannelOf,
  agentSiteIds,
  agentSkillNames,
  boundBotPayload,
  channelLabel,
  agentStatusPresentation,
  compactSiteCapabilities,
  conversationPresentation,
  defaultAgentName,
  enabledSites,
  filterSites,
  formatRelativeTime,
  isAgentChannelKey,
  isPristineDraft,
  listableAgents,
  normalizeAgentName,
  pairingCommand,
  parseExamples,
  resolveDraftSkillName,
  sitePurpose,
  skillImportLabel,
  summarizeAgentChannels,
  supportedSkillImportPath,
  validateWizardStep,
} from '../utils/dedicated-agents.js'

const site = {
  id: 'example.com',
  name: 'Example',
  description: 'Example inventory site',
  enabled: true,
  tools: [
    { name: 'example.com.search', description: 'Search  products' },
    { name: 'example.com.search_v2', description: 'Search products' },
    { name: 'example.com.list_orders', description: '' },
    { name: '', description: 'nameless' },
    { name: 'example.com.stock', description: 'Check stock' },
  ],
}

test('agent status combines enabled flag, connection and pairing', () => {
  assert.equal(agentStatusPresentation(null).label, '未知')
  assert.deepEqual(agentStatusPresentation({ draft: true, paired: false }), { label: '配置中', tone: 'muted' })
  assert.deepEqual(agentStatusPresentation({ draft: true, paired: true }), { label: '配置中', tone: 'muted' })
  assert.equal(agentStatusPresentation({ enabled: false }).label, '已停用')
  assert.deepEqual(agentStatusPresentation({ enabled: true, connection: { status: 'error', error: 'subscribe failed' } }), { label: '连接异常', tone: 'error', detail: 'subscribe failed' })
  assert.equal(agentStatusPresentation({ enabled: true, connection: { status: 'starting' } }).label, '连接中')
  assert.equal(agentStatusPresentation({ enabled: true, paired: false, connection: { status: 'connected' } }).label, '待配对')
  assert.equal(agentStatusPresentation({ enabled: true, paired: true, connection: { status: 'connected' } }).label, '企微在线')
  assert.equal(agentStatusPresentation({ enabled: true, channel: 'weixin', paired: true, connection: { status: 'connected' } }).label, '微信在线')
})

test('wizard validation allows plain agents and follows the selected skill mode', () => {
  assert.equal(validateWizardStep('scope', { siteIds: [], workDir: '', name: 'Plain Claude' }), '')
  assert.equal(validateWizardStep('scope', { siteIds: [], workDir: 'C:/weworker-fixtures/workspace', name: ' ' }), '请给 Agent 起个名字')
  assert.equal(validateWizardStep('scope', { siteIds: ['example.com'], name: 'Example Operations Assistant' }), '')
  assert.match(validateWizardStep('skill', { skillMode: SKILL_MODES.existing }), /已有的 Skill/)
  assert.match(validateWizardStep('skill', { skillMode: SKILL_MODES.generate, skillMarkdown: '' }), /先生成 Skill/)
  assert.match(validateWizardStep('skill', { skillMode: SKILL_MODES.generate, skillMarkdown: 'x', skillName: 'webcli-x' }), /webcli/)
  assert.equal(validateWizardStep('skill', { skillMode: SKILL_MODES.generate, skillMarkdown: 'x', skillName: 'inventory-helper' }), '')
  assert.equal(validateWizardStep('skill', { skillMode: SKILL_MODES.none }), '')
  assert.equal(resolveDraftSkillName({ skillMode: SKILL_MODES.existing, existingSkill: 'staging-helper' }), 'staging-helper')
  assert.equal(resolveDraftSkillName({ skillMode: SKILL_MODES.generate, skillName: 'inventory-helper' }), 'inventory-helper')
  assert.equal(resolveDraftSkillName({ skillMode: SKILL_MODES.none, skillName: 'ignored' }), '')
})

test('agents expose multi-site and multi-skill fields with legacy fallback', () => {
  assert.deepEqual(agentSiteIds({ site_ids: ['example.com', 'example.org'] }), ['example.com', 'example.org'])
  assert.deepEqual(agentSiteIds({ site_ids: [] }), [])
  assert.deepEqual(agentSiteIds({ site_id: 'example.com' }), ['example.com'])
  assert.deepEqual(agentSiteIds({}), [])
  assert.deepEqual(agentSkillNames({ skill_names: ['inventory-helper', 'orders-helper'] }), ['inventory-helper', 'orders-helper'])
  assert.deepEqual(agentSkillNames({ skill_name: 'inventory-helper' }), ['inventory-helper'])
  assert.deepEqual(agentSkillNames({}), [])
})

test('site helpers summarize purpose and 3-5 core capabilities', () => {
  assert.equal(sitePurpose(site), 'Example inventory site')
  assert.equal(sitePurpose({ id: 'example.org' }), '通过 Adapter 操作 example.org。')
  const capabilities = compactSiteCapabilities(site)
  assert.deepEqual(capabilities.map((tool) => tool.name), ['example.com.search', 'example.com.list_orders', 'example.com.stock'])
  assert.equal(capabilities[1].description, '可调用的操作工具')
  assert.equal(compactSiteCapabilities({ tools: Array.from({ length: 9 }, (_, index) => ({ name: `t${index}`, description: `d${index}` })) }).length, 5)
  assert.equal(defaultAgentName(site), 'Example助手')
  assert.equal(defaultAgentName([site, { id: 'example.org', name: 'Org' }]), 'Example助手')
  assert.equal(defaultAgentName({}), '')
})

test('site list filtering keeps enabled sites sorted and searchable', () => {
  const sites = [site, { id: 'example.org', name: 'Alpha', enabled: true }, { id: 'orders.example.com', name: 'Orders', enabled: false }]
  assert.deepEqual(enabledSites(sites).map((entry) => entry.id), ['example.org', 'example.com'])
  assert.deepEqual(filterSites(sites, 'ORDERS').map((entry) => entry.id), ['orders.example.com'])
  assert.equal(filterSites(sites, '').length, 3)
})

test('examples, pairing and import helpers', () => {
  assert.deepEqual(parseExamples(' a \n\n b\r\nc\nd\ne\nf\ng'), ['a', 'b', 'c', 'd', 'e', 'f'])
  assert.equal(pairingCommand('123456'), '绑定 123456')
  assert.equal(pairingCommand(''), '')
  assert.equal(supportedSkillImportPath('C:/weworker-fixtures/user-files/skill.ZIP'), true)
  assert.equal(supportedSkillImportPath('C:/weworker-fixtures/user-files/skill.txt'), false)
  assert.equal(skillImportLabel('C:\\weworker-fixtures\\user-files\\inventory-helper.md'), 'inventory-helper.md')
})

test('agent channel statuses are summarized separately from main channels', () => {
  assert.equal(isAgentChannelKey('agent:abc'), true)
  assert.equal(isAgentChannelKey('wecom'), false)
  assert.deepEqual(summarizeAgentChannels({
    wecom: { status: 'connected' },
    'agent:a': { status: 'connected' },
    'agent:b': { status: 'error' },
    'agent:c': { status: 'starting' },
  }), { total: 3, connected: 1, errors: 1 })
})

test('conversation titles show where they came from', () => {
  assert.deepEqual(conversationPresentation({ title: '（Example Operations Assistant）Check stock' }, 'Example Operations Assistant'), { title: 'Check stock', source: 'wecom' })
  assert.deepEqual(conversationPresentation({ title: '（Old name）Check stock' }, 'New name'), { title: 'Check stock', source: 'wecom' })
  assert.deepEqual(conversationPresentation({ title: '' }, 'A'), { title: '新对话', source: 'desktop' })
  const now = Date.parse('2026-01-02T00:00:00.000Z')
  assert.equal(formatRelativeTime('2026-01-01T23:59:30.000Z', now), '刚刚')
  assert.equal(formatRelativeTime('2026-01-01T23:30:00.000Z', now), '30 分钟前')
  assert.equal(formatRelativeTime('2026-01-01T20:00:00.000Z', now), '4 小时前')
  assert.equal(formatRelativeTime('invalid', now), '')
})

test('agents can be served by WeCom or WeChat bots', () => {
  assert.equal(agentChannelOf({}), 'wecom')
  assert.equal(agentChannelOf({ channel: 'weixin' }), 'weixin')
  assert.equal(channelLabel('weixin'), '微信')
  assert.equal(channelLabel('wecom', { short: true }), '企微')
  assert.equal(channelLabel('unknown'), '企业微信')
  assert.equal(agentBotId({ channel: 'weixin', weixin: { bot_id: 'fixture@im.bot' }, wecom: { bot_id: '' } }), 'fixture@im.bot')
  assert.equal(agentBotId({ wecom: { bot_id: 'placeholder-bot' } }), 'placeholder-bot')
  assert.deepEqual(boundBotPayload({ channel: 'weixin', qr_session_id: 's1', bot_id: 'x' }), { channel: 'weixin', qr_session_id: 's1' })
  assert.deepEqual(boundBotPayload({ channel: 'wecom', qr_session_id: 's2' }), { channel: 'wecom', qr_session_id: 's2' })
  assert.deepEqual(boundBotPayload({ channel: 'wecom', bot_id: 'placeholder-bot', secret: 'placeholder-secret' }), { channel: 'wecom', bot_id: 'placeholder-bot', secret: 'placeholder-secret' })
})

test('WeCom sharing access is opt-in and unavailable to WeChat agents', () => {
  assert.equal(agentAccessMode({}), AGENT_ACCESS_MODES.ownerOnly)
  assert.equal(agentAccessModeLabel({}), '仅主人可用')
  assert.equal(agentAccessMode({ channel: 'wecom', access_mode: 'wecom_authorized' }), AGENT_ACCESS_MODES.wecomAuthorized)
  assert.equal(agentAccessModeLabel({ channel: 'wecom', access_mode: 'wecom_authorized' }), '允许企业微信授权用户')
  assert.equal(agentAccessMode({ channel: 'weixin', access_mode: 'wecom_authorized' }), AGENT_ACCESS_MODES.ownerOnly)
})

test('inline agent rename trims the new name and reports whether it changed', () => {
  assert.deepEqual(normalizeAgentName('  163 邮箱助手  '), { ok: true, value: '163 邮箱助手', changed: true })
  assert.deepEqual(normalizeAgentName('163 邮箱助手', { currentName: '163 邮箱助手' }), { ok: true, value: '163 邮箱助手', changed: false })
  assert.deepEqual(normalizeAgentName('163 邮箱助手', { currentName: ' 163 邮箱助手 ' }), { ok: true, value: '163 邮箱助手', changed: false })
  assert.deepEqual(normalizeAgentName('   '), { ok: false, error: '名称不能为空' })
  assert.deepEqual(normalizeAgentName(null), { ok: false, error: '名称不能为空' })
  assert.deepEqual(normalizeAgentName('x'.repeat(41), { maxLength: 40 }), { ok: false, error: '名称最长 40 个字符' })
  assert.equal(normalizeAgentName('x'.repeat(40), { maxLength: 40 }).ok, true)
})
test('desktop channel renders without an IM bot', () => {
  const agent = { channel: 'desktop', enabled: true, connection: { status: 'stopped' } }
  assert.equal(agentChannelOf(agent), 'desktop')
  assert.equal(channelLabel('desktop'), '桌面端')
  assert.equal(channelLabel('desktop', { short: true }), '桌面端')
  assert.equal(agentBotId(agent), '')
  assert.equal(agentAccessMode(agent), 'owner_only')
  assert.deepEqual(agentStatusPresentation(agent), { label: '桌面端', tone: 'success' })
})

test('pristine auto-drafts stay out of the sidebar list until they have progress', () => {
  const pristine = { id: 'draft-1', draft: true, name: '新建WeWorker Bot', siteIds: [], wizardStep: 0 }
  assert.equal(isPristineDraft(pristine), true)
  assert.equal(isPristineDraft({ ...pristine, createMode: 'template', templateId: 'invoice-self-check-helper' }), false)
  assert.equal(isPristineDraft({ ...pristine, createMode: 'custom' }), false)
  assert.equal(isPristineDraft({ ...pristine, siteIds: ['example.com'] }), false)
  assert.equal(isPristineDraft({ ...pristine, skillMarkdown: '# skill' }), false)
  assert.equal(isPristineDraft({ ...pristine, wizardStep: 2 }), false)
  assert.equal(isPristineDraft({ id: 'agent-1', name: 'Real' }), false, 'real agents are never pristine drafts')
  assert.deepEqual(listableAgents([pristine, { id: 'agent-1', name: 'Real' }]), [{ id: 'agent-1', name: 'Real' }])
  assert.deepEqual(listableAgents(undefined), [])
})
