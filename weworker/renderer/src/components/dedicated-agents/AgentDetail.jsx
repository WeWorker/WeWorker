import React, { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Checkbox, Input, Modal, Popconfirm, Space, Tabs, Tag } from 'antd'
import AppSwitch from '../common/AppSwitch.jsx'
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
  agentSiteIds,
  agentSkillNames,
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
  fontSize: 'var(--font-size-body)',
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
  const rebindModal = (
    <Modal title="绑定机器人" open={rebindOpen} onCancel={() => !busy && setRebindOpen(false)} footer={null} destroyOnClose maskClosable={false} width={620}>
      <div style={{ ...hintStyle, marginBottom: 12 }}>可以绑定企业微信或微信机器人。绑定后需要在{channelLabel(rebindChannel)}里重新配对。</div>
      <BotChannelPicker
        value={rebindChannel}
        disabled={busy}
        onChange={(next) => { setError(''); setRebindChannel(next); setRebindKey((value) => value + 1) }}
      />
      <WecomQrBind key={`${rebindChannel}-${rebindKey}`} channel={rebindChannel} onBound={rebind} busy={busy} />
      {error && <Alert type="error" showIcon style={{ marginTop: 12 }} message={error} />}
    </Modal>
  )
  if (channel === 'desktop') {
    return (
      <div style={sectionStyle}>
        <h3 style={sectionTitleStyle}>机器人（未绑定）</h3>
        <div style={hintStyle}>
          这个 Bot 还没有绑定机器人，当前在 WeWorker 桌面端使用；绑定企业微信或微信机器人后，就可以在手机上和它对话。
        </div>
        <Space style={{ marginTop: 14 }}>
          <Button data-app-button="action" onClick={() => { setError(''); setRebindChannel('wecom'); setRebindKey((value) => value + 1); setRebindOpen(true) }}>绑定机器人</Button>
        </Space>
        {rebindModal}
      </div>
    )
  }
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

      {rebindModal}
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
      ) : <div style={hintStyle}>{channel === 'desktop' ? '绑定机器人后可以在这里设置访问范围。' : '微信机器人当前仅支持主人使用。'}</div>}
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
    if (!nextPublic && !await showConfirm(`关闭后，主对话和「公共 Skill」将不再看到「${skill.name}」，只有WeWorker Bot 使用它。继续？`)) return
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
          ? '已共享：WeWorker 主对话也会使用这份知识，并在「公共 Skill」中显示。'
          : '默认仅WeWorker Bot 使用，不影响 WeWorker 主对话。'}
        {others > 1 && ` 共有 ${others} 个WeWorker Bot 使用这个 Skill。`}
      </div>
      {error && <Alert type="error" showIcon style={{ marginTop: 8 }} message={error} />}
    </div>
  )
}

function CapabilityCard({ agent, sites, onChanged }) {
  const boundIds = agentSiteIds(agent)
  const [selected, setSelected] = useState(boundIds)
  const [workDir, setWorkDir] = useState(agent.work_dir || '')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)
  useEffect(() => {
    setSelected(agentSiteIds(agent))
    setWorkDir(agent.work_dir || '')
    setMessage(null)
  }, [agent.id])

  const dirty = JSON.stringify(selected) !== JSON.stringify(boundIds) || workDir !== (agent.work_dir || '')
  const toggle = (id) => {
    setSelected((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]))
  }
  const pickDirectory = async () => {
    const selectDirectory = window.electronAPI?.selectDirectory
    if (!selectDirectory) return
    try {
      const paths = await selectDirectory()
      if (paths?.[0]) setWorkDir(String(paths[0]))
    } catch {
      // Keep the current value when the dialog fails or is cancelled.
    }
  }
  const save = async () => {
    setSaving(true)
    setMessage(null)
    try {
      const result = await updateAgent(agent.id, { site_ids: selected, work_dir: workDir.trim() })
      onChanged(result.agent)
      setMessage({ ok: true, text: '已保存，下一条消息起生效' })
    } catch (err) {
      setMessage({ ok: false, text: err.message || '保存失败' })
    } finally {
      setSaving(false)
    }
  }
  return (
    <div style={sectionStyle}>
      <h3 style={sectionTitleStyle}>能力范围</h3>
      <div style={{ ...hintStyle, marginBottom: 10 }}>它可以操作哪些网站，以及在哪个本地目录里工作。网站和目录都可以不选。</div>
      <div style={{ display: 'grid', gap: 6, marginBottom: 14 }}>
        {sites.length ? sites.map((site) => (
          <label key={site.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-primary)', flexWrap: 'wrap' }}>
            <Checkbox checked={selected.includes(site.id)} onChange={() => toggle(site.id)} disabled={saving}>
              {site.name || site.id}
            </Checkbox>
            {site.enabled === false && <Tag color="warning" bordered={false} style={{ fontSize: 10, lineHeight: '16px', padding: '0 5px', marginInlineEnd: 0 }}>未启用</Tag>}
            <span style={hintStyle}>{site.id}</span>
          </label>
        )) : <div style={hintStyle}>还没有可用的网站。先在「设置 → 站点」中启用对应网站。</div>}
      </div>
      <Space.Compact style={{ width: '100%' }}>
        <Input
          value={workDir}
          onChange={(event) => setWorkDir(event.target.value)}
          placeholder="本地工作目录（可选）：代码仓库、素材目录或任意文件夹"
          disabled={saving}
          aria-label="本地工作目录"
        />
        <Button data-app-button="action" onClick={pickDirectory} disabled={saving}>选择目录</Button>
        {workDir && <Button data-app-button="action" onClick={() => setWorkDir('')} disabled={saving}>清除</Button>}
      </Space.Compact>
      <div style={{ ...hintStyle, marginTop: 5 }}>绑定目录后，它会像 Claude 在该目录下运行一样工作，自动读取其中的 CLAUDE.md、AGENTS.md 等说明。</div>
      <Space style={{ marginTop: 12 }}>
        <Button data-app-button="action" type="primary" onClick={save} disabled={!dirty || saving}>{saving ? '保存中…' : '保存'}</Button>
        {message && <span style={{ ...hintStyle, color: message.ok ? 'var(--success, #22c55e)' : 'var(--error, #ef4444)' }}>{message.text}</span>}
      </Space>
    </div>
  )
}

