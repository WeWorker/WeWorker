import React, { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Checkbox, Input, Modal, Popconfirm, Space, Tabs, Tag } from 'antd'
import AppSwitch from '../common/AppSwitch.jsx'
import AppDropdownSelect from '../common/AppDropdownSelect.jsx'
import { LoadingOutlined } from '@ant-design/icons'
import SiteIcon from '../icons/SiteIcon.jsx'
import { useSitesStore } from '../../store/sites.js'
import { useDedicatedAgentsStore } from '../../store/dedicated-agents.js'
import {
  deleteAgent,
  fetchAgentDetail,
  fetchAgentSkills,
  resetAgentPairing,
  setSkillScope,
  updateAgent,
} from '../../api/dedicated-agents-api.js'
import {
  agentAccessMode,
  agentBotId,
  agentChannelOf,
  agentStatusPresentation,
  boundBotPayload,
  channelLabel,
  pairingCommand,
  parseExamples,
  SKILL_SCOPE_LABELS,
  TONE_COLORS,
} from '../../utils/dedicated-agents.js'
import WecomQrBind, { BotChannelPicker } from './WecomQrBind.jsx'
import { SkillEditorCard } from './SkillComposer.jsx'
import AgentChatPanel from './AgentChatPanel.jsx'
import AgentTaskPanel from './AgentTaskPanel.jsx'
import AgentNameEditor from './AgentNameEditor.jsx'
import { showConfirm } from '../../store/dialog.js'
import { codeBadgeStyle, fieldStyle, hintStyle, labelStyle, monoStyle, sectionStyle, sectionTitleStyle, titleStyle } from './styles.js'

const REFRESH_MS = 4000

const nameInputStyle = {
  fontSize: 16,
  fontWeight: 600,
  color: 'var(--text-primary)',
  fontFamily: 'inherit',
  padding: '2px 8px',
  border: '1px solid var(--border)',
  borderRadius: 6,
  background: 'var(--bg-primary)',
  width: 240,
  maxWidth: '100%',
}

function StatusPill({ agent }) {
  const status = agentStatusPresentation(agent)
  const color = TONE_COLORS[status.tone]
  return (
    <span title={status.detail || undefined} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color, background: `color-mix(in srgb, ${color} 14%, transparent)`, padding: '2px 10px', borderRadius: 999 }}>
      <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
      {status.label}
    </span>
  )
}

function BasicInfoCard({ agent, onSaved }) {
  const [form, setForm] = useState({ name: '', description: '', examplesText: '' })
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)
  useEffect(() => {
    setForm({ name: agent.name, description: agent.description, examplesText: (agent.examples || []).join('\n') })
    setMessage(null)
  }, [agent.id])

  const dirty = form.name !== agent.name || form.description !== agent.description || form.examplesText !== (agent.examples || []).join('\n')
  const save = async () => {
    setSaving(true)
    setMessage(null)
    try {
      const result = await updateAgent(agent.id, { name: form.name, description: form.description, examples: parseExamples(form.examplesText) })
      onSaved(result.agent)
      setMessage({ ok: true, text: '已保存' })
    } catch (err) {
      setMessage({ ok: false, text: err.message || '保存失败' })
    } finally {
      setSaving(false)
    }
  }
  return (
    <div style={sectionStyle}>
      <h3 style={sectionTitleStyle}>基本信息</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12 }}>
        <div style={fieldStyle}>
          <label style={labelStyle} htmlFor="detail-name">名称</label>
          <Input id="detail-name" value={form.name} maxLength={40} onChange={(event) => setForm((f) => ({ ...f, name: event.target.value }))} />
        </div>
        <div style={fieldStyle}>
          <label style={labelStyle} htmlFor="detail-description">一句话说明</label>
          <Input id="detail-description" value={form.description} maxLength={200} onChange={(event) => setForm((f) => ({ ...f, description: event.target.value }))} />
        </div>
      </div>
      <div style={fieldStyle}>
        <label style={labelStyle} htmlFor="detail-examples">示例问题（每行一个）</label>
        <Input.TextArea id="detail-examples" value={form.examplesText} onChange={(event) => setForm((f) => ({ ...f, examplesText: event.target.value }))} autoSize={{ minRows: 2, maxRows: 6 }} />
      </div>
      <Space>
        <Button data-app-button="action" type="primary" onClick={save} disabled={!dirty || saving || !form.name.trim()}>{saving ? '保存中…' : '保存'}</Button>
        {message && <span style={{ ...hintStyle, color: message.ok ? 'var(--success, #22c55e)' : 'var(--error, #ef4444)' }}>{message.text}</span>}
      </Space>
    </div>
  )
}

