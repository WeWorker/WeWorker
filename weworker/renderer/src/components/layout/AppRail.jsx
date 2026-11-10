import React, { useEffect, useState } from 'react'
import { WarningOutlined } from '@ant-design/icons'
import Tooltip from '../Tooltip.jsx'
import UpdatePrompt from '../sidebar/UpdatePrompt.jsx'
import { useToolPackagePageStore } from '../../store/tool-package-page.js'
import { useExplorationPageStore } from '../../store/exploration-page.js'
import { useWebsiteExplorationStore } from '../../store/website-exploration.js'
import { useDedicatedAgentsStore } from '../../store/dedicated-agents.js'
import { useStatusStore } from '../../store/status.js'
import { getPortConflictHelp } from '../../utils/port-conflict-help.js'

export default function AppRail({ activeSection, settingsOpen = false, extensionOpen = false, onOpenConversation, onOpenTasks, onOpenSkills, onOpenExploration, onOpenWebsiteExploration, onOpenDedicatedAgents, onOpenExtension, onOpenSettings }) {
  const [moreOpen, setMoreOpen] = useState(true)
  const [issuesOpen, setIssuesOpen] = useState(false)
  const [bridgeStatus, setBridgeStatus] = useState('unknown')
  const [backendStatus, setBackendStatus] = useState('unknown')
  const skillsOpen = useToolPackagePageStore((s) => s.open)
  const explorationOpen = useExplorationPageStore((s) => s.open)
  const websiteOpen = useWebsiteExplorationStore((s) => s.open)
  const dedicatedAgentsOpen = useDedicatedAgentsStore((s) => s.open)
  const extension = useStatusStore((s) => s.extension)
  const activeKey = settingsOpen ? 'settings' : skillsOpen ? 'skills' : explorationOpen ? 'exploration' : websiteOpen ? 'website' : dedicatedAgentsOpen ? 'dedicated-agents' : activeSection

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const status = await window.electronAPI?.getStatus?.()
        if (cancelled || !status) return
        if (status.bridge) setBridgeStatus(status.bridge)
        if (status.python) setBackendStatus(status.python)
      } catch {}
    }
    void poll()
    const timer = window.setInterval(poll, 3000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  const isWindows = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')
  const portConflicts = [
    bridgeStatus === 'port_in_use' ? { port: 3711, label: '浏览器扩展桥接端口' } : null,
    backendStatus === 'port_in_use' ? { port: 8765, label: 'WeWorker 后端端口' } : null,
  ].filter(Boolean)
  const extensionIssue = extension !== 'connected'
  const issueCount = (extensionIssue ? 1 : 0) + (portConflicts.length ? 1 : 0)
  const issuesVisible = issueCount > 0 && issuesOpen && !extensionOpen
  const browserPanelOpen = extensionOpen || issuesVisible

  useEffect(() => {
    if (!issueCount || extensionOpen) setIssuesOpen(false)
  }, [issueCount, extensionOpen])

  const openExtension = () => {
    setIssuesOpen(false)
    onOpenExtension?.()
  }

  const handleIssuesClick = () => {
    if (!issueCount) {
      openExtension()
      return
    }
    setIssuesOpen((open) => !open)
  }

  const openFeature = (handler) => {
    handler?.()
  }

  return (
    <aside className="app-rail" aria-label="主导航">
      <nav className="app-rail__nav" aria-label="工作区">
        <RailButton label="对话" active={activeKey === 'conversation'} onClick={onOpenConversation}>
          <ConversationIcon />
        </RailButton>
        <RailButton label="定时任务" active={activeKey === 'tasks'} onClick={onOpenTasks}>
          <ClockIcon />
        </RailButton>
        <RailButton label="WeWorker Bot" active={activeKey === 'dedicated-agents'} onClick={onOpenDedicatedAgents}>
          <DedicatedAgentIcon />
        </RailButton>
        <div className={`app-rail__more-wrap app-rail__more-wrap--top${moreOpen ? ' is-open' : ''}`}>
          <Tooltip text={moreOpen ? '收起更多功能' : '展开更多功能'} placement="right">
            <button
              type="button"
              className={`app-rail__drawer-handle${moreOpen ? ' is-open' : ''}`}
              aria-label={moreOpen ? '收起更多功能' : '展开更多功能'}
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((current) => !current)}
            >
              <DrawerHandleIcon />
            </button>
          </Tooltip>
          <div className="app-rail__more-items" role="menu" aria-label="更多功能" aria-hidden={!moreOpen}>
            <RailMenuButton label="SKILLS与场景" active={activeKey === 'skills'} disabled={!moreOpen} onClick={() => openFeature(onOpenSkills)}>
              <SkillsIcon />
            </RailMenuButton>
            <RailMenuButton label="网站探索agent" active={activeKey === 'website'} disabled={!moreOpen} onClick={() => openFeature(onOpenWebsiteExploration)}>
              <GlobeIcon />
            </RailMenuButton>
          </div>
        </div>
      </nav>

      <div className="app-rail__spacer" />

      <nav className="app-rail__nav app-rail__nav--bottom" aria-label="工具">
        <UpdatePrompt />
        {/* Always reachable: the panel also shows and hides WeWorker 浏览器 (for sign-in or checking a task). */}
        <div className="app-rail__issues-wrap">
          <Tooltip text={issueCount > 0 ? `有 ${issueCount} 个问题` : '浏览器与扩展'} placement="right">
            <button
              type="button"
              className={`app-rail__button${issueCount > 0 ? ' app-rail__issues-button' : ''}${browserPanelOpen ? ' is-active' : ''}`}
              aria-label={issueCount > 0 ? `有 ${issueCount} 个问题` : '浏览器与扩展'}
              aria-expanded={browserPanelOpen}
              onClick={handleIssuesClick}
            >
              <ExtensionIcon warning={issueCount > 0} />
              {issueCount > 0 && <span className="app-rail__issue-badge" aria-hidden="true">{issueCount}</span>}
            </button>
          </Tooltip>
          {issuesVisible && (
            <IssuePanel
              extensionIssue={extensionIssue}
              portConflicts={portConflicts}
              isWindows={isWindows}
              onOpenExtension={openExtension}
            />
          )}
        </div>
        <RailButton label="设置" active={activeKey === 'settings'} onClick={onOpenSettings}>
          <SettingsIcon />
        </RailButton>
      </nav>
    </aside>
  )
}

