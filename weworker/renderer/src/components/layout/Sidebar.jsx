import React, { useEffect, useState, useRef } from 'react'
import WorksList, { LABEL_COLORS, LABEL_OPTIONS } from '../sidebar/WorksList.jsx'
import ScheduledTasksList from '../sidebar/ScheduledTasksList.jsx'
import StatusBar from '../sidebar/StatusBar.jsx'
import UpdatePrompt from '../sidebar/UpdatePrompt.jsx'
import Tooltip from '../Tooltip.jsx'
import { useWorksStore } from '../../store/works.js'
import { useScheduledTasksStore } from '../../store/scheduled-tasks.js'
import { useToolPackagePageStore } from '../../store/tool-package-page.js'
import { useCapabilitiesPanelStore } from '../../store/capabilities-panel.js'
import { useUserFilesStore } from '../../store/user-files.js'
import { useExplorationPageStore } from '../../store/exploration-page.js'
import { useWebsiteExplorationStore, leaveWebsiteExploration } from '../../store/website-exploration.js'

export default function Sidebar({ onOpenSettings, collapsed, onCollapse, width }) {
  const createWork = useWorksStore((s) => s.createWork)
  const createTask = useScheduledTasksStore((s) => s.createTask)
  const loadTasks = useScheduledTasksStore((s) => s.loadTasks)
  const activeTaskId = useScheduledTasksStore((s) => s.activeTaskId)
  const toolPackageOpen = useToolPackagePageStore((s) => s.open)
  const explorationOpen = useExplorationPageStore((s) => s.open)
  const websiteOpen = useWebsiteExplorationStore((s) => s.open)
  const websiteActivity = useWebsiteExplorationStore((s) => s.activity)
  const openToolPackagePage = useToolPackagePageStore((s) => s.openPage)
  const openExplorationPage = useExplorationPageStore((s) => s.openPage)
  const [searchQuery, setSearchQuery] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [showLabelFilter, setShowLabelFilter] = useState(false)
  const labelFilterRef = useRef(null)
  const hasLabeled = useWorksStore((s) => (Array.isArray(s.works) ? s.works : []).some((w) => w.label))
  const labelFilter = useWorksStore((s) => s.labelFilter)
  const setLabelFilter = useWorksStore((s) => s.setLabelFilter)
  const labelNames = useWorksStore((s) => s.labelNames)

  useEffect(() => {
    loadTasks()
  }, [])

  // Close label filter dropdown on outside click
  useEffect(() => {
    if (!showLabelFilter) return
    const close = (e) => {
      if (labelFilterRef.current && !labelFilterRef.current.contains(e.target)) setShowLabelFilter(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [showLabelFilter])

  const handleCreateTask = async () => {
    if (!await leaveWebsiteExploration()) return
    useToolPackagePageStore.getState().closePage()
    useExplorationPageStore.getState().closePage()
    // If there's already an unconfigured task (empty prompt), just select it
    const tasks = useScheduledTasksStore.getState().tasks
    const unconfigured = tasks.find(t => !t.prompt_template && t.title === '新定时任务')
    if (unconfigured) {
      useScheduledTasksStore.getState().selectTask(unconfigured.id)
      return
    }
    createTask({
      title: '新定时任务',
      cron_expression: '0 * * * *',
      prompt_template: '',
      enabled: false,
    })
  }

  const handleCreateWork = async () => {
    if (!await leaveWebsiteExploration()) return
    useToolPackagePageStore.getState().closePage()
    useExplorationPageStore.getState().closePage()
    createWork()
  }

  const handleOpenToolPackage = async () => {
    if (!await leaveWebsiteExploration()) return
    useExplorationPageStore.getState().closePage()
    useWorksStore.setState({ activeWorkId: null })
    useScheduledTasksStore.setState({ activeTaskId: null })
    useUserFilesStore?.getState?.()?.closePanel?.()
    useCapabilitiesPanelStore?.getState?.()?.closePanel?.()
    openToolPackagePage()
  }

  const handleOpenExploration = async () => {
    if (!await leaveWebsiteExploration()) return
    useToolPackagePageStore.getState().closePage()
    useWorksStore.setState({ activeWorkId: null })
    useScheduledTasksStore.setState({ activeTaskId: null })
    useUserFilesStore?.getState?.()?.closePanel?.()
    useCapabilitiesPanelStore?.getState?.()?.closePanel?.()
    openExplorationPage()
  }

  const handleOpenWorksSection = async () => {
    if (!await leaveWebsiteExploration()) return
    useToolPackagePageStore.getState().closePage()
    useExplorationPageStore.getState().closePage()
    useScheduledTasksStore.setState({ activeTaskId: null })
  }

  const handleOpenTasksSection = async () => {
    if (!await leaveWebsiteExploration()) return
    useToolPackagePageStore.getState().closePage()
    useExplorationPageStore.getState().closePage()
    useWorksStore.setState({ activeWorkId: null })
    const state = useScheduledTasksStore.getState()
    if (!state.activeTaskId && state.tasks[0]?.id) state.selectTask(state.tasks[0].id)
  }

  const worksSectionActive = !websiteOpen && !toolPackageOpen && !explorationOpen && !activeTaskId
  const tasksSectionActive = !websiteOpen && !toolPackageOpen && !explorationOpen && Boolean(activeTaskId)

  return (
    <div style={{
      width: collapsed ? 0 : width,
      minWidth: collapsed ? 0 : width,
      background: 'var(--bg-secondary)',
      borderRight: collapsed ? 'none' : '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      WebkitAppRegion: 'drag',
      overflow: 'hidden',
      transition: 'width 0.2s ease, min-width 0.2s ease',
    }}>
      <div style={{
        padding: '10px 12px 4px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        WebkitAppRegion: 'drag',
      }}>
        <button
          type="button"
          onClick={handleOpenToolPackage}
          style={{
            ...sidebarSectionButtonStyle,
            color: toolPackageOpen ? 'var(--text-primary)' : 'var(--text-muted)',
          }}
        >
          <ToolPackageNavIcon size={13} />
          <span>SKILLS与场景</span>
        </button>
      </div>
      <div style={{ padding: '2px 12px 6px', WebkitAppRegion: 'no-drag' }}>
        <button
          type="button"
          onClick={handleOpenExploration}
          style={{
            ...sidebarSectionButtonStyle,
            width: '100%',
            color: explorationOpen ? 'var(--text-primary)' : 'var(--text-muted)',
          }}
        >
          <ExplorationNavIcon size={13} />
          <span>API 探索</span>
        </button>
      </div>
      <div style={{ padding: '2px 12px 6px', WebkitAppRegion: 'no-drag' }}>
        <button type="button" onClick={() => {
          useToolPackagePageStore.getState().closePage()
          useExplorationPageStore.getState().closePage()
          useWorksStore.setState({ activeWorkId: null })
          useScheduledTasksStore.setState({ activeTaskId: null })
          useUserFilesStore.getState().closePanel?.()
          useCapabilitiesPanelStore.getState().closePanel?.()
          useWebsiteExplorationStore.setState({ open: true })
        }} style={{ ...sidebarSectionButtonStyle, width: '100%', color: websiteOpen ? 'var(--text-primary)' : 'var(--text-muted)' }}>
          <ExplorationNavIcon size={13} /><span>网站探索agent{websiteActivity.running ? ' · 运行中' : ''}</span>
        </button>
      </div>
      {/* 任务 section */}
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <div style={{
          padding: '10px 12px 4px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          WebkitAppRegion: 'no-drag',
        }}>
          <button
            type="button"
            onClick={handleOpenWorksSection}
            style={{
              ...sidebarSectionButtonStyle,
              color: worksSectionActive ? 'var(--text-primary)' : 'var(--text-muted)',
            }}
          >
            <WorksNavIcon size={13} />
            <span>任务</span>
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, WebkitAppRegion: 'no-drag' }}>
            {/* Label filter — only visible when there are labeled works or a filter is active */}
            {(hasLabeled || labelFilter) && (
              <div ref={labelFilterRef} style={{ position: 'relative' }}>
              <Tooltip text="按标记筛选">
                <button
                  onClick={() => setShowLabelFilter((v) => !v)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: labelFilter ? LABEL_COLORS[labelFilter] : 'var(--text-secondary)',
                    cursor: 'pointer',
                    fontSize: 14,
                    lineHeight: 1,
                    padding: '2px 4px',
                    borderRadius: 4,
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill={labelFilter ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
                  </svg>
                </button>
              </Tooltip>
                {showLabelFilter && (
                  <div style={{
                    position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 100,
                    background: 'var(--bg-primary, #fff)', border: '1px solid var(--border, #e5e7eb)',
                    borderRadius: 8, padding: '6px 0', minWidth: 120,
                    boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                  }}>
                    <button
                      onClick={() => { setLabelFilter(null); setShowLabelFilter(false) }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                        background: !labelFilter ? 'var(--bg-hover, #f3f4f6)' : 'none',
                        border: 'none', cursor: 'pointer', padding: '5px 12px',
                        fontSize: 12, color: 'var(--text-secondary)', textAlign: 'left',
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-hover, #f3f4f6)'}
                      onMouseLeave={(e) => e.currentTarget.style.background = !labelFilter ? 'var(--bg-hover, #f3f4f6)' : 'transparent'}
                    >
                      全部
                    </button>
                    {LABEL_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => { setLabelFilter(labelFilter === opt.value ? null : opt.value); setShowLabelFilter(false) }}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                          background: labelFilter === opt.value ? 'var(--bg-hover, #f3f4f6)' : 'transparent',
                          border: 'none', cursor: 'pointer', padding: '5px 12px',
                          fontSize: 12, color: 'var(--text-secondary)', textAlign: 'left',
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-hover, #f3f4f6)'}
                        onMouseLeave={(e) => e.currentTarget.style.background = labelFilter === opt.value ? 'var(--bg-hover, #f3f4f6)' : 'transparent'}
                      >
                        <span style={{ width: 10, height: 10, borderRadius: '50%', background: LABEL_COLORS[opt.value], flexShrink: 0 }} />
                        <span>{labelNames[opt.value] || opt.label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <Tooltip text="搜索任务">
              <button
                onClick={() => { setShowSearch((v) => !v); if (showSearch) setSearchQuery('') }}
                style={{
                background: 'none',
                border: 'none',
                color: showSearch ? 'var(--text-primary)' : 'var(--text-secondary)',
                cursor: 'pointer',
                fontSize: 14,
                lineHeight: 1,
                padding: '2px 4px',
                borderRadius: 4,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"/>
                <line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
            </button>
            </Tooltip>
            <Tooltip text="新任务">
              <button
                type="button"
                data-weworker-new-work="true"
                onClick={handleCreateWork}
                style={{
                WebkitAppRegion: 'no-drag',
                background: 'none',
                border: 'none',
                color: 'var(--text-secondary)',
                cursor: 'pointer',
                fontSize: 20,
                lineHeight: 1,
                padding: '2px 4px',
                borderRadius: 4,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text-primary)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-secondary)')}
            >
              +
            </button>
            </Tooltip>
            <Tooltip text="收起侧边栏">
              <button
                onClick={onCollapse}
                aria-label="收起侧边栏"
                style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-secondary)',
                cursor: 'pointer',
                fontSize: 14,
                lineHeight: 1,
                padding: '2px 4px',
                borderRadius: 4,
                display: 'flex',
                alignItems: 'center',
              }}
              onMouseEnter={(e) => e.currentTarget.style.color = 'var(--text-primary)'}
              onMouseLeave={(e) => e.currentTarget.style.color = 'var(--text-secondary)'}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                <line x1="9" y1="3" x2="9" y2="21"/>
              </svg>
            </button>
            </Tooltip>
          </div>
        </div>
        {showSearch && (
          <div style={{ padding: '0 8px 4px', WebkitAppRegion: 'no-drag' }}>
            <input
              autoFocus
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索标题或 ID..."
              style={{
                width: '100%',
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                color: 'var(--text-primary)',
                fontSize: 12,
                padding: '5px 8px',
                outline: 'none',
                fontFamily: 'inherit',
                boxSizing: 'border-box',
              }}
              onKeyDown={(e) => { if (e.key === 'Escape') { setShowSearch(false); setSearchQuery('') } }}
            />
          </div>
        )}
        <div style={{ flex: 1, overflowY: 'auto', WebkitAppRegion: 'no-drag' }}>
          <WorksList searchQuery={searchQuery} />
        </div>
      </div>

      {/* Divider */}
      <div style={{ borderTop: '1px solid var(--border)' }} />

      {/* 定时任务 section */}
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <div style={{
          padding: '8px 12px 4px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          WebkitAppRegion: 'no-drag',
        }}>
          <button
            type="button"
            onClick={handleOpenTasksSection}
            style={{
              ...sidebarSectionButtonStyle,
              color: tasksSectionActive ? 'var(--text-primary)' : 'var(--text-muted)',
            }}
          >
            <ScheduledNavIcon size={13} />
            <span>定时任务</span>
          </button>
          <Tooltip text="新定时任务">
            <button
              onClick={handleCreateTask}
              style={{
              WebkitAppRegion: 'no-drag',
              background: 'none',
              border: 'none',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: 20,
              lineHeight: 1,
              padding: '2px 4px',
              borderRadius: 4,
            }}
            onMouseEnter={(e) => (e.target.style.color = 'var(--text-primary)')}
            onMouseLeave={(e) => (e.target.style.color = 'var(--text-secondary)')}
          >
            +
          </button>
          </Tooltip>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', WebkitAppRegion: 'no-drag' }}>
          <ScheduledTasksList />
        </div>
      </div>

      {/* Bottom bar */}
      <div style={{
        borderTop: '1px solid var(--border)',
        padding: '8px 12px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        WebkitAppRegion: 'no-drag',
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <StatusBar />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <UpdatePrompt />
          <Tooltip text="设置">
            <button
              onClick={onOpenSettings}
              style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              padding: '4px',
              display: 'flex',
              alignItems: 'center',
            }}
            onMouseEnter={(e) => e.currentTarget.style.color = 'var(--text-primary)'}
            onMouseLeave={(e) => e.currentTarget.style.color = 'var(--text-muted)'}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}

function ToolPackageNavIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7.5 12 3l8 4.5-8 4.5-8-4.5Z" />
      <path d="M4 12.5 12 17l8-4.5" />
      <path d="M4 17.5 12 22l8-4.5" />
    </svg>
  )
}

function ExplorationNavIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
      <path d="M8 11h6M11 8v6" />
    </svg>
  )
}

function WorksNavIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <path d="M8 8h8" />
      <path d="M8 12h5" />
    </svg>
  )
}

function ScheduledNavIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}

const sidebarSectionButtonStyle = {
  border: 'none',
  background: 'none',
  padding: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  WebkitAppRegion: 'no-drag',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 11,
  fontWeight: 600,
  textAlign: 'left',
}
