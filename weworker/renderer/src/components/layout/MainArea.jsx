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
import { useZcfStore, normalizeZcfModeId } from '../../store/zcf.js'
import { useChatInputFillStore } from '../../store/chat-input-fill.js'
import { useToolPackagePageStore } from '../../store/tool-package-page.js'
import { useExplorationPageStore } from '../../store/exploration-page.js'
import ExplorationPage from '../exploration/ExplorationPage.jsx'
import WebsiteExplorationPage from '../website-exploration/WebsiteExplorationPage.jsx'
import { useWebsiteExplorationStore } from '../../store/website-exploration.js'

export default function MainArea({ onOpenSettings }) {
  const activeWorkId = useWorksStore((s) => s.activeWorkId)
  const createWork = useWorksStore((s) => s.createWork)
  const activeTaskId = useScheduledTasksStore((s) => s.activeTaskId)
  const toolPackageOpen = useToolPackagePageStore((s) => s.open)
  const explorationOpen = useExplorationPageStore((s) => s.open)
  const websiteOpen = useWebsiteExplorationStore((s) => s.open)
  const closeExplorationPage = useExplorationPageStore((s) => s.closePage)
  const closeToolPackagePage = useToolPackagePageStore((s) => s.closePage)
  const [inputText, setInputText] = React.useState('')
  const [attachments, setAttachments] = React.useState([])
  const [zcfNotice, setZcfNotice] = React.useState('')
  const maxChatAttachments = useSettingsStore((s) => s.maxChatAttachments)
  const zcfDefaultRole = useSettingsStore((s) => s.zcfDefaultRole)
  const zcfDefaultMode = useSettingsStore((s) => s.zcfDefaultMode)
  const saveZcfDefaults = useSettingsStore((s) => s.saveZcfDefaults)
  const roleLabel = useZcfStore((s) => s.roleLabel)
  const modeLabel = useZcfStore((s) => s.modeLabel)
  const zcfRoles = useZcfStore((s) => s.roles)
  const zcfModes = useZcfStore((s) => s.modes)
  const resolvePickerRole = useZcfStore((s) => s.resolvePickerRole)
  const zcfRole = React.useMemo(
    () => resolvePickerRole(zcfDefaultRole, zcfDefaultRole),
    [resolvePickerRole, zcfDefaultRole],
  )
  const fillSeq = useChatInputFillStore((s) => s.seq)
  const fillText = useChatInputFillStore((s) => s.text)

  React.useEffect(() => {
    if (fillSeq > 0 && !activeWorkId && !activeTaskId) {
      setInputText(fillText)
    }
  }, [activeTaskId, activeWorkId, fillSeq, fillText])

  const handleSendFromWelcome = async (text, files = []) => {
    setInputText('')
    setAttachments([])
    closeToolPackagePage()
    useWorksStore.setState({ pendingMessage: text, pendingAttachments: files })
    await createWork({ zcf_role: zcfDefaultRole, zcf_mode: zcfDefaultMode })
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
    await createWork({ zcf_role: zcfDefaultRole, zcf_mode: zcfDefaultMode })
  }

  const handleZcfRoleChange = async (roleId) => {
    try {
      await saveZcfDefaults({ zcfDefaultRole: roleId })
      setZcfNotice(`已切换风格为「${roleLabel(roleId)}」，新建任务将默认使用此风格`)
      window.setTimeout(() => setZcfNotice(''), 4000)
    } catch (e) {
      console.error('[welcome] save zcf role failed:', e)
    }
  }

  const handleZcfModeChange = async (modeId) => {
    try {
      await saveZcfDefaults({ zcfDefaultMode: modeId })
      setZcfNotice(`已切换模式为「${modeLabel(modeId)}」，新建任务将默认使用此模式`)
      window.setTimeout(() => setZcfNotice(''), 4000)
    } catch (e) {
      console.error('[welcome] save zcf mode failed:', e)
    }
  }

  const handleFillInput = (text) => {
    setInputText(text)
  }

  if (websiteOpen) {
    return <MainWorkspaceShell><WebsiteExplorationPage onOpenSettings={onOpenSettings} /></MainWorkspaceShell>
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
      {zcfNotice && (
        <div style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 132,
          zIndex: 31,
          padding: '8px 20px',
          color: 'var(--accent)',
          fontSize: 12,
          background: 'color-mix(in srgb, var(--accent) 10%, transparent)',
          pointerEvents: 'none',
        }}>
          {zcfNotice}
        </div>
      )}
      <ChatBottomDock
        onSend={handleSendFromWelcome}
        onShellCommand={handleShellCommandFromWelcome}
        text={inputText}
        onTextChange={setInputText}
        attachments={attachments}
        onAttachmentsChange={setAttachments}
        maxAttachments={maxChatAttachments}
        zcfRole={zcfRole}
        zcfMode={normalizeZcfModeId(zcfDefaultMode)}
        zcfRoles={zcfRoles}
        zcfModes={zcfModes}
        onZcfRoleChange={handleZcfRoleChange}
        onZcfModeChange={handleZcfModeChange}
      />
    </MainWorkspaceShell>
  )
}
