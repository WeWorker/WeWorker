import React, { useEffect, useRef, useState } from 'react'
import { Alert, Button, Checkbox, Popconfirm } from 'antd'
import { PlusOutlined, RobotOutlined } from '@ant-design/icons'
import { useDedicatedAgentsStore } from '../../store/dedicated-agents.js'
import { useSitesStore } from '../../store/sites.js'
import SiteIcon from '../icons/SiteIcon.jsx'
import { TablerPlusIcon } from '../icons/TablerFolderPlusIcon.jsx'
import Tooltip from '../Tooltip.jsx'
import { agentStatusPresentation, TONE_COLORS } from '../../utils/dedicated-agents.js'
import { deleteAgent } from '../../api/dedicated-agents-api.js'
import { showAlert } from '../../store/dialog.js'
import { RenameIcon, TrashIcon } from '../icons/PanelIcons.jsx'
import AgentCreateWizard from './AgentCreateWizard.jsx'
import AgentDetail from './AgentDetail.jsx'
import AgentNameEditor from './AgentNameEditor.jsx'
import { contentStyle, hintStyle, listColumnStyle, pageStyle, sectionStyle, titleStyle } from './styles.js'

const LIST_REFRESH_MS = 8000

const listNameInputStyle = {
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--text-primary)',
  fontFamily: 'inherit',
  padding: '1px 6px',
  border: '1px solid var(--border)',
  borderRadius: 5,
  background: 'var(--bg-primary)',
  width: 140,
  maxWidth: '100%',
}

function AgentListItem({ agent, site, active, onSelect, onRenamed, onDelete }) {
  const status = agentStatusPresentation(agent)
  const nameEditorRef = useRef(null)
  const [keepConversations, setKeepConversations] = useState(false)
  return (
    <div
      role="button"
      tabIndex={0}
      className={`work-list-item sidebar-detail-item agent-list-item${active ? ' is-active' : ''}`}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect() }
      }}
      aria-current={active ? 'true' : undefined}
    >
      <SiteIcon site={site || { id: agent.site_id, name: agent.site_id }} size={18} />
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <AgentNameEditor
          ref={nameEditorRef}
          agentId={agent.id}
          name={agent.name}
          onSave={agent.draft && agent.id.startsWith('draft-') ? async (name) => ({ ...agent, name }) : undefined}
          onSaved={onRenamed}
          iconSize={11}
          textStyle={{ fontSize: 12, fontWeight: 400, lineHeight: '18px' }}
          inputStyle={listNameInputStyle}
          hideEditButton
        />
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, lineHeight: '15px', color: TONE_COLORS[status.tone] }}>
          <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: TONE_COLORS[status.tone] }} />
          {status.label}
        </span>
      </span>
      <span className="sidebar-row-actions">
          <button
            type="button"
            className="sidebar-row-action"
            aria-label={`重命名专属 Agent ${agent.name}`}
            title="重命名"
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onClick={(event) => { event.stopPropagation(); nameEditorRef.current?.edit() }}
          >
            <RenameIcon size={13} />
          </button>
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
          onConfirm={() => onDelete?.(keepConversations)}
        >
          <button
            type="button"
            className="sidebar-row-action"
            aria-label={`删除专属 Agent ${agent.name}`}
            title="删除"
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <TrashIcon size={13} />
          </button>
        </Popconfirm>
      </span>
    </div>
  )
}

function Intro({ onCreate, hasAgents }) {
  return (
    <div style={{ maxWidth: 720 }}>
      <h2 style={titleStyle}>专属 Agent</h2>
      <div style={{ ...hintStyle, fontSize: 13, margin: '8px 0 20px' }}>
        为某个网站打造一个小而专注的 Agent：它掌握你的专属知识，连接一个企业微信或微信机器人。你在手机上直接和它对话，它独立运行，不影响 WeWorker 的主对话。
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12, marginBottom: 20 }}>
        {[
          ['1. 选网站', '选一个 WeWorker 已经能操作的网站'],
          ['2. 写专属知识', '用大白话描述，AI 帮你整理成 Skill'],
          ['3. 扫码绑定', '企业微信或微信扫码，一键获得机器人'],
          ['4. 发绑定码', '给机器人发一句话完成配对'],
        ].map(([title, text]) => (
          <div key={title} style={{ ...sectionStyle, marginBottom: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>{title}</div>
            <div style={hintStyle}>{text}</div>
          </div>
        ))}
      </div>
      <Button data-app-button="action" type="primary" size="large" icon={<PlusOutlined />} onClick={onCreate}>新建专属 Agent</Button>
      {hasAgents && <div style={{ ...hintStyle, marginTop: 12 }}>也可以在左侧选择一个已有的 Agent 查看和管理。</div>}
    </div>
  )
}