function SkillCard({ agent, onChanged }) {
  const currentNames = agentSkillNames(agent)
  const [selected, setSelected] = useState(currentNames)
  const [changing, setChanging] = useState(false)
  const [error, setError] = useState('')
  const [skills, setSkills] = useState([])
  const loadSkills = useCallback(() => fetchAgentSkills().then(setSkills).catch(() => setSkills([])), [])
  useEffect(() => { loadSkills() }, [agent.id, loadSkills])
  useEffect(() => { setSelected(agentSkillNames(agent)) }, [agent.id, agent.skill_names, agent.skill_name])

  const save = async (nextSelected) => {
    setChanging(true)
    setError('')
    try {
      const result = await updateAgent(agent.id, { skill_names: nextSelected })
      setSelected(nextSelected)
      onChanged(result.agent)
    } catch (err) {
      setError(err.message || '更换失败')
    } finally {
      setChanging(false)
    }
  }
  const toggle = (name) => {
    const next = selected.includes(name) ? selected.filter((entry) => entry !== name) : [...selected, name]
    save(next)
  }
  const firstSiteId = agentSiteIds(agent)[0] || ''
  return (
    <div style={sectionStyle}>
      <h3 style={sectionTitleStyle}>专属知识（Skill）</h3>
      <div style={{ ...hintStyle, marginBottom: 10 }}>勾选这个 Agent 要加载的 Skill，可以同时使用多份知识。</div>
      {skills.length ? (
        <div style={{ display: 'grid', gap: 6, marginBottom: 12 }}>
          {skills.map((skill) => (
            <label key={skill.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-primary)', flexWrap: 'wrap' }}>
              <Checkbox checked={selected.includes(skill.name)} onChange={() => toggle(skill.name)} disabled={changing}>
                {skill.name}
              </Checkbox>
              <Tag bordered={false} style={{ fontSize: 10, lineHeight: '16px', padding: '0 5px', marginInlineEnd: 0 }}>{SKILL_SCOPE_LABELS[skill.scope]}</Tag>
            </label>
          ))}
        </div>
      ) : <div style={{ ...hintStyle, marginBottom: 12 }}>还没有专属 Skill。可以在新建向导里让 AI 生成，或导入已有的 Skill。</div>}
      {error && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={error} />}
      {selected.map((name) => {
        const skill = skills.find((entry) => entry.name === name)
        return (
          <div key={name} style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 12 }}>
            {skill && <SkillScopeSwitch skill={skill} onChanged={loadSkills} />}
            <SkillEditorCard skillName={name} siteId={firstSiteId} />
          </div>
        )
      })}
      {!selected.length && <div style={hintStyle}>当前未加载任何 Skill。</div>}
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

  const boundSiteIds = agentSiteIds(agent)
  const boundSites = boundSiteIds.map((id) => sites.find((entry) => entry.id === id) || { id, name: id, enabled: true })
  const primarySite = boundSites[0] || null
  const disabledSites = boundSites.filter((entry) => entry.enabled === false)
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
        <SiteIcon site={primarySite || { id: 'agent', name: agent.name }} size={32} />
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
          <div style={{ ...hintStyle, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {boundSites.length
              ? boundSites.map((entry) => <Tag key={entry.id} style={{ marginRight: 0 }}>{entry.name || entry.id}</Tag>)
              : <Tag style={{ marginRight: 0 }}>未绑定网站</Tag>}
            {agent.work_dir && <Tag style={{ marginRight: 0, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono, monospace)' }} title={agent.work_dir}>{agent.work_dir}</Tag>}
            {agent.description}
          </div>
        </div>
        <Space>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
            <AppSwitch checked={agent.enabled} onChange={(event) => toggleEnabled(event.target.checked)} aria-label="启用WeWorker Bot" />
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
        {disabledSites.length > 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 8 }}
            message={`「${disabledSites.map((entry) => entry.name || entry.id).join('、')}」的网站能力当前未启用；Agent 的其他工作不受影响，相关网站操作会提示你先启用。`}
          />
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
        <AgentChatPanel agent={agent} siteName={primarySite?.name || boundSiteIds[0] || ''} conversations={conversations} onConversationsChanged={refresh} />
      ) : activeTab === 'tasks' ? (
        <AgentTaskPanel agent={agent} />
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 24px 24px', borderTop: '1px solid var(--border)' }}>
          <div style={{ maxWidth: 860 }}>
            <BotCard agent={agent} onChanged={applyAgent} />
            <AccessCard agent={agent} onChanged={applyAgent} />
            <CapabilityCard agent={agent} sites={sites} onChanged={applyAgent} />
            <SkillCard agent={agent} onChanged={applyAgent} />
            <BasicInfoCard agent={agent} onSaved={applyAgent} />
          </div>
        </div>
      )}
    </div>
  )
}
