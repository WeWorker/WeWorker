import React, { useEffect, useState, useRef, useCallback } from 'react'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import Sidebar from './components/layout/Sidebar.jsx'
import MainArea from './components/layout/MainArea.jsx'
import SettingsModal from './components/settings/SettingsModal.jsx'
import Tooltip from './components/Tooltip.jsx'
import CapabilitiesToggleButton from './components/capabilities/CapabilitiesToggleButton.jsx'
import GlobalFileDropLayer from './components/files/GlobalFileDropLayer.jsx'
import NativeTitleTooltipLayer from './components/NativeTitleTooltipLayer.jsx'
import { FolderIcon } from './components/icons/PanelIcons.jsx'
import { useCapabilitiesPanelStore } from './store/capabilities-panel.js'
import { useWorksStore } from './store/works.js'
import { useStatusStore } from './store/status.js'
import { useSettingsStore } from './store/settings.js'
import { useZcfStore } from './store/zcf.js'
import { useScheduledTasksStore } from './store/scheduled-tasks.js'
import { useUserFilesStore } from './store/user-files.js'
import { useTerminalStore } from './store/terminal.js'
import { useToolPackagePageStore } from './store/tool-package-page.js'
import { useExplorationPageStore } from './store/exploration-page.js'
import { useWebsiteExplorationStore } from './store/website-exploration.js'
import { WebsiteExplorationGuard } from './components/website-exploration/WebsiteExplorationPage.jsx'
import { useAntdThemeConfig } from './theme/antd-theme.js'
import { streamBackendEvents } from './api/http.js'


function getInitialTheme() {
  const saved = localStorage.getItem('theme')
  if (saved) return saved
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export default function App() {
  const [showSettings, setShowSettings] = useState(false)
  const [theme, setTheme] = useState(getInitialTheme)
  const themeSwitchTimerRef = useRef(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [appVersion, setAppVersion] = useState('')

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
    return saved ? Number(saved) : 240
  })
  const SIDEBAR_MIN = 180
  const SIDEBAR_MAX = 480
  const draggingRef = useRef(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)
  const loadWorks = useWorksStore((s) => s.loadWorks)
  const createWork = useWorksStore((s) => s.createWork)
  const loadSettings = useSettingsStore((s) => s.load)
  const loadZcfCatalog = useZcfStore((s) => s.loadCatalog)
  const poll = useStatusStore((s) => s.poll)
  const toggleUserFilesPanel = useUserFilesStore((s) => s.togglePanel)
  const userFilesOpen = useUserFilesStore((s) => s.open)
  const toolPackageOpen = useToolPackagePageStore((s) => s.open)
  const explorationOpen = useExplorationPageStore((s) => s.open)
  const websiteOpen = useWebsiteExplorationStore((s) => s.open)
  const focusedWorkspaceOpen = toolPackageOpen || explorationOpen || websiteOpen

  useEffect(() => {
    if (!websiteOpen) return
    useToolPackagePageStore.getState().closePage()
    useExplorationPageStore.getState().closePage()
    useWorksStore.setState({ activeWorkId: null })
    useScheduledTasksStore.setState({ activeTaskId: null })
    useUserFilesStore.getState().closePanel?.()
    useCapabilitiesPanelStore.getState().closePanel?.()
  }, [websiteOpen])

  useEffect(() => window.electronAPI?.onWebsiteExplorationOpen?.(() => useWebsiteExplorationStore.setState({ open: true })), [])

  useEffect(() => {
    loadWorks()
    loadSettings().then(() => loadZcfCatalog())
    poll()
    const interval = setInterval(poll, 3000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    document.documentElement.classList.remove('dark', 'light')
    document.documentElement.classList.add(theme)
    localStorage.setItem('theme', theme)
  }, [theme])

  // 放在主题 class effect 之后声明：切换时先应用 class，再解析 CSS 变量为 antd token。
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
    useCapabilitiesPanelStore.getState().closePanel()
    useTerminalStore.getState().closePanel()
    toggleUserFilesPanel()
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      {/* Full-width title bar — draggable, contains app title + theme toggle */}
      <div style={{
        height: 38,
        minHeight: 38,
        WebkitAppRegion: 'drag',
        background: 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        paddingLeft: 80, /* leave room for macOS traffic lights */
        paddingRight: 12,
        justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', userSelect: 'none', gap: 8 }}>
          {sidebarCollapsed && (
            <>
              <Tooltip text="展开侧边栏">
                <button
                  onClick={() => setSidebarCollapsed(false)}
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
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                    <line x1="9" y1="3" x2="9" y2="21"/>
                  </svg>
                </button>
              </Tooltip>
              <Tooltip text="新任务">
                <button
                  onClick={createWork}
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
        {!focusedWorkspaceOpen && (
        <Tooltip text={userFilesOpen ? '收起用户目录' : '打开用户目录'}>
          <button
            type="button"
            onClick={handleToggleUserFilesPanel}
            aria-label={userFilesOpen ? '收起用户目录' : '打开用户目录'}
            aria-pressed={userFilesOpen}
            style={{
              width: 28,
              height: 28,
              background: userFilesOpen ? 'var(--bg-hover)' : 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '4px',
              borderRadius: 4,
              color: userFilesOpen ? 'var(--accent)' : 'var(--text-secondary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <FolderIcon size={16} />
          </button>
        </Tooltip>
        )}
        <Tooltip text={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}>
          <button
            onClick={toggleTheme}
            className={`app-theme-toggle app-theme-toggle--${theme}`}
            aria-label={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
          >
            <span key={theme} className="app-theme-toggle__icon" aria-hidden="true">
              {theme === 'dark' ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="5" />
                  <line x1="12" y1="1" x2="12" y2="3" />
                  <line x1="12" y1="21" x2="12" y2="23" />
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                  <line x1="1" y1="12" x2="3" y2="12" />
                  <line x1="21" y1="12" x2="23" y2="12" />
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              )}
            </span>
          </button>
        </Tooltip>
        {!focusedWorkspaceOpen && <CapabilitiesToggleButton variant="titlebar" />}
        </div>
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <Sidebar onOpenSettings={() => setShowSettings(true)} collapsed={sidebarCollapsed} onCollapse={() => setSidebarCollapsed(true)} width={sidebarWidth} />
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
        <MainArea onOpenSettings={() => setShowSettings(true)} />
      </div>
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      <GlobalFileDropLayer />
      <WebsiteExplorationGuard />
      <NativeTitleTooltipLayer />
    </div>
    </ConfigProvider>
  )
}