function BotCard({ agent, onChanged }) {
  const [rebindOpen, setRebindOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [rebindKey, setRebindKey] = useState(0)

  const channel = agentChannelOf(agent)
  const im = channelLabel(channel)
  const [rebindChannel, setRebindChannel] = useState(channel)
  const rebind = async (bot) => {
    setBusy(true)
    setError('')
    try {
      const result = await updateAgent(agent.id, boundBotPayload(bot))
      onChanged(result.agent)
      setRebindOpen(false)
    } catch (err) {
      setError(err.message || '更换失败')
    } finally {
      setBusy(false)
    }
  }
  const rePair = async () => {
    try {
      const result = await resetAgentPairing(agent.id)
      onChanged(result.agent)
    } catch (err) {
      setError(err.message || '操作失败')
    }
  }
  const connection = agent.connection || {}
  return (
    <div style={sectionStyle}>
      <h3 style={sectionTitleStyle}>{im}机器人</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', rowGap: 8, fontSize: 13, color: 'var(--text-primary)' }}>
        <span style={hintStyle}>{channel === 'weixin' ? '机器人 ID' : 'BotID'}</span>
        <span style={monoStyle}>{agentBotId(agent) || '—'}</span>
        <span style={hintStyle}>连接</span>
        <span>
          {connection.status === 'connected' && <span style={{ color: TONE_COLORS.success }}>已连接</span>}
          {connection.status === 'starting' && <span style={{ color: TONE_COLORS.warning }}>连接中</span>}
          {connection.status === 'stopped' && <span style={{ color: TONE_COLORS.muted }}>{agent.enabled ? '未连接' : '已停用'}</span>}
          {connection.status === 'error' && <span style={{ color: TONE_COLORS.error }}>异常：{connection.error || '未知错误'}</span>}
        </span>
        <span style={hintStyle}>主人</span>
        <span>{agent.paired ? <span style={monoStyle}>{agent.owner_user_id}</span> : <span style={{ color: TONE_COLORS.warning }}>尚未配对</span>}</span>
      </div>

      {!agent.paired && agent.pairing_code && (
        <div style={{ marginTop: 14 }}>
          <div style={{ ...hintStyle, marginBottom: 8 }}>在{im}里给这个机器人发送：</div>
          <Space wrap>
            <span style={codeBadgeStyle}>{pairingCommand(agent.pairing_code)}</span>
            <Button data-app-button="action" onClick={() => navigator.clipboard?.writeText(pairingCommand(agent.pairing_code)).catch(() => {})}>复制</Button>
          </Space>
        </div>
      )}

      {channel === 'wecom' && connection.status === 'error' && /订阅失败|stopped|disconnect/i.test(connection.error || '') && (
        <Alert type="warning" showIcon style={{ marginTop: 12 }} message="同一个机器人只能保持一个连接。如果它在别处（例如另一台电脑）也连着，这里会掉线。" />
      )}
      {channel === 'weixin' && connection.status === 'error' && /过期|重新扫码/.test(connection.error || '') && (
        <Alert type="warning" showIcon style={{ marginTop: 12 }} message="微信登录已失效（可能在别处重新扫码登录了同一个机器人）。点「更换机器人」用微信重新扫码即可恢复。" />
      )}
      {error && <Alert type="error" showIcon style={{ marginTop: 12 }} message={error} />}

      <Space style={{ marginTop: 14 }} wrap>
        <Button data-app-button="action" onClick={() => { setError(''); setRebindChannel(channel); setRebindKey((value) => value + 1); setRebindOpen(true) }}>更换机器人</Button>
        {agent.paired && (
          <Popconfirm title="重新配对？" description="当前主人将失效，需要重新发送新的绑定码。" okText="重新配对" cancelText="取消" onConfirm={rePair}>
            <Button data-app-button="action">重新配对</Button>
          </Popconfirm>
        )}
      </Space>

      <Modal title="更换机器人" open={rebindOpen} onCancel={() => !busy && setRebindOpen(false)} footer={null} destroyOnClose maskClosable={false} width={620}>
        <div style={{ ...hintStyle, marginBottom: 12 }}>可以换成企业微信或微信机器人。换成另一个机器人后需要重新配对。</div>
        <BotChannelPicker
          value={rebindChannel}
          disabled={busy}
          onChange={(next) => { setError(''); setRebindChannel(next); setRebindKey((value) => value + 1) }}
        />
        <WecomQrBind key={`${rebindChannel}-${rebindKey}`} channel={rebindChannel} onBound={rebind} busy={busy} />
        {error && <Alert type="error" showIcon style={{ marginTop: 12 }} message={error} />}
      </Modal>
    </div>
  )
}

function AccessCard({ agent, onChanged }) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const channel = agentChannelOf(agent)
  const ownerOnly = agentAccessMode(agent) === 'owner_only'

  const change = async (nextOwnerOnly) => {
    setSaving(true)
    setError('')
    try {
      const result = await updateAgent(agent.id, { access_mode: nextOwnerOnly ? 'owner_only' : 'wecom_authorized' })
      onChanged(result.agent)
    } catch (err) {
      setError(err.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={sectionStyle}>
      <h3 style={sectionTitleStyle}>访问范围</h3>
      {channel === 'wecom' ? (
        <>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-primary)' }}>
            <AppSwitch checked={ownerOnly} disabled={saving} onChange={(event) => change(event.target.checked)} aria-label="仅主人可用" />
            {saving && <LoadingOutlined />}
            仅主人可用
          </label>
          <div style={{ ...hintStyle, marginTop: 5 }}>
            {ownerOnly
              ? '开启后，即使企业微信已向其他成员授权该机器人，也只有主人可以使用。'
              : '已允许企业微信后台授权使用该机器人的成员与它对话。成员权限仍由企业微信后台管理。'}
          </div>
        </>
      ) : <div style={hintStyle}>微信机器人当前仅支持主人使用。</div>}
      {error && <Alert type="error" showIcon style={{ marginTop: 8 }} message={error} />}
    </div>
  )
}

function SkillScopeSwitch({ skill, onChanged }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!skill) return null
  const isPublic = skill.scope === 'public'
  const others = (skill.used_by || []).length
  const toggle = async (nextPublic) => {
    if (!nextPublic && !await showConfirm(`关闭后，主对话和「SKILLS与场景」将不再看到「${skill.name}」，只有专属 Agent 使用它。继续？`)) return
    setBusy(true)
    setError('')
    try {
      await setSkillScope(skill.name, nextPublic ? 'public' : 'private')
      await onChanged()
    } catch (err) {
      setError(err.message || '切换失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-primary)' }}>
        <AppSwitch checked={isPublic} disabled={busy} onChange={(event) => toggle(event.target.checked)} aria-label="也用于主对话" />
        {busy && <LoadingOutlined />}
        也用于主对话
      </label>
      <div style={{ ...hintStyle, marginTop: 4 }}>
        {isPublic
          ? '已共享：WeWorker 主对话也会使用这份知识，并在「SKILLS与场景」中显示。'
          : '默认仅专属 Agent 使用，不影响 WeWorker 主对话。'}
        {others > 1 && ` 共有 ${others} 个专属 Agent 使用这个 Skill。`}
      </div>
      {error && <Alert type="error" showIcon style={{ marginTop: 8 }} message={error} />}
    </div>
  )
}

