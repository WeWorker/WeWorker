import React, { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Input, Result, Space, Steps } from 'antd'
import { LoadingOutlined } from '@ant-design/icons'
import AgentNameEditor from './AgentNameEditor.jsx'
import SiteIcon from '../icons/SiteIcon.jsx'
import { useSitesStore } from '../../store/sites.js'
import { useDedicatedAgentsStore } from '../../store/dedicated-agents.js'
import { useWorksStore } from '../../store/works.js'
import { createAgent, createSkill, fetchAgentDetail, saveSkill, setSkillScope } from '../../api/dedicated-agents-api.js'
import {
  SKILL_MODES,
  WIZARD_STEPS,
  defaultAgentName,
  enabledSites,
  filterSites,
  pairingCommand,
  parseExamples,
  resolveDraftSkillName,
  validateWizardStep,
  agentChannelOf,
  boundBotPayload,
  channelLabel,
} from '../../utils/dedicated-agents.js'
import SkillComposer from './SkillComposer.jsx'
import WecomQrBind, { BotChannelPicker } from './WecomQrBind.jsx'
import AppSwitch from '../common/AppSwitch.jsx'
import { codeBadgeStyle, fieldStyle, hintStyle, labelStyle, sectionStyle, titleStyle } from './styles.js'
import './agent-create-wizard.css'

const PAIR_POLL_MS = 2500

const INITIAL_DRAFT = {
  siteId: '',
  name: '',
  description: '',
  skillMode: SKILL_MODES.generate,
  goal: '',
  knowledge: '',
  skillName: '',
  skillMarkdown: '',
  existingSkill: '',
  examplesText: '',
  savedSkillName: '',
  /** New skills stay with dedicated agents unless the user shares them with the main chat. */
  skillScope: 'private',
  /** Keep the safer private setting unless the creator opts into WeCom sharing. */
  accessMode: 'owner_only',
}