function RailButton({ label, active = false, onClick, children }) {
  return (
    <Tooltip text={label} placement="right">
      <button
        type="button"
        className={`app-rail__button${active ? ' is-active' : ''}`}
        aria-label={label}
        aria-pressed={active}
        onClick={onClick}
      >
        {children}
      </button>
    </Tooltip>
  )
}

function RailMenuButton({ label, active = false, disabled = false, onClick, children }) {
  return (
    <Tooltip text={label} placement="right">
      <button type="button" role="menuitem" className={active ? 'is-active' : ''} aria-label={label} disabled={disabled} onClick={onClick}>
        {children}
      </button>
    </Tooltip>
  )
}

function IssuePanel({ extensionIssue, portConflicts, isWindows, onOpenExtension }) {
  return (
    <div className="app-rail__issues-panel" role="dialog" aria-label="问题列表">
      <div className="app-rail__issues-title">
        <strong>问题列表</strong>
      </div>
      {extensionIssue && (
        <button type="button" className="app-rail__issue-item" onClick={onOpenExtension}>
          <span className="app-rail__issue-item-icon"><WarningOutlined aria-hidden="true" /></span>
          <span className="app-rail__issue-item-copy">
            <strong>浏览器扩展未连接</strong>
          </span>
        </button>
      )}
      {portConflicts.length > 0 && (
        <div className="app-rail__issue-item app-rail__issue-item--port">
          <span className="app-rail__issue-item-icon"><WarningOutlined aria-hidden="true" /></span>
          <span className="app-rail__issue-item-copy">
            <strong>端口冲突</strong>
            <small>{portConflicts.map(({ port, label }) => `${label}（${port}）`).join('、')}</small>
            {portConflicts.map(({ port }) => {
              const help = getPortConflictHelp(port, isWindows)
              return (
                <span key={port} className="app-rail__issue-command-group">
                  <span className="app-rail__issue-command-line">查询：<code>{help.command}</code></span>
                  <span className="app-rail__issue-command-line">结束：<code>{help.killCommand}</code></span>
                </span>
              )
            })}
          </span>
        </div>
      )}
    </div>
  )
}

function ConversationIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H11l-5.5 3v-3H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z" /><path d="M7 10h10M7 13h6" /></svg>
}

function ClockIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3.2 2" /></svg>
}

function DedicatedAgentIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="8" width="16" height="12" rx="3" /><path d="M12 8V4" /><circle cx="12" cy="3.5" r="1" /><path d="M9 14h.01M15 14h.01" /><path d="M2 13v3M22 13v3" /></svg>
}

function SkillsIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 4.5-8 4.5-8-4.5z" /><path d="m4 12 8 4.5 8-4.5" /><path d="m4 16.5 8 4.5 8-4.5" /></svg>
}

function ExploreIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4M8 11h6M11 8v6" /></svg>
}

function GlobeIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M3.8 9h16.4M3.8 15h16.4M12 3.5c2.1 2.3 3.2 5.1 3.2 8.5s-1.1 6.2-3.2 8.5c-2.1-2.3-3.2-5.1-3.2-8.5S9.9 5.8 12 3.5Z" /></svg>
}

function ExtensionIcon({ warning = false }) {
  if (warning) return <WarningOutlined aria-hidden="true" style={{ color: 'var(--warning)' }} />
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M7 6.5h.01M10 6.5h.01" /></svg>
}

function DrawerHandleIcon() {
  return <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><g fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></g></svg>
}

function SettingsIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.1h-4v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1-2.8-2.8.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3v-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1 2.8-2.8.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6V3h4v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1 2.8 2.8-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.1v4h-.1a1.7 1.7 0 0 0-1.6 1Z" /></svg>
}