function SkillCard({ agent, onChanged }) {
  const [skills, setSkills] = useState([])
  const [changing, setChanging] = useState(false)
  const [error, setError] = useState('')
  const loadSkills = useCallback(() => fetchAgentSkills().then(setSkills).catch(() => setSkills([])), [])
  useEffect(() => { loadSkills() }, [agent.id, loadSkills])

  const change = async (skillName) => {
    setChanging(true)
    setError('')
    try {
      const result = await updateAgent(agent.id, { skill_name: skillName || '' })
      onChanged(result.agent)
    } catch (err) {
      setError(err.message || '更换失败')
    } finally {
      setChanging(false)
    }
  }
  const current = skills.find((skill) => skill.name === agent.skill_name)
  return (
    <div style={sectionStyle}>
      <h3 style={sectionTitleStyle}>专属知识（Skill）</h3>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={hintStyle}>使用的 Skill：</span>
        <AppDropdownSelect
          value={agent.skill_name || ''}
          onChange={change}
          disabled={changing}
          minMenuWidth={300}
          options={[
            { value: '', label: '不使用（仅网站自带能力）' },
            ...skills.map((skill) => ({ value: skill.name, label: `${skill.name}（${SKILL_SCOPE_LABELS[skill.scope]}）` })),
          ]}
          ariaLabel="选择专属 Skill"
        />
        {changing && <LoadingOutlined />}
      </div>
      {error && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={error} />}
      {agent.skill_name && <SkillScopeSwitch skill={current} onChanged={loadSkills} />}
      {agent.skill_name
        ? <SkillEditorCard key={agent.skill_name} skillName={agent.skill_name} siteId={agent.site_id} />
        : <div style={hintStyle}>还没有专属 Skill。可以删除后重新用向导让 AI 生成，或选择一个已有的 Skill。</div>}
    </div>
  )
}

