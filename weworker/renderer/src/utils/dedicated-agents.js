// Pure helpers for the WeWorker Bot page (kept free of React for node --test).

export const WIZARD_STEPS = [
  { key: 'site', title: '选网站' },
  { key: 'skill', title: '专属知识' },
  { key: 'bind', title: '绑定机器人' },
  { key: 'pair', title: '完成配对' },
]

/** IM channels a dedicated agent can be reached from. */
export const AGENT_CHANNELS = [
  { value: 'wecom', label: '企业微信', short: '企微' },
  { value: 'weixin', label: '微信', short: '微信' },
]

export const AGENT_ACCESS_MODES = {
  ownerOnly: 'owner_only',
  wecomAuthorized: 'wecom_authorized',
}

export function agentChannelOf(agent) {
  return agent?.channel === 'weixin' ? 'weixin' : 'wecom'
}

/** Shared mode delegates member access to the WeCom bot's own authorization. */
export function agentAccessMode(agent) {
  return agentChannelOf(agent) === 'wecom' && agent?.access_mode === AGENT_ACCESS_MODES.wecomAuthorized
    ? AGENT_ACCESS_MODES.wecomAuthorized
    : AGENT_ACCESS_MODES.ownerOnly
}

export function agentAccessModeLabel(agent) {
  return agentAccessMode(agent) === AGENT_ACCESS_MODES.wecomAuthorized ? '允许企业微信授权用户' : '仅主人可用'
}

export function channelLabel(channel, { short = false } = {}) {
  const entry = AGENT_CHANNELS.find((item) => item.value === channel) || AGENT_CHANNELS[0]
  return short ? entry.short : entry.label
}

/** Bot id shown in settings: WeCom BotID or the WeChat iLink bot id. */
export function agentBotId(agent) {
  return agentChannelOf(agent) === 'weixin' ? (agent?.weixin?.bot_id || '') : (agent?.wecom?.bot_id || '')
}

/** Request body for a bound bot from the QR/manual binding step. */
export function boundBotPayload(bot) {
  if (bot?.channel === 'weixin') return { channel: 'weixin', qr_session_id: bot.qr_session_id }
  return bot?.qr_session_id
    ? { channel: 'wecom', qr_session_id: bot.qr_session_id }
    : { channel: 'wecom', bot_id: bot?.bot_id, secret: bot?.secret }
}

export const SKILL_MODES = {
  generate: 'generate',
  existing: 'existing',
  none: 'none',
}

/** Status pill for an agent: combines enabled flag, pairing and the WeCom connection. */
export function agentStatusPresentation(agent) {
  if (!agent) return { label: '未知', tone: 'muted' }
  if (agent.draft) return { label: '未配置', tone: 'muted' }
  if (!agent.enabled) return { label: '已停用', tone: 'muted' }
  const status = agent.connection?.status
  if (status === 'error') {
    return { label: '连接异常', tone: 'error', detail: agent.connection?.error || '' }
  }
  if (status === 'starting' || status === 'stopped' || !status) return { label: '连接中', tone: 'warning' }
  if (!agent.paired) return { label: '待配对', tone: 'warning' }
  return { label: '在线', tone: 'success' }
}

export const TONE_COLORS = {
  success: 'var(--success, #22c55e)',
  warning: 'var(--warning, #f59e0b)',
  error: 'var(--error, #ef4444)',
  muted: 'var(--text-muted)',
}

/** Message the owner sends to the bot to pair. */
export function pairingCommand(code) {
  return code ? `绑定 ${code}` : ''
}

export function defaultAgentName(site) {
  const name = String(site?.name || '').trim()
  return name ? `${name}助手`.slice(0, 40) : ''
}

/**
 * Validate a dedicated Agent name typed into the inline editor.
 * Returns `{ ok: true, value, changed }` or `{ ok: false, error }`.
 */
export function normalizeAgentName(input, { currentName = '', maxLength = 40 } = {}) {
  const value = String(input ?? '').trim()
  if (!value) return { ok: false, error: '名称不能为空' }
  if (value.length > maxLength) return { ok: false, error: `名称最长 ${maxLength} 个字符` }
  return { ok: true, value, changed: value !== String(currentName ?? '').trim() }
}

/** Validation for the wizard step the user is on. Returns an error message or ''. */
export function validateWizardStep(stepKey, draft) {
  if (stepKey === 'site') {
    if (!draft.siteId) return '请选择要操作的网站'
    if (!String(draft.name || '').trim()) return '请给 Agent 起个名字'
    return ''
  }
  if (stepKey === 'skill') {
    if (draft.skillMode === SKILL_MODES.existing && !draft.existingSkill) return '请选择一个已有的 Skill'
    if (draft.skillMode === SKILL_MODES.generate) {
      if (!String(draft.skillMarkdown || '').trim()) return '请先生成 Skill，或改为「暂不需要」'
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(draft.skillName || '') || String(draft.skillName).startsWith('webcli')) {
        return 'Skill 名称只能包含字母、数字、点、下划线和连字符，且不能以 webcli 开头'
      }
    }
    return ''
  }
  return ''
}

