import React, { useEffect, useState, useRef, useCallback } from 'react'
import { ConfigProvider } from 'antd'
import { MinusOutlined, BorderOutlined, CloseOutlined } from '@ant-design/icons'
import { RestoreWindowIcon } from './components/icons/PanelIcons'
import zhCN from 'antd/locale/zh_CN'
import Sidebar from './components/layout/Sidebar.jsx'
import AppRail from './components/layout/AppRail.jsx'
import MainArea from './components/layout/MainArea.jsx'
import SettingsPage from './components/settings/SettingsModal.jsx'
import Tooltip from './components/Tooltip.jsx'
import CapabilitiesToggleButton from './components/capabilities/CapabilitiesToggleButton.jsx'
import GlobalFileDropLayer from './components/files/GlobalFileDropLayer.jsx'
import NativeTitleTooltipLayer from './components/NativeTitleTooltipLayer.jsx'
import DialogHost from './components/DialogHost.jsx'
import { FolderIcon } from './components/icons/PanelIcons.jsx'
import { useCapabilitiesPanelStore } from './store/capabilities-panel.js'
import { useWorksStore } from './store/works.js'
import { useStatusStore } from './store/status.js'
import { useSettingsStore } from './store/settings.js'
import { useScheduledTasksStore } from './store/scheduled-tasks.js'
import { useUserFilesStore } from './store/user-files.js'
import { useTerminalStore } from './store/terminal.js'
import { useToolPackagePageStore } from './store/tool-package-page.js'
import { useExplorationPageStore } from './store/exploration-page.js'
import { useWebsiteExplorationStore, leaveWebsiteExploration } from './store/website-exploration.js'
import { useDedicatedAgentsStore, showDedicatedAgentsPage } from './store/dedicated-agents.js'
import { useSitesStore } from './store/sites.js'
import { WebsiteExplorationGuard } from './components/website-exploration/WebsiteExplorationPage.jsx'
import ExtensionGuide from './components/ExtensionGuide.jsx'
import SiteLoginNotice from './components/site-login/SiteLoginNotice.jsx'
import UpdatePrompt from './components/sidebar/UpdatePrompt.jsx'
import InitialSetup from './components/onboarding/InitialSetup.jsx'
import { useAntdThemeConfig } from './theme/antd-theme.js'
import { streamBackendEvents } from './api/http.js'
import './workspace-theme.css'