export default function AgentDetail({ agentId }) {
  const sites = useSitesStore((s) => s.sites)
  const loadSites = useSitesStore((s) => s.load)
  const upsertAgent = useDedicatedAgentsStore((s) => s.upsertAgent)
  const removeAgent = useDedicatedAgentsStore((s) => s.removeAgent)
  const [agent, setAgent] = useState(null)
  const [conversations, setConversations] = useState([])
  const [error, setError] = useState('')
  const [keepConversations, setKeepConversations] = useState(false)
  const [tab, setTab] = useState(null)

  const refresh = useCallback(async () => {
    try {
      const detail = await fetchAgentDetail(agentId)
      setAgent(detail.agent)
      setConversations(detail.conversations || [])
      upsertAgent(detail.agent)
      setError('')
    } catch (err) {
      setError(err.message || '加载失败')
    }
  }, [agentId, upsertAgent])

  useEffect(() => {
    setAgent(null)
    refresh()
    const timer = setInterval(refresh, REFRESH_MS)
    return () => clearInterval(timer)
  }, [refresh])

  useEffect(() => { if (!sites.length) loadSites() }, [sites.length, loadSites])

  const applyAgent = (next) => {
    setAgent((current) => ({ ...current, ...next }))
    upsertAgent(next)
  }

  if (error && !agent) return <div style={{ padding: 24 }}><Alert type="error" showIcon message={error} /></div>
  if (!agent) return <div style={{ ...hintStyle, padding: 24 }}><LoadingOutlined /> 加载中…</div>

  const site = sites.find((entry) => entry.id === agent.site_id)
  const toggleEnabled = async (enabled) => {
    try {
      const result = await updateAgent(agent.id, { enabled })
      applyAgent(result.agent)
    } catch (err) {
      setError(err.message || '操作失败')
    }
  }
  const remove = async () => {
    try {
      await deleteAgent(agent.id, { keepConversations })
      removeAgent(agent.id)
    } catch (err) {
      setError(err.message || '删除失败')
    }
  }

  const activeTab = tab ?? (agent.paired ? 'chat' : 'settings')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 24px 8px' }}>
        <SiteIcon site={site || { id: agent.site_id, name: agent.site_id }} size={32} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h2 style={titleStyle}>
              <AgentNameEditor
                agentId={agent.id}
                name={agent.name}
                onSaved={applyAgent}
                iconSize={14}
                inputStyle={nameInputStyle}
              />
            </h2>
            <StatusPill agent={agent} />
          </div>
          <div style={hintStyle}>
            <Tag style={{ marginRight: 6 }}>{site?.name || agent.site_id}</Tag>
            {agent.description}
          </div>
        </div>
        <Space>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
            <AppSwitch checked={agent.enabled} onChange={(event) => toggleEnabled(event.target.checked)} aria-label="启用专属 Agent" />
            {agent.enabled ? '已启用' : '已停用'}
          </label>
          <Popconfirm
            title={`删除「${agent.name}」？`}
            description={(
              <div style={{ maxWidth: 260 }}>
                <div style={{ marginBottom: 6 }}>机器人连接会断开，专属 Skill 会保留。</div>
                <Checkbox checked={keepConversations} onChange={(event) => setKeepConversations(event.target.checked)}>保留对话记录（移到「对话」列表）</Checkbox>
              </div>
            )}
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={remove}
          >
            <Button data-app-button="action" danger>删除</Button>
          </Popconfirm>
        </Space>
      </div>
      <div style={{ padding: '0 24px' }}>
        {error && <Alert type="error" showIcon style={{ marginBottom: 8 }} message={error} />}
        {site && !site.enabled && (
          <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={`「${site.name}」的网站能力当前未启用，Agent 会提示你先启用。`} />
        )}
        <Tabs
          activeKey={activeTab}
          onChange={setTab}
          size="small"
          style={{ marginBottom: 0 }}
          tabBarStyle={{ marginBottom: 0 }}
          items={[
            { key: 'chat', label: `对话${conversations.length ? `（${conversations.length}）` : ''}` },
            { key: 'tasks', label: '任务' },
            { key: 'settings', label: agent.paired ? '设置' : '设置（待配对）' },
          ]}
        />
      </div>
      {activeTab === 'chat' ? (
        <AgentChatPanel agent={agent} siteName={site?.name || agent.site_id} conversations={conversations} onConversationsChanged={refresh} />
      ) : activeTab === 'tasks' ? (
        <AgentTaskPanel agent={agent} />
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 24px 24px', borderTop: '1px solid var(--border)' }}>
          <div style={{ maxWidth: 860 }}>
            <BotCard agent={agent} onChanged={applyAgent} />
            <AccessCard agent={agent} onChanged={applyAgent} />
            <SkillCard agent={agent} onChanged={applyAgent} />
            <BasicInfoCard agent={agent} onSaved={applyAgent} />
          </div>
        </div>
      )}
    </div>
  )
}
