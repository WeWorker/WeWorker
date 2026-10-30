import React, { useEffect, useState, useRef } from 'react'
import { CloseOutlined, FormOutlined, FolderOpenOutlined, FolderOutlined } from '@ant-design/icons'
import TablerFolderPlusIcon, { TablerPlusIcon } from '../icons/TablerFolderPlusIcon.jsx'
import WorksList, { LABEL_COLORS, LABEL_OPTIONS } from '../sidebar/WorksList.jsx'
import ScheduledTasksList from '../sidebar/ScheduledTasksList.jsx'
import Tooltip from '../Tooltip.jsx'
import { useWorksStore } from '../../store/works.js'
import { useScheduledTasksStore } from '../../store/scheduled-tasks.js'
import { useToolPackagePageStore } from '../../store/tool-package-page.js'
import { useExplorationPageStore } from '../../store/exploration-page.js'
import { leaveWebsiteExploration } from '../../store/website-exploration.js'
import { showAlert } from '../../store/dialog.js'
import { useSettingsStore } from '../../store/settings.js'

export default function Sidebar({ section, collapsed, width }) {
  const createWork = useWorksStore((s) => s.createWork)
  const createProject = useWorksStore((s) => s.createProject)
  const loadWorks = useWorksStore((s) => s.loadWorks)
  const createTask = useScheduledTasksStore((s) => s.createTask)
  const loadTasks = useScheduledTasksStore((s) => s.loadTasks)
  const userDirectory = useSettingsStore((s) => s.userDirectory)
  const [searchQuery, setSearchQuery] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [showProjectDialog, setShowProjectDialog] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [projectFolderPath, setProjectFolderPath] = useState('')
  const projectNameInputRef = useRef(null)
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

  useEffect(() => {
    if (!showProjectDialog || !projectNameInputRef.current) return
    projectNameInputRef.current.focus()
    projectNameInputRef.current.select()
  }, [showProjectDialog])

  const handleCreateTask = async () => {
    if (!await leaveWebsiteExploration()) return
    useExplorationPageStore.getState().closePage()
    useToolPackagePageStore.getState().closePage()
    const task = await createTask({
      title: '新定时任务',
      cron_expression: '0 * * * *',
      prompt_template: '',
      enabled: true,
    })
    if (!task) showAlert('创建定时任务失败，请确认后端服务已启动后重试')
  }

  const handleCreateWork = async () => {
    if (!await leaveWebsiteExploration()) return
    useExplorationPageStore.getState().closePage()
    useToolPackagePageStore.getState().closePage()
    await createWork({ forceNew: true, projectId: null })
  }

  const handleCreateProject = async () => {
    if (!await leaveWebsiteExploration()) return
    useExplorationPageStore.getState().closePage()
    useToolPackagePageStore.getState().closePage()
    setProjectName('')
    setProjectFolderPath('')
    setShowProjectDialog(true)
  }

  const submitCreateProject = async () => {
    const name = projectName.trim()
    if (!name || !projectFolderPath) return
    try {
      const project = await createProject(name, projectFolderPath)
      setShowProjectDialog(false)
      await createWork({ forceNew: true, projectId: project.id })
    } catch (error) {
      showAlert(error instanceof Error ? error.message : '创建项目失败，请稍后重试')
    }
  }

  const selectProjectFolder = async () => {
    const paths = await window.electronAPI?.selectDirectory?.({ defaultPath: userDirectory || undefined })
    if (paths?.[0]) setProjectFolderPath(paths[0])
  }

  const handleOpenWorksSection = async () => {
    if (!await leaveWebsiteExploration()) return
    useExplorationPageStore.getState().closePage()
    useToolPackagePageStore.getState().closePage()
    useScheduledTasksStore.setState({ activeTaskId: null })
    // 从专属 Agent 或其他入口返回时，确保主对话侧栏包含最新项目/会话。
    await loadWorks()
  }

  const handleOpenTasksSection = async () => {
    if (!await leaveWebsiteExploration()) return
    useExplorationPageStore.getState().closePage()
    useToolPackagePageStore.getState().closePage()
    useWorksStore.setState({ activeWorkId: null })
    const state = useScheduledTasksStore.getState()
    if (!state.activeTaskId && state.tasks[0]?.id) state.selectTask(state.tasks[0].id)
  }


  return (
    <>
    <div className="workspace-sidebar" style={{
      width: collapsed ? 0 : width,
      minWidth: collapsed ? 0 : width,
      borderRightWidth: collapsed ? 0 : undefined,
      visibility: collapsed ? 'hidden' : 'visible',
      background: 'var(--bg-secondary)',
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      WebkitAppRegion: 'drag',
      overflow: 'hidden',
      transition: 'width 0.2s ease, min-width 0.2s ease',
    }}>
      {section === 'conversation' && (
      <div className="sidebar-task-section" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <button
          type="button"
          className="sidebar-new-chat sidebar-conversation-action"
          data-weworker-new-work="true"
          onClick={handleCreateWork}
        >
          <FormOutlined aria-hidden="true" />
          <span>新对话</span>
        </button>
        <div className="sidebar-conversation-header" style={{
          padding: '10px 12px 4px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          position: 'relative',
          WebkitAppRegion: 'no-drag',
        }}>
          <button
            type="button"
            onClick={handleOpenWorksSection}
            className="sidebar-section-heading sidebar-conversation-action"
          >
            <WorksNavIcon size={13} />
            <span>对话</span>
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, WebkitAppRegion: 'no-drag' }}>
            {/* Label filter — only visible when there are labeled works or a filter is active */}
            {(hasLabeled || labelFilter) && (
              <div ref={labelFilterRef} style={{ position: 'relative' }}>
              <Tooltip text="按标记筛选">
                <button
                  type="button"
                  className="sidebar-icon-button"
                  aria-label="按标记筛选"
                  onClick={() => setShowLabelFilter((v) => !v)}
                  style={labelFilter ? { color: LABEL_COLORS[labelFilter] } : undefined}
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
                    boxShadow: 'none',
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
            <Tooltip text="搜索对话">
              <button
                type="button"
                className={`sidebar-icon-button${showSearch ? ' is-active' : ''}`}
                aria-label="搜索对话"
                aria-expanded={showSearch}
                onClick={() => { setShowSearch((v) => !v); if (showSearch) setSearchQuery('') }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"/>
                <line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
            </button>
            </Tooltip>
              <Tooltip text="新项目">
                <button
                  type="button"
                  className="sidebar-new-project sidebar-icon-button"
                  aria-label="新项目"
                  onClick={handleCreateProject}
                >
                  <TablerFolderPlusIcon />
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
      )}

      {section === 'tasks' && (
      <div className="sidebar-scheduled-section" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <div className="sidebar-section-header">
          <button
            type="button"
            onClick={handleOpenTasksSection}
            className="sidebar-section-heading sidebar-section-label"
          >
            <ScheduledNavIcon size={13} />
            <span>定时任务</span>
          </button>
          <Tooltip text="新定时任务">
            <button
              type="button"
              className="sidebar-icon-button"
              aria-label="新定时任务"
              onClick={handleCreateTask}
          >
            <TablerPlusIcon />
          </button>
          </Tooltip>
        </div>
      <div style={{ flex: 1, overflowY: 'auto', WebkitAppRegion: 'no-drag' }}>
          <ScheduledTasksList />
        </div>
      </div>
      )}
    </div>
    {showProjectDialog && (
      <div
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) setShowProjectDialog(false)
        }}
        className="project-create-overlay"
      >
        <form
          role="dialog"
          aria-modal="true"
          aria-label="新建项目"
          onSubmit={(event) => { event.preventDefault(); submitCreateProject() }}
          className="project-create-dialog"
        >
          <header className="project-create-dialog__header">
            <h2>新建项目</h2>
            <button type="button" onClick={() => setShowProjectDialog(false)} aria-label="关闭" className="project-create-dialog__close">
              <CloseOutlined />
            </button>
          </header>
          <label className="project-create-name-field">
            <span aria-hidden="true"><FolderOutlined /></span>
            <input
              ref={projectNameInputRef}
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Escape') setShowProjectDialog(false) }}
              placeholder="项目名称"
              aria-label="项目名称"
            />
          </label>
          <section className="project-create-sources">
            <h3>源文件夹</h3>
            <div className={`project-create-folder-box${projectFolderPath ? ' has-folder' : ''}`}>
              {projectFolderPath ? (
                <div className="project-create-selected-folder">
                  <FolderOpenOutlined aria-hidden="true" />
                  <div className="project-create-selected-folder__path">
                    <strong>{projectFolderPath.split(/[\\/]/).filter(Boolean).pop() || projectFolderPath}</strong>
                    <span title={projectFolderPath}>{projectFolderPath}</span>
                  </div>
                  <button type="button" data-app-button="action" onClick={selectProjectFolder} className="project-create-secondary-button">更换</button>
                </div>
              ) : (
                <>
                  <span className="project-create-folder-prompt">添加此电脑上的文件夹</span>
                  <button type="button" data-app-button="action" onClick={selectProjectFolder} className="project-create-secondary-button">
                    <TablerFolderPlusIcon size={15} /> 添加文件夹
                  </button>
                </>
              )}
            </div>
          </section>
          <footer className="project-create-dialog__footer">
            <button data-app-button="action" type="button" onClick={() => setShowProjectDialog(false)} className="project-create-secondary-button">取消</button>
            <button
              data-app-button="action"
              type="submit"
              disabled={!projectName.trim() || !projectFolderPath}
              className="project-create-primary-button"
            >
              创建项目
            </button>
          </footer>
        </form>
      </div>
    )}
    </>
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