function SitePicker({ sites, selectedId, onSelect }) {
  const [query, setQuery] = useState('')
  const visible = filterSites(sites, query)
  return (
    <div className="agent-site-picker">
      <Input.Search value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索网站名称或域名" style={{ maxWidth: 360, marginBottom: 12 }} allowClear aria-label="搜索网站" />
      {visible.length === 0 ? (
        <div style={hintStyle}>没有找到可用的网站。请先在「SKILLS与场景」中启用对应网站。</div>
      ) : (
        <div className="agent-site-picker__list" role="listbox" aria-label="选择网站" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10, maxHeight: 320, overflowY: 'auto', paddingRight: 4 }}>
          {visible.map((site) => {
            const active = site.id === selectedId
            return (
              <button
                key={site.id}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => onSelect(site)}
                style={{
                  display: 'flex', gap: 10, alignItems: 'flex-start', textAlign: 'left', padding: 12, borderRadius: 10, cursor: 'pointer',
                  border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                  background: active ? 'color-mix(in srgb, var(--accent) 10%, var(--bg-primary))' : 'var(--bg-primary)',
                  color: 'var(--text-primary)', fontFamily: 'inherit',
                }}
              >
                <SiteIcon site={site} size={28} />
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>{site.name || site.id}</span>
                  <span style={{ display: 'block', ...hintStyle, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{site.description || site.id}</span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function PairingStep({ agent, draftKey, onDone }) {
  const [current, setCurrent] = useState(agent)
  const updateDraftAgent = useDedicatedAgentsStore((s) => s.updateDraftAgent)

  useEffect(() => {
    if (current?.paired) return undefined
    const timer = setInterval(async () => {
      try {
        const detail = await fetchAgentDetail(agent.id)
        setCurrent(detail.agent)
        updateDraftAgent(detail.agent, draftKey)
      } catch {
        // Keep polling.
      }
    }, PAIR_POLL_MS)
    return () => clearInterval(timer)
  }, [agent.id, draftKey, current?.paired, updateDraftAgent])

  const channel = agentChannelOf(current)
  const im = channelLabel(channel)
  if (current?.paired) {
    return (
      <Result
        status="success"
        title={`「${current.name}」已就绪`}
        subTitle={`现在直接在${im}里和这个机器人对话就可以了。`}
        extra={[
          <Button data-app-button="action" type="primary" key="open" onClick={() => onDone(current)}>查看 Agent</Button>,
        ]}
      >
        {current.examples?.length > 0 && (
          <div style={{ textAlign: 'left', maxWidth: 480, margin: '0 auto' }}>
            <div style={labelStyle}>试试这样问它：</div>
            <ul style={{ ...hintStyle, paddingLeft: 18 }}>
              {current.examples.map((example) => <li key={example}>{example}</li>)}
            </ul>
          </div>
        )}
      </Result>
    )
  }

  const connection = current?.connection?.status
  return (
    <div>
      <div style={{ fontSize: 14, color: 'var(--text-primary)', marginBottom: 12 }}>
        最后一步：在<strong>{im}</strong>里找到刚才的机器人，给它发送下面这句话：
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <span style={codeBadgeStyle}>{pairingCommand(current?.pairing_code)}</span>
        <Button data-app-button="action" onClick={() => navigator.clipboard?.writeText(pairingCommand(current?.pairing_code)).catch(() => {})}>复制</Button>
      </div>
      <ul style={{ ...hintStyle, paddingLeft: 18 }}>
        <li>
          {channel === 'weixin'
            ? '机器人一般出现在扫码那个微信号的聊天列表中，也可以在微信里搜索它。'
            : '机器人一般出现在企业微信的消息列表或「工作台 → 智能机器人」中，也可以直接搜索它的名字。'}
        </li>
        <li>{channel === 'wecom' && current?.access_mode === 'wecom_authorized'
          ? '发送绑定码的人会成为这个 Agent 的主人。企业微信后台已获授权的其他成员也可以使用它。'
          : '发送绑定码的人会成为这个 Agent 的主人，之后仅主人可以使用。'}</li>
      </ul>
      <div style={{ ...hintStyle, marginTop: 12 }}>
        <LoadingOutlined /> 等待配对…
        {connection === 'error' && <span style={{ color: 'var(--error, #ef4444)', marginLeft: 8 }}>机器人连接异常：{current?.connection?.error || '请检查网络'}</span>}
        {connection === 'connected' && <span style={{ color: 'var(--success, #22c55e)', marginLeft: 8 }}>机器人已连接</span>}
      </div>
    </div>
  )
}

function AccessModePicker({ channel, value, onChange }) {
  if (channel !== 'wecom') {
    return <div style={{ ...hintStyle, marginTop: 14 }}>微信机器人当前仅支持主人使用。</div>
  }
  const ownerOnly = value !== 'wecom_authorized'
  return (
    <div style={{ ...fieldStyle, marginTop: 14 }}>
      <label style={{ ...labelStyle, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <AppSwitch checked={ownerOnly} onChange={(event) => onChange(event.target.checked ? 'owner_only' : 'wecom_authorized')} aria-label="仅主人可用" />
        仅主人可用
      </label>
      <div style={{ ...hintStyle, marginTop: 5 }}>
        {ownerOnly
          ? '开启后，即使企业微信已向其他成员授权该机器人，也只有发送绑定码的主人可以使用。'
          : '关闭后，企业微信后台已获授权使用该机器人的成员都可以和它对话。成员权限仍由企业微信后台管理。'}
      </div>
    </div>
  )
}

export default function AgentCreateWizard({ draftKey }) {
  const sites = useSitesStore((s) => s.sites)
  const loadSites = useSitesStore((s) => s.load)
  const existingDraft = useDedicatedAgentsStore((s) => s.agents.find((agent) => agent.draft && (agent.draftKey || agent.id) === draftKey))
  const updateDraftAgent = useDedicatedAgentsStore((s) => s.updateDraftAgent)
  const cancelCreate = useDedicatedAgentsStore((s) => s.cancelCreate)
  const completeCreate = useDedicatedAgentsStore((s) => s.completeCreate)
  const loadWorks = useWorksStore((s) => s.loadWorks)
  const backendCreated = existingDraft && !existingDraft.id.startsWith('draft-')
  const [step, setStep] = useState(() => backendCreated ? 3 : (existingDraft?.wizardStep || 0))
  const draft = { ...INITIAL_DRAFT, ...(existingDraft || {}) }
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [createdAgent, setCreatedAgent] = useState(() => backendCreated ? existingDraft : null)
  const [bindKey, setBindKey] = useState(0)
  const [botChannel, setBotChannel] = useState(existingDraft?.channel || 'wecom')

  useEffect(() => {
    if (!sites.length) loadSites()
  }, [sites.length, loadSites])

  const available = useMemo(() => enabledSites(sites), [sites])
  const site = available.find((entry) => entry.id === draft.siteId) || null
  const stepKey = WIZARD_STEPS[step].key
  const update = (patch) => {
    updateDraftAgent(patch, draftKey)
  }

  const selectSite = (next) => {
    const patch = ((current) => {
      const autoName = !current.name || current.name === '新建专属 Agent' || current.name === defaultAgentName(site)
      return {
        ...current,
        siteId: next.id,
        site_id: next.id,
        name: autoName ? defaultAgentName(next) : current.name,
        // A different site has different tools: drop an AI draft and its suggested name.
        ...(current.siteId && current.siteId !== next.id ? { skillMarkdown: '', skillName: '', savedSkillName: '' } : {}),
      }
    })(draft)
    update(patch)
  }

  const next = () => {
    const message = validateWizardStep(stepKey, draft)
    setError(message)
    if (!message) {
      const nextStep = Math.min(step + 1, WIZARD_STEPS.length - 1)
      setStep(nextStep)
      updateDraftAgent({ wizardStep: nextStep }, draftKey)
    }
  }

  const back = () => {
    setError('')
    const previousStep = Math.max(step - 1, 0)
    setStep(previousStep)
    updateDraftAgent({ wizardStep: previousStep }, draftKey)
  }

  /** Save the AI-written skill (once), then create the agent with the bound bot. */
  const handleBound = async (bot) => {
    setSaving(true)
    setError('')
    try {
      let skillName = resolveDraftSkillName(draft)
      if (draft.skillMode === SKILL_MODES.generate) {
        if (draft.savedSkillName === draft.skillName) {
          await saveSkill(draft.skillName, draft.skillMarkdown)
          await setSkillScope(draft.skillName, draft.skillScope)
        } else {
          const saved = await createSkill(draft.skillName, draft.skillMarkdown, draft.skillScope)
          skillName = saved.name
          update({ savedSkillName: saved.name })
        }
      }
      const body = {
        name: draft.name.trim(),
        description: draft.description.trim(),
        site_id: draft.siteId,
        skill_name: skillName,
        examples: parseExamples(draft.examplesText),
        access_mode: bot.channel === 'wecom' ? draft.accessMode : 'owner_only',
        ...boundBotPayload(bot),
      }
      const result = await createAgent(body)
      await loadWorks()
      updateDraftAgent({ ...result.agent, wizardStep: 3 }, draftKey)
      setCreatedAgent(result.agent)
      setStep(3)
    } catch (err) {
      setError(err.message || '创建失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={stepKey === 'site' ? 'agent-create-wizard--site' : undefined} style={{ maxWidth: 860 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
          <h2 style={titleStyle}>
            {createdAgent ? (draft.name.trim() || '新建专属 Agent') : (
              <AgentNameEditor
                name={draft.name.trim() || '新建专属 Agent'}
                onSave={async (name) => {
                  update({ name })
                  return { ...existingDraft, name }
                }}
                disabled={saving}
                iconSize={14}
                inputStyle={{ ...titleStyle, width: 240, maxWidth: '100%', padding: '2px 6px', border: '1px solid var(--border)', borderRadius: 5, background: 'var(--bg-primary)' }}
              />
            )}
          </h2>
        </div>
        {!createdAgent && <Button data-app-button="action" onClick={cancelCreate}>保存并返回</Button>}
      </div>
      <div style={{ ...hintStyle, marginBottom: 18 }}>一个专属 Agent = 一个网站的能力 + 你的专属知识 + 一个企业微信或微信机器人。大约 5 分钟完成。</div>
      <Steps size="small" current={step} items={WIZARD_STEPS.map((item) => ({ title: item.title }))} style={{ marginBottom: 20 }} />

      <div className="agent-create-wizard__section" style={sectionStyle}>
        {stepKey === 'site' && (
          <div className="agent-create-wizard__site">
            <div style={{ ...labelStyle, marginBottom: 10 }}><span aria-hidden="true" style={{ color: 'var(--error, #ef4444)', marginRight: 4 }}>*</span>这个 Agent 主要操作哪个网站？</div>
            <SitePicker sites={available} selectedId={draft.siteId} onSelect={selectSite} />
            {site && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12, marginTop: 18 }}>
                <div style={fieldStyle}>
                  <label style={labelStyle} htmlFor="agent-name"><span aria-hidden="true" style={{ color: 'var(--error, #ef4444)', marginRight: 4 }}>*</span>Agent 名称</label>
                  <Input id="agent-name" value={draft.name} maxLength={40} onChange={(event) => update({ name: event.target.value })} placeholder="例如：采购助手" />
                </div>
                <div style={fieldStyle}>
                  <label style={labelStyle} htmlFor="agent-description">一句话说明（可选）</label>
                  <Input id="agent-description" value={draft.description} maxLength={200} onChange={(event) => update({ description: event.target.value })} placeholder={`例如：帮我在「${site.name || site.id}」上完成日常查询和处理`} />
                </div>
              </div>
            )}
          </div>
        )}

        {stepKey === 'skill' && site && <SkillComposer draft={draft} onChange={update} site={site} />}

        {stepKey === 'bind' && (
          <div>
            <div style={{ ...labelStyle, marginBottom: 12 }}><span aria-hidden="true" style={{ color: 'var(--error, #ef4444)', marginRight: 4 }}>*</span>给「{draft.name}」绑定一个机器人，之后在{channelLabel(botChannel)}里和它对话</div>
            <BotChannelPicker
              value={botChannel}
              disabled={saving}
              onChange={(next) => {
                setError('')
                setBotChannel(next)
                update({ channel: next, ...(next === 'weixin' ? { accessMode: 'owner_only' } : {}) })
                setBindKey((value) => value + 1)
              }}
            />
            <AccessModePicker channel={botChannel} value={draft.accessMode} onChange={(accessMode) => update({ accessMode })} />
            <WecomQrBind key={`${botChannel}-${bindKey}`} channel={botChannel} onBound={handleBound} busy={saving} />
            {error && (
              <Alert
                type="error"
                showIcon
                style={{ marginTop: 16 }}
                message={error}
                action={<Button data-app-button="action" size="small" onClick={() => { setError(''); setBindKey((value) => value + 1) }}>重新扫码</Button>}
              />
            )}
          </div>
        )}

        {stepKey === 'pair' && createdAgent && (
          <PairingStep agent={createdAgent} draftKey={draftKey} onDone={(agent) => completeCreate(agent, draftKey)} />
        )}
      </div>

      {stepKey !== 'pair' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {error && stepKey !== 'bind' && <span style={{ ...hintStyle, color: 'var(--error, #ef4444)', flex: 1 }}>{error}</span>}
          <Space style={{ marginLeft: 'auto' }}>
            {step > 0 && <Button data-app-button="action" onClick={back} disabled={saving}>上一步</Button>}
            {stepKey !== 'bind' && <Button data-app-button="action" type="primary" onClick={next}>下一步</Button>}
          </Space>
        </div>
      )}
    </div>
  )
}
