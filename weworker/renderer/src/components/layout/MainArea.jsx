import React from 'react'
import { useWorksStore } from '../../store/works.js'
import { useScheduledTasksStore } from '../../store/scheduled-tasks.js'
import ChatView from '../chat/ChatView.jsx'
import WelcomeScreen from '../welcome/WelcomeScreen.jsx'
import ChatBottomDock from '../chat/ChatBottomDock.jsx'
import MainWorkspaceShell from './MainWorkspaceShell.jsx'
import TaskConfigView from '../scheduled/TaskConfigView.jsx'
import ToolPackagePage from '../welcome/ToolPackagePage.jsx'
import { useSettingsStore } from '../../store/settings.js'
import { resolveStyleId } from '../../store/styles.js'
import { useChatInputFillStore } from '../../store/chat-input-fill.js'
import { useChatDraft } from '../../store/chat-drafts.js'
import { useToolPackagePageStore } from '../../store/tool-package-page.js'
import { useExplorationPageStore } from '../../store/exploration-page.js'
import ExplorationPage from '../exploration/ExplorationPage.jsx'
import WebsiteExplorationPage from '../website-exploration/WebsiteExplorationPage.jsx'
import { useWebsiteExplorationStore } from '../../store/website-exploration.js'
import DedicatedAgentsPage from '../dedicated-agents/DedicatedAgentsPage.jsx'
import { useDedicatedAgentsStore } from '../../store/dedicated-agents.js'
import { requestChatWarmup } from '../../api/backend.js'
import { buildOpenWarmupRequest } from '../../utils/chat-warmup.js'
import { scheduledTasksPageState } from '../../utils/scheduled-tasks-view.js'