/** Skill name the agent will reference after the skill step. */
export function resolveDraftSkillName(draft) {
  if (draft.skillMode === SKILL_MODES.existing) return draft.existingSkill || ''
  if (draft.skillMode === SKILL_MODES.generate) return draft.skillName || ''
  return ''
}

export function parseExamples(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6)
}

export function enabledSites(sites) {
  return (Array.isArray(sites) ? sites : [])
    .filter((site) => site && site.enabled)
    .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id), 'zh-CN'))
}

export function filterSites(sites, query) {
  const keyword = String(query || '').trim().toLowerCase()
  if (!keyword) return sites
  return sites.filter((site) => [site.id, site.name, site.description]
    .some((value) => String(value || '').toLowerCase().includes(keyword)))
}

export function compactSiteCapabilities(site, limit = 5) {
  const seen = new Set()
  const tools = Array.isArray(site?.tools) ? site.tools : []
  return tools
    .map((tool) => {
      const name = String(tool?.name || '').trim()
      const description = String(tool?.description || '').replace(/\s+/g, ' ').trim()
      return { name, description: description || '可调用的操作工具' }
    })
    .filter((tool) => {
      if (!tool.name || seen.has(tool.description.toLowerCase())) return false
      seen.add(tool.description.toLowerCase())
      return true
    })
    .slice(0, limit)
}

export function sitePurpose(site) {
  return String(site?.detailDescription || site?.description || '').replace(/\s+/g, ' ').trim()
    || `通过 Adapter 操作 ${String(site?.name || site?.id || '该网站')}。`
}

export function genericSkillGoalPlaceholder(site) {
  const name = String(site?.name || site?.id || '这个网站')
  return `例如：帮我在「${name}」中处理哪些工作？需要查什么、填写什么、遵循什么规则？`
}

export const GENERIC_KNOWLEDGE_PLACEHOLDER = `可选：补充你熟悉但 Agent 不知道的业务知识，例如：
- 业务术语、常用对象或分类含义
- 团队约定、处理规则、判断条件和例外
- 常用筛选条件、输出格式、回复口径
- 常见问题的排查或处理步骤
- 哪些操作不能做、需要先确认什么

不要填写密码、Token、Cookie、个人账号或真实敏感数据。`

export function supportedSkillImportPath(filePath) {
  return /\.(md|zip)$/i.test(String(filePath || '').trim())
}

export function skillImportLabel(filePath) {
  const value = String(filePath || '').replace(/\\/g, '/')
  const name = value.split('/').pop() || ''
  return name || 'Skill 文件'
}

export function isAgentChannelKey(key) {
  return String(key || '').startsWith('agent:')
}

/** Count dedicated agent bots in the backend channel status map. */
export function summarizeAgentChannels(channels) {
  const summary = { total: 0, connected: 0, errors: 0 }
  for (const [key, info] of Object.entries(channels || {})) {
    if (!isAgentChannelKey(key)) continue
    summary.total += 1
    if (info?.status === 'connected') summary.connected += 1
    if (info?.status === 'error') summary.errors += 1
  }
  return summary
}

export const SKILL_SCOPE_LABELS = {
  private: '仅WeWorker Bot',
  public: '也用于主对话',
}

/**
 * Conversations started from WeCom are titled 「（Agent 名）问题」; show the
 * question and mark where it came from.
 */
export function conversationPresentation(conversation, agentName) {
  const title = String(conversation?.title || '').trim()
  const prefix = agentName ? `（${agentName}）` : ''
  if (prefix && title.startsWith(prefix)) {
    return { title: title.slice(prefix.length).trim() || '新对话', source: 'wecom' }
  }
  const generic = title.match(/^（[^）]{1,40}）(.*)$/)
  if (generic) return { title: generic[1].trim() || '新对话', source: 'wecom' }
  return { title: title || '新对话', source: 'desktop' }
}

export function formatRelativeTime(iso, now = Date.now()) {
  const time = Date.parse(iso || '')
  if (!Number.isFinite(time)) return ''
  const diff = Math.max(0, now - time)
  const minute = 60_000
  if (diff < minute) return '刚刚'
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`
  const date = new Date(time)
  return `${date.getMonth() + 1}月${date.getDate()}日`
}