function getInitialTheme() {
  const saved = localStorage.getItem('theme')
  if (saved) return saved
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export default function App() {
  const [showSettings, setShowSettings] = useState(false)
  const [activeSidebarSection, setActiveSidebarSection] = useState('conversation')
  const [theme, setTheme] = useState(getInitialTheme)
  const themeSwitchTimerRef = useRef(null)
  const handleOpenDedicatedAgentsRef = useRef(async () => {})
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [appVersion, setAppVersion] = useState('')
  const [showExtensionGuide, setShowExtensionGuide] = useState(false)
  const isMac = window.electronAPI?.platform === 'darwin'
  const [windowMaximized, setWindowMaximized] = useState(false)

  useEffect(() => {
    if (isMac) return undefined
    let active = true
    window.electronAPI?.isWindowMaximized?.().then((value) => { if (active) setWindowMaximized(value === true) })
    return () => { active = false }
  }, [isMac])

  useEffect(() => {
    if (isMac) return undefined
    return window.electronAPI?.onWindowMaximizedState?.((value) => setWindowMaximized(value === true))
  }, [isMac])

  useEffect(() => {
    window.electronAPI?.getVersion?.().then(v => setAppVersion(v || ''))
  }, [])

  useEffect(() => {
    return () => {
      if (themeSwitchTimerRef.current) window.clearTimeout(themeSwitchTimerRef.current)
      document.documentElement.classList.remove('theme-instant-switch')
    }
  }, [])

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem('sidebar_width')
    return saved ? Number(saved) : 264
  })
  const SIDEBAR_MIN = 180
  const SIDEBAR_MAX = 480
  const draggingRef = useRef(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)
  const loadWorks = useWorksStore((s) => s.loadWorks)
  const activeWorkId = useWorksStore((s) => s.activeWorkId)
  const createWork = useWorksStore((s) => s.createWork)
  const scheduledTasks = useScheduledTasksStore((s) => s.tasks)
  const activeTaskId = useScheduledTasksStore((s) => s.activeTaskId)
  const tasksStatus = useScheduledTasksStore((s) => s.tasksStatus)
  const loadSettings = useSettingsStore((s) => s.load)
  const settingsLoaded = useSettingsStore((s) => s.loaded)
  const settingsLoadError = useSettingsStore((s) => s.loadError)
  const onboardingCompleted = useSettingsStore((s) => s.onboardingCompleted)
  const poll = useStatusStore((s) => s.poll)
  const toggleUserFilesPanel = useUserFilesStore((s) => s.togglePanel)
  const userFilesOpen = useUserFilesStore((s) => s.open)
  const toolPackageOpen = useToolPackagePageStore((s) => s.open)
  const openToolPackagePage = useToolPackagePageStore((s) => s.openPage)

  const explorationOpen = useExplorationPageStore((s) => s.open)
  const websiteOpen = useWebsiteExplorationStore((s) => s.open)
  // The 专属 Agent page has its own agent and conversation lists, so it hides the main sidebar.
  const dedicatedAgentsOpen = useDedicatedAgentsStore((s) => s.open)
  const focusedWorkspaceOpen = toolPackageOpen || explorationOpen || websiteOpen || dedicatedAgentsOpen

  useEffect(() => {
    if (!websiteOpen) return
    useToolPackagePageStore.getState().closePage()
    useExplorationPageStore.getState().closePage()
    useWorksStore.setState({ activeWorkId: null })
    useScheduledTasksStore.setState({ activeTaskId: null })
    useUserFilesStore.getState().closePanel?.()
    useCapabilitiesPanelStore.getState().closePanel?.()
    useTerminalStore.getState().closePanel()
  }, [websiteOpen])

  useEffect(() => window.electronAPI?.onWebsiteExplorationOpen?.(() => {
    const settings = useSettingsStore.getState()
    if (!settings.loaded || !settings.onboardingCompleted) return
    useWebsiteExplorationStore.setState({ open: true })
  }), [])

  // Tray menu → 专属 Agent
  useEffect(() => window.electronAPI?.onOpenDedicatedAgents?.(() => { void handleOpenDedicatedAgentsRef.current() }), [])



  useEffect(() => {
    loadWorks()
    loadSettings()
    poll()
    const interval = setInterval(poll, 3000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (activeSidebarSection !== 'tasks' || focusedWorkspaceOpen || activeWorkId || tasksStatus !== 'ready' || activeTaskId || !scheduledTasks[0]?.id) return
    void useScheduledTasksStore.getState().selectTask(scheduledTasks[0].id)
  }, [activeSidebarSection, focusedWorkspaceOpen, activeWorkId, tasksStatus, activeTaskId, scheduledTasks])

  useEffect(() => {
    document.documentElement.classList.remove('dark', 'light')
    document.documentElement.classList.add(theme)
    localStorage.setItem('theme', theme)
  }, [theme])

  const antdThemeConfig = useAntdThemeConfig(theme)

  // SSE listener for task_notification and terminal events
  useEffect(() => {
    const controller = new AbortController()
    let retryTimer = 0
    const handleEvent = (data) => {
      try {
        const parsed = JSON.parse(data)
        if (parsed.type === 'terminal_event') {
          useTerminalStore.getState().handleTerminalEvent(parsed)
          useWorksStore.getState().handleTerminalEvent(parsed)
          return
        }
        if (parsed.type === 'memory_status' && parsed.workId) {
          useWorksStore.getState().setMemoryStatus(parsed.workId, parsed)
          return
        }
        if (parsed.type === 'adapter_state_changed') {
          useSitesStore.getState().refreshSites()
          return
        }
        if (parsed.type === 'works_changed') {
          useWorksStore.getState().loadWorks()
          return
        }
        if (parsed.type === 'title_update' && parsed.workId) {
          useWorksStore.getState().updateTitleLocal(parsed.workId, parsed.title)
          return
        }
        if (parsed.type !== 'task_notification') return

        const { taskId, taskTitle, workId, status, summary } = parsed.data

        // Show system notification via Electron Notification API
        const statusText = status === 'completed' ? '执行完成' : '执行失败'
        const notification = new Notification(taskTitle, {
          body: `${statusText}${summary ? ` — ${summary}` : ''}`,
        })

        // Click notification: bring window to foreground and navigate to the execution's chat
        notification.onclick = () => {
          window.focus()
          useWorksStore.getState().selectWork(workId)
        }

        // Refresh execution records if user is viewing this task
        const currentTaskId = useScheduledTasksStore.getState().activeTaskId
        if (currentTaskId === taskId) {
          useScheduledTasksStore.getState().loadExecutions(taskId)
        }

        // 刷新对话列表，让定时任务创建的 work 自动出现在侧边栏
        useWorksStore.getState().loadWorks()
      } catch {
        // Ignore malformed events
      }
    }
    const connect = () => {
      streamBackendEvents(handleEvent, controller.signal, () => {
        const userFiles = useUserFilesStore.getState()
        userFiles.clearRecoverableBackendError?.()
        if (userFiles.open && userFiles.error) userFiles.load()
      }).catch((error) => {
        if (controller.signal.aborted) return
        console.warn('[events] stream failed:', error)
        retryTimer = window.setTimeout(connect, 1500)
      })
    }
    connect()

    return () => {
      controller.abort()
      if (retryTimer) window.clearTimeout(retryTimer)
    }
  }, [])

  const toggleTheme = () => {
    const root = document.documentElement
    root.classList.add('theme-instant-switch')
    if (themeSwitchTimerRef.current) {
      window.clearTimeout(themeSwitchTimerRef.current)
    }
    setTheme(t => t === 'dark' ? 'light' : 'dark')
    themeSwitchTimerRef.current = window.setTimeout(() => {
      root.classList.remove('theme-instant-switch')
      themeSwitchTimerRef.current = null
    }, 90)
  }

  const handleToggleUserFilesPanel = () => {
    setShowSettings(false)
    useCapabilitiesPanelStore.getState().closePanel()
    useTerminalStore.getState().closePanel()
    toggleUserFilesPanel()
  }

  const handleOpenConversation = async () => {
    setShowSettings(false)
    if (!await leaveWebsiteExploration()) return
    useExplorationPageStore.getState().closePage()
    useDedicatedAgentsStore.getState().closePage()
    setActiveSidebarSection('conversation')
    // 专属 Agent 创建的项目/会话可能刚刚由后端写入，切回主对话时刷新列表。
    await loadWorks()
    useToolPackagePageStore.getState().closePage()
    useScheduledTasksStore.setState({ activeTaskId: null })
    useCapabilitiesPanelStore.getState().closePanel()
    useTerminalStore.getState().closePanel()
    useUserFilesStore.getState().closePanel()
    const state = useWorksStore.getState()
    if (!state.activeWorkId && state.works[0]?.id) {
      state.selectWork(state.works[0].id)
    }
  }

  const handleCompleteOnboarding = async (provider) => {
    await useSettingsStore.getState().completeOnboarding(provider)
    // Initialization always lands in the main conversation, even if another
    // page was requested while the setup screen covered the workspace.
    setShowSettings(false)
    setActiveSidebarSection('conversation')
    useDedicatedAgentsStore.getState().closePage()
    useExplorationPageStore.getState().closePage()
    useToolPackagePageStore.getState().closePage()
    useWebsiteExplorationStore.setState({ open: false })
    useScheduledTasksStore.setState({ activeTaskId: null })
    useWorksStore.setState({ activeWorkId: null })
    useCapabilitiesPanelStore.getState().closePanel()
    useTerminalStore.getState().closePanel()
    useUserFilesStore.getState().closePanel()
  }

  const handleOpenTasks = async () => {
    setShowSettings(false)
    if (!await leaveWebsiteExploration()) return
    useExplorationPageStore.getState().closePage()
    useDedicatedAgentsStore.getState().closePage()
    setActiveSidebarSection('tasks')
    useToolPackagePageStore.getState().closePage()
    useWorksStore.setState({ activeWorkId: null })
    useCapabilitiesPanelStore.getState().closePanel()
    useTerminalStore.getState().closePanel()
    useUserFilesStore.getState().closePanel()
    const state = useScheduledTasksStore.getState()
    if (state.tasks[0]?.id) state.selectTask(state.tasks[0].id)
  }

  const handleOpenSkills = async () => {
    setShowSettings(false)
    if (!await leaveWebsiteExploration()) return
    useExplorationPageStore.getState().closePage()
    useWorksStore.setState({ activeWorkId: null })
    useScheduledTasksStore.setState({ activeTaskId: null })
    useCapabilitiesPanelStore.getState().closePanel()
    useTerminalStore.getState().closePanel()
    useUserFilesStore.getState().closePanel()
    openToolPackagePage()
  }

  const handleOpenExploration = async () => {
    setShowSettings(false)
    if (!await leaveWebsiteExploration()) return
    useToolPackagePageStore.getState().closePage()
    useWorksStore.setState({ activeWorkId: null })
    useScheduledTasksStore.setState({ activeTaskId: null })
    useUserFilesStore.getState().closePanel()
    useCapabilitiesPanelStore.getState().closePanel()
    useTerminalStore.getState().closePanel()
    useExplorationPageStore.getState().openPage()
  }

  const handleOpenDedicatedAgents = async () => {
    const settings = useSettingsStore.getState()
    if (!settings.loaded || !settings.onboardingCompleted) return
    setShowSettings(false)
    if (!await showDedicatedAgentsPage()) return
    useUserFilesStore.getState().closePanel()
    useCapabilitiesPanelStore.getState().closePanel()
    useTerminalStore.getState().closePanel()
  }
  handleOpenDedicatedAgentsRef.current = handleOpenDedicatedAgents

  const handleOpenWebsiteExploration = async () => {
    setShowSettings(false)
    if (websiteOpen) return
    if (!await leaveWebsiteExploration()) return
    useToolPackagePageStore.getState().closePage()
    useExplorationPageStore.getState().closePage()
    useWorksStore.setState({ activeWorkId: null })
    useScheduledTasksStore.setState({ activeTaskId: null })
    useUserFilesStore.getState().closePanel()
    useCapabilitiesPanelStore.getState().closePanel()
    useTerminalStore.getState().closePanel()
    useWebsiteExplorationStore.setState({ open: true })
  }

  const onResizeStart = useCallback((e) => {
    e.preventDefault()
    draggingRef.current = true
    startXRef.current = e.clientX
    startWidthRef.current = sidebarWidth
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const onMove = (ev) => {
      if (!draggingRef.current) return
      const delta = ev.clientX - startXRef.current
      const newW = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startWidthRef.current + delta))
      setSidebarWidth(newW)
    }
    const onUp = () => {
      draggingRef.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      // persist
      setSidebarWidth((w) => { localStorage.setItem('sidebar_width', String(w)); return w })
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [sidebarWidth])

  return (
    <ConfigProvider locale={zhCN} theme={antdThemeConfig}>
    <div className="app-shell" style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      {/* Full-width title bar — draggable, contains app title + theme toggle */}
      <div className="app-titlebar" style={{
        height: 38,
        minHeight: 38,
        WebkitAppRegion: 'drag',
        background: 'var(--bg-secondary)',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        paddingLeft: isMac ? 80 : 12,
        paddingRight: isMac ? 12 : 0,
        justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', userSelect: 'none', gap: 8 }}>
          {settingsLoaded && onboardingCompleted && !showSettings && !focusedWorkspaceOpen && (
            <>
              <Tooltip text={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}>
                <button
                  type="button"
                  aria-label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
                  onClick={() => setSidebarCollapsed((current) => !current)}
                  style={{
                    WebkitAppRegion: 'no-drag',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '2px 4px',
                    borderRadius: 4,
                    color: 'var(--text-secondary)',
                    display: 'flex',
                    alignItems: 'center',
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.color = 'var(--text-primary)'}
                  onMouseLeave={(e) => e.currentTarget.style.color = 'var(--text-secondary)'}
                >
                  <svg
                    className={`app-sidebar-toggle-icon${sidebarCollapsed ? ' is-collapsed' : ''}`}
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    <line x1="9" y1="3" x2="9" y2="21" />
                    <polyline points="14 8 10 12 14 16" />
                  </svg>
                </button>
              </Tooltip>
              <Tooltip text="新对话">
                <button
                  type="button"
                  aria-label="新对话"
                  onClick={() => createWork({ forceNew: true, projectId: null })}
                  style={{
                    WebkitAppRegion: 'no-drag',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '2px 4px',
                    borderRadius: 4,
                    color: 'var(--text-secondary)',
                    display: 'flex',
                    alignItems: 'center',
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.color = 'var(--text-primary)'}
                  onMouseLeave={(e) => e.currentTarget.style.color = 'var(--text-secondary)'}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                    <line x1="12" y1="7" x2="12" y2="13"/>
                    <line x1="9" y1="10" x2="15" y2="10"/>
                  </svg>
                </button>
              </Tooltip>
            </>
          )}
          <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>WeWorker</span>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400, marginLeft: 2 }}>v{appVersion || ''}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, WebkitAppRegion: 'no-drag' }}>
        {settingsLoaded && onboardingCompleted && <UpdatePrompt />}
        {!isMac && (
          <div className="app-window-controls" aria-label="窗口控制">
            <button type="button" className="app-window-control" aria-label="最小化" onClick={() => window.electronAPI?.minimizeWindow?.()}>
              <MinusOutlined aria-hidden="true" />
            </button>
            <button type="button" className="app-window-control" aria-label={windowMaximized ? '还原窗口' : '最大化'} onClick={() => window.electronAPI?.toggleMaximizeWindow?.()}>
              {windowMaximized ? <RestoreWindowIcon size={12} /> : <BorderOutlined aria-hidden="true" />}
            </button>
            <button type="button" className="app-window-control app-window-control--close" aria-label="关闭窗口" onClick={() => window.electronAPI?.closeWindow?.()}>
              <CloseOutlined aria-hidden="true" />
            </button>
          </div>
        )}
        </div>
      </div>

      <div className="app-workspace" data-workspace-content style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {!settingsLoaded ? (
          <div className="initial-setup-loading" aria-label={settingsLoadError ? '初始化配置加载失败' : '正在加载初始化配置'}>
            {settingsLoadError ? <div role="alert">
              <p>{settingsLoadError}</p>
              <button type="button" className="btn btn-secondary" onClick={loadSettings}>重试</button>
            </div> : '正在加载…'}
          </div>
        ) : !onboardingCompleted ? (
          <InitialSetup onComplete={handleCompleteOnboarding} />
        ) : <>
        <AppRail
          extensionOpen={showExtensionGuide}
          activeSection={showSettings ? 'settings' : activeSidebarSection}
          settingsOpen={showSettings}
          onOpenConversation={handleOpenConversation}
          onOpenTasks={handleOpenTasks}
          onOpenSkills={handleOpenSkills}
          onOpenExploration={handleOpenExploration}
          onOpenWebsiteExploration={handleOpenWebsiteExploration}
          onOpenDedicatedAgents={handleOpenDedicatedAgents}
          onOpenExtension={() => { setShowSettings(false); setShowExtensionGuide(true) }}
          onOpenSettings={() => setShowSettings((current) => !current)}
        />
        {!showSettings && !focusedWorkspaceOpen && (
          <>
            <Sidebar section={activeSidebarSection} collapsed={sidebarCollapsed} width={sidebarWidth} />
            {!sidebarCollapsed && (
              <div
                onMouseDown={onResizeStart}
                style={{
                  width: 4,
                  cursor: 'col-resize',
                  flexShrink: 0,
                  background: 'transparent',
                  position: 'relative',
                  zIndex: 10,
                  marginLeft: -2,
                  marginRight: -2,
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'var(--accent)'}
                onMouseLeave={(e) => { if (!draggingRef.current) e.currentTarget.style.background = 'transparent' }}
              />
            )}
          </>
        )}
        <div className="app-main-column">
          {!showSettings && !focusedWorkspaceOpen && (
            <div className="workspace-toolbar" aria-label="工作区工具栏">
              <div id="workspace-toolbar-context" className="workspace-toolbar__context" />
              <div className="workspace-toolbar__actions">
                <Tooltip text={userFilesOpen ? '收起用户目录' : '打开用户目录'}>
                  <button
                    type="button"
                    onClick={handleToggleUserFilesPanel}
                    aria-label={userFilesOpen ? '收起用户目录' : '打开用户目录'}
                    aria-pressed={userFilesOpen}
                    className={`workspace-toolbar__button${userFilesOpen ? ' is-active' : ''}`}
                  >
                    <FolderIcon size={16} />
                  </button>
                </Tooltip>
                <Tooltip text={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}>
                  <button
                    type="button"
                    onClick={toggleTheme}
                    className={`workspace-toolbar__button app-theme-toggle app-theme-toggle--${theme}`}
                    aria-label={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
                  >
                    <span key={theme} className="app-theme-toggle__icon" aria-hidden="true">
                      {theme === 'dark' ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                        </svg>
                      ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
                      )}
                    </span>
                  </button>
                </Tooltip>
                <CapabilitiesToggleButton variant="titlebar" />
              </div>
            </div>
          )}
          {showSettings
            ? <SettingsPage onClose={() => setShowSettings(false)} />
            : <MainArea activeSidebarSection={activeSidebarSection} sidebarWidth={sidebarWidth} onOpenSettings={() => setShowSettings((current) => !current)} />}
        </div>
        </>}
      </div>
      {showExtensionGuide && <ExtensionGuide onClose={() => setShowExtensionGuide(false)} />}
      <SiteLoginNotice />
      <GlobalFileDropLayer />
      <WebsiteExplorationGuard />
      <NativeTitleTooltipLayer />
      <DialogHost />
    </div>
    </ConfigProvider>
  )
}