export default function MainArea({ onOpenSettings, sidebarWidth, activeSidebarSection, compactLayout = false }) {
  const activeWorkId = useWorksStore((s) => s.activeWorkId)
  const createWork = useWorksStore((s) => s.createWork)
  const activeTaskId = useScheduledTasksStore((s) => s.activeTaskId)
  const tasksStatus = useScheduledTasksStore((s) => s.tasksStatus)
  const loadTasks = useScheduledTasksStore((s) => s.loadTasks)
  const toolPackageOpen = useToolPackagePageStore((s) => s.open)
  const explorationOpen = useExplorationPageStore((s) => s.open)
  const websiteOpen = useWebsiteExplorationStore((s) => s.open)
  const dedicatedAgentsOpen = useDedicatedAgentsStore((s) => s.open)
  const closeExplorationPage = useExplorationPageStore((s) => s.closePage)
  const closeToolPackagePage = useToolPackagePageStore((s) => s.closePage)
  const { inputText, setInputText, attachments, setAttachments } = useChatDraft('welcome')
  const maxChatAttachments = useSettingsStore((s) => s.maxChatAttachments)
  const zcfDefaultRole = useSettingsStore((s) => s.zcfDefaultRole)
  const zcfCustomRoles = useSettingsStore((s) => s.zcfCustomRoles)
  const fillSeq = useChatInputFillStore((s) => s.seq)
  const fillText = useChatInputFillStore((s) => s.text)
  const handledFillSeqRef = React.useRef(fillSeq)
  const tasksPageState = scheduledTasksPageState(
    activeWorkId || toolPackageOpen || explorationOpen ? null : activeSidebarSection,
    activeTaskId,
    tasksStatus,
  )

  // 已删除风格的残留 id（历史 auto-plan 等）在这里回落到仍可选的风格。
  const styleId = React.useMemo(
    () => resolveStyleId(zcfDefaultRole, zcfCustomRoles),
    [zcfDefaultRole, zcfCustomRoles],
  )

  React.useEffect(() => {
    if (fillSeq <= handledFillSeqRef.current) return
    handledFillSeqRef.current = fillSeq
    if (!activeWorkId && !activeTaskId) {
      setInputText(fillText)
    }
  }, [activeTaskId, activeWorkId, fillSeq, fillText, setInputText])

  React.useEffect(() => {
    if (activeWorkId || activeTaskId || activeSidebarSection === 'tasks' || websiteOpen || dedicatedAgentsOpen || toolPackageOpen || explorationOpen) return
    const request = buildOpenWarmupRequest(null, undefined, styleId)
    requestChatWarmup(request.workId, request.payload)
  }, [activeWorkId, activeTaskId, activeSidebarSection, websiteOpen, dedicatedAgentsOpen, toolPackageOpen, explorationOpen, styleId])

  const handleSendFromWelcome = async (text, files = [], thinkingEffort = 'off', permissionMode = 'workspace') => {
    setInputText('')
    setAttachments([])
    closeToolPackagePage()
    useWorksStore.setState({ pendingMessage: text, pendingAttachments: files, pendingThinkingEffort: thinkingEffort, pendingPermissionMode: permissionMode })
    await createWork({ styleId })
  }

  const handleShellCommandFromWelcome = async (command, originalText = '') => {
    const trimmed = String(command || '').trim()
    if (!trimmed) return
    setInputText('')
    setAttachments([])
    closeToolPackagePage()
    useWorksStore.setState({
      pendingShellCommand: {
        command: trimmed,
        originalText: originalText || `!${trimmed}`,
      },
    })
    await createWork({ styleId })
  }

  const handleFillInput = (text) => {
    setInputText(text)
  }

  if (websiteOpen) {
    return <MainWorkspaceShell><WebsiteExplorationPage onOpenSettings={onOpenSettings} /></MainWorkspaceShell>
  }

  if (dedicatedAgentsOpen) {
    return (
      <MainWorkspaceShell>
        <DedicatedAgentsPage sidebarWidth={sidebarWidth} compactLayout={compactLayout} />
      </MainWorkspaceShell>
    )
  }

  if (tasksPageState === 'loading' || tasksPageState === 'empty' || tasksPageState === 'error') {
    return (
      <MainWorkspaceShell>
        <section
          aria-labelledby="scheduled-tasks-empty-title"
          data-testid="scheduled-tasks-page"
          style={{
            flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', padding: 32,
            textAlign: 'center', color: 'var(--text-secondary)',
          }}
        >
          <div
            aria-hidden="true"
            style={{
              width: 56, height: 56, borderRadius: 18, display: 'grid',
              placeItems: 'center', marginBottom: 18,
              color: 'var(--accent)', background: 'var(--bg-secondary)',
            }}
          >
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
          </div>
          <h1 id="scheduled-tasks-empty-title" style={{ margin: 0, color: 'var(--text-primary)', fontSize: 20, fontWeight: 600 }}>
            {tasksPageState === 'loading' ? '正在加载定时任务…' : tasksPageState === 'error' ? '定时任务加载失败' : '暂无定时任务'}
          </h1>
          {tasksPageState === 'empty' ? (
            <p style={{ maxWidth: 360, margin: '10px 0 0', fontSize: 13, lineHeight: 1.7 }}>
              点击左侧定时任务列表旁的“+”，创建并配置你的第一个任务。
            </p>
          ) : tasksPageState === 'error' ? (
            <>
              <p style={{ margin: '10px 0 0', fontSize: 13 }}>请检查服务连接后重试。</p>
              <button data-app-button="action"
                type="button"
                onClick={() => { void loadTasks() }}
                style={{ marginTop: 16, padding: '7px 14px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', cursor: 'pointer' }}
              >
                重新加载
              </button>
            </>
          ) : null}
        </section>
      </MainWorkspaceShell>
    )
  }

  if (activeWorkId) {
    return (
      <MainWorkspaceShell>
        <ChatView key={activeWorkId} workId={activeWorkId} />
      </MainWorkspaceShell>
    )
  }

  if (activeTaskId) {
    return (
      <MainWorkspaceShell>
        <TaskConfigView taskId={activeTaskId} />
      </MainWorkspaceShell>
    )
  }

  if (toolPackageOpen) {
    return (
      <MainWorkspaceShell>
        <ToolPackagePage onClose={closeToolPackagePage} />
      </MainWorkspaceShell>
    )
  }

  if (explorationOpen) {
    return (
      <MainWorkspaceShell>
        <ExplorationPage onClose={closeExplorationPage} />
      </MainWorkspaceShell>
    )
  }

  return (
    <MainWorkspaceShell>
      <WelcomeScreen onFillInput={handleFillInput} />
      <ChatBottomDock
        onSend={handleSendFromWelcome}
        onShellCommand={handleShellCommandFromWelcome}
        text={inputText}
        onTextChange={setInputText}
        attachments={attachments}
        onAttachmentsChange={setAttachments}
        maxAttachments={maxChatAttachments}
        // Welcome screen has no work yet; the Backend pre-warms with the same
        // style handleSendFromWelcome will persist into the new work.
        onWarmup={(thinkingEffort) => requestChatWarmup(null, { thinkingEffort, styleId })}
      />
    </MainWorkspaceShell>
  )
}