export default function DedicatedAgentsPage({ sidebarWidth, compactLayout = false }) {
  const agents = useDedicatedAgentsStore((s) => s.agents)
  const view = useDedicatedAgentsStore((s) => s.view)
  const selectedId = useDedicatedAgentsStore((s) => s.selectedId)
  const loaded = useDedicatedAgentsStore((s) => s.loaded)
  const loadError = useDedicatedAgentsStore((s) => s.loadError)
  const loadAgents = useDedicatedAgentsStore((s) => s.loadAgents)
  const startCreate = useDedicatedAgentsStore((s) => s.startCreate)
  const selectAgent = useDedicatedAgentsStore((s) => s.selectAgent)
  const upsertAgent = useDedicatedAgentsStore((s) => s.upsertAgent)
  const removeAgent = useDedicatedAgentsStore((s) => s.removeAgent)
  const sites = useSitesStore((s) => s.sites)
  const loadSites = useSitesStore((s) => s.load)

  useEffect(() => {
    loadAgents()
    if (!sites.length) loadSites()
    const timer = setInterval(loadAgents, LIST_REFRESH_MS)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const siteById = new Map(sites.map((site) => [site.id, site]))
  const handleDeleteAgent = async (agent, keepConversations) => {
    try {
      if (!agent.id.startsWith('draft-')) await deleteAgent(agent.id, { keepConversations })
      removeAgent(agent.id)
    } catch (error) {
      showAlert(error.message || '删除失败，请重试')
    }
  }
  const showDetail = view === 'detail' && selectedId && agents.some((agent) => agent.id === selectedId)
  const activeDraft = agents.find((agent) => agent.draft && agent.id === selectedId)

  return (
    <div style={pageStyle}>
      <div style={{ ...listColumnStyle, width: sidebarWidth, minWidth: sidebarWidth, display: compactLayout ? 'none' : listColumnStyle.display }}>
        <div className="sidebar-section-header">
          <div className="sidebar-section-label">
            <RobotOutlined aria-hidden="true" />
            <span>专属 Agent</span>
          </div>
          <Tooltip text="新建专属 Agent">
            <button type="button" className="sidebar-icon-button" onClick={startCreate} aria-label="新建专属 Agent">
              <TablerPlusIcon />
            </button>
          </Tooltip>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0 10px' }}>
          {loadError && <Alert type="error" showIcon message={loadError} style={{ margin: 4 }} />}
          {loaded && !agents.length && !loadError && <div style={{ ...hintStyle, padding: '8px 12px' }}>还没有专属 Agent</div>}
          {agents.map((agent) => (
            <AgentListItem
              key={agent.id}
              agent={agent}
              site={siteById.get(agent.site_id)}
              active={agent.id === selectedId}
              onSelect={() => selectAgent(agent.id)}
              onRenamed={upsertAgent}
              onDelete={(keepConversations) => handleDeleteAgent(agent, keepConversations)}
            />
          ))}
        </div>
      </div>
      {showDetail ? (
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <AgentDetail key={selectedId} agentId={selectedId} />
        </div>
      ) : (
        <div style={contentStyle}>
          {view === 'create' && activeDraft && <AgentCreateWizard key={activeDraft.draftKey || activeDraft.id} draftKey={activeDraft.draftKey || activeDraft.id} />}
          {view !== 'create' && <Intro onCreate={startCreate} hasAgents={agents.length > 0} />}
        </div>
      )}
    </div>
  )
}
