import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import ChatView from '../chat/ChatView.jsx'
import FileChangesCard from '../chat/FileChangesCard.jsx'
import { useFileChangesStore } from '../../store/file-changes.js'
import { useUserFilesStore } from '../../store/user-files.js'
import WorkspaceToolbar from '../layout/WorkspaceToolbar.jsx'
import { formatConversationAge } from '../../utils/conversation-age.js'
import { explorationDevelopmentPermissionSettings } from '../../utils/chat-permission-preferences.js'
import { useWorksStore } from '../../store/works.js'
import { useMessageQueueStore } from '../../store/message-queue.js'
import { FormOutlined, SettingOutlined } from '@ant-design/icons'
import * as api from '../../api/website-exploration-api.js'
import { continueWebsiteExploration, finishExplorationTransfer, rememberDevelopmentSession, startDevelopmentSession, useWebsiteExplorationStore as useStore } from '../../store/website-exploration.js'
import { useExplorationDevelopmentHandoffsStore } from '../../store/exploration-development-handoffs.js'
import { explorationComposerMode, explorationControls, explorationEntryId, isExplorationInProgress, isExplorationUrl, shouldSubmitExploration, sortExplorations } from '../../utils/exploration-chat.js'
import { ErrorMessage, RequiredMark, ScrollArea, Status, useAction, useDraft, useSnapshot } from './shared.jsx'
import { AttachmentTray } from '../chat/InputBar.jsx'
import { useSettingsStore } from '../../store/settings.js'
import { getPathsFromPasteEvent, mergeAttachmentPaths } from '../../utils/clipboard-files.js'
import ExplorationModelSelector from './ExplorationModelSelector.jsx'
import { TrashIcon } from '../icons/PanelIcons.jsx'
import { showConfirm } from '../../store/dialog.js'
import ExplorationStep, { ExplorationStatus } from './ExplorationStep.jsx'

const EMPTY_ATTACHMENTS = []

export default function ExploreWorkspace({ disabled, globalBusy, modelReady = true, activeExplorationId = '', activityReady = true, sidebarWidth = 260, sidebarCollapsed = false, onSidebarResizeStart, toolbar, serviceActions, notices }) {
  const key = 'site'
  const context = useStore(s => s.explorationContext)
  // null: resolve entry from fresh activity; '': new exploration; ID: explicit record.
  // Do not restore the previous visit's historical selection as the landing page.
  const [currentId, setCurrentId] = useState(context ? '' : null)
  useLayoutEffect(() => {
    useUserFilesStore.getState().setWorkspaceContext(null, null, currentId ? `website-exploration:${currentId}` : 'website-exploration')
  }, [currentId])
  const [submitting, setSubmitting] = useState(false)
  const [renamedTitles, setRenamedTitles] = useState({})
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => { if (context) setCurrentId('') }, [context])
  useEffect(() => useStore.subscribe((state, previous) => {
    const selected = state.selections[key + '/exploration']
    if (selected !== previous.selections[key + '/exploration']) setCurrentId(selected || '')
  }), [])
  const list = useSnapshot(() => api.listExplorations(), [key])
  const developments = useSnapshot(() => api.listDevelopmentChats(), [])
  const sessions = useExplorationDevelopmentHandoffsStore(s => s.sessions)
  const removedExplorations = useExplorationDevelopmentHandoffsStore(s => s.removedExplorations)
  const streaming = useWorksStore(s => s.streamingWorkIds)
  const queues = useMessageQueueStore(s => s.queues)
  useEffect(() => {
    for (const session of developments.data || []) void rememberDevelopmentSession(session)
  }, [developments.data])
  const developingIds = new Set(Object.values(sessions).filter(s => streaming.has(s.work.id) || queues[s.work.id]?.running || (!queues[s.work.id]?.pausedReason && queues[s.work.id]?.items.length)).map(s => s.explorationId))
  // Development remains usable when the exploration process is unavailable.
  // Host-owned work metadata is enough to reopen the chat; never fabricate evidence.
  const availableRecords = [...(list.data || [])]
  for (const session of Object.values(sessions)) {
    if (!availableRecords.some(item => item.exploration_id === session.explorationId)) {
      availableRecords.push({ exploration_id: session.explorationId, title: session.work.title, created_at: new Date(session.work.created_at).toLocaleString('zh-CN', { hour12: false }), created_at_timestamp: Date.parse(session.work.created_at), status: 'succeeded' })
    }
  }
  const records = sortExplorations(availableRecords.filter(item => !removedExplorations[item.exploration_id]).map(item =>
    renamedTitles[item.exploration_id] ? { ...item, title: renamedTitles[item.exploration_id] } : item), activeExplorationId, developingIds)
  useEffect(() => {
    // Wait for both snapshots so a slower activity response cannot redirect a
    // user who has already started typing or explicitly opened a history item.
    if (currentId === null && activityReady && !list.loading && !developments.loading) {
      setCurrentId(explorationEntryId(list.data, activeExplorationId) || [...developingIds][0] || '')
    }
  }, [currentId, activityReady, list.loading, list.data, activeExplorationId, developments.loading, sessions])
  const showNew = currentId === ''
  const onCreated = id => {
    useStore.getState().selectRecord(key + '/exploration', id)
    setCurrentId(id)
    useStore.setState({ explorationContext: null })
    void list.refresh()
  }
  const renderHeader = (title, status) => <ExplorationHeader title={title} status={status} toolbar={toolbar} serviceActions={serviceActions} notices={notices} />
  const renameRecord = async (id, title) => {
    const saved = await api.renameExploration(id, title)
    setRenamedTitles(previous => ({ ...previous, [id]: saved.title }))
    void list.refresh()
  }
  const deleteRecord = async id => {
    await api.deleteExploration(id)
    useExplorationDevelopmentHandoffsStore.getState().forget(id)
    useStore.setState(state => ({
      drafts: Object.fromEntries(Object.entries(state.drafts).filter(([name]) => !name.startsWith(id + '/'))),
      selections: state.selections[key + '/exploration'] === id ? { ...state.selections, [key + '/exploration']: '' } : state.selections,
    }))
    setCurrentId(selected => selected === id ? '' : selected)
    void list.refresh()
    void developments.refresh()
  }
  return <div className="wx-explore">
    <aside className="wx-history workspace-sidebar" aria-label="探索记录" style={{ width: sidebarWidth, minWidth: sidebarWidth, display: sidebarCollapsed ? 'none' : undefined }}>
      <button type="button" className="sidebar-new-chat sidebar-conversation-action" title="新探索" aria-label="新探索" disabled={submitting} onClick={() => { useStore.setState({ explorationContext: null }); setCurrentId('') }}>
        <FormOutlined aria-hidden="true" /><span>新探索</span>
      </button>
      <header className="sidebar-conversation-header"><span className="sidebar-workspaces-label">探索记录</span></header>
      <div className="wx-history-records" aria-busy={list.loading || developments.loading}>
      <ErrorMessage>{list.error || developments.error}</ErrorMessage>
      {records.map(item => <ExplorationRecord key={item.exploration_id} item={item} now={now} selected={!showNew && currentId === item.exploration_id}
        inProgress={isExplorationInProgress(item, activeExplorationId, developingIds)} generating={developingIds.has(item.exploration_id)} disabled={submitting}
        onRename={title => renameRecord(item.exploration_id, title)} onDelete={() => deleteRecord(item.exploration_id)}
        onSelect={() => { useStore.getState().selectRecord(key + '/exploration', item.exploration_id); useStore.setState({ explorationContext: null }); setCurrentId(item.exploration_id) }} />)}
      {!list.loading && !developments.loading && !list.error && !developments.error && !records.length && <p className="wx-history-empty">没有探索记录</p>}
      </div>
    </aside>
    {!sidebarCollapsed && onSidebarResizeStart && <div className="wx-sidebar-resize" role="separator" aria-orientation="vertical" aria-label="调整探索记录列表宽度" onMouseDown={onSidebarResizeStart} />}
    <main className="wx-conversation workspace-canvas">
    {showNew ? <NewExploration key={context ? context.toolkitId + '/' + context.tool.tool_id : 'site'} context={context} disabled={disabled || globalBusy || !modelReady} modelDisabled={globalBusy} onCreated={onCreated} onBusyChange={setSubmitting} renderHeader={renderHeader} />
      : currentId ? <ExplorationDetail key={currentId} id={currentId} title={records.find(item => item.exploration_id === currentId)?.title} developmentReady={!developments.loading && !developments.error} disabled={disabled} globalBusy={globalBusy} modelReady={modelReady} onBusyChange={setSubmitting} renderHeader={renderHeader} />
        : <section className="wx-detail" aria-busy="true">{renderHeader('Adapter工坊')}</section>}
    </main>
  </div>
}

export function ExplorationHeader({ title, status, toolbar, serviceActions, notices }) {
  const context = <div className="wx-heading">
    <div className="wx-heading-title"><span className="chat-heading__title" title={title}>{title}</span>{status}</div>
    {serviceActions}
  </div>
  return <>
    {toolbar ? React.cloneElement(toolbar, { context, label: '网站探索工具栏' }) : <WorkspaceToolbar context={context} label="网站探索工具栏" />}
    {notices && <div className="wx-notices">{notices}</div>}
  </>
}

export function ExplorationRecord({ item, selected = false, inProgress = false, generating = false, disabled = false, onSelect, onRename, onDelete, now = Date.now() }) {
  const title = item.title || item.instruction || item.created_at || '探索'
  const timestamp = Date.parse(item.updated_at) || item.created_at_timestamp || Date.parse(item.created_at)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const input = useRef(null)
  const row = useRef(null)
  const pending = useRef(false)
  const cancelled = useRef(false)
  useEffect(() => { if (editing) { input.current?.focus(); input.current?.select() } }, [editing])
  const finishEditing = () => { cancelled.current = true; setEditing(false); row.current?.focus() }
  const save = async () => {
    if (cancelled.current || pending.current) return
    const nextTitle = value.trim()
    if (!nextTitle || nextTitle === title) { finishEditing(); return }
    pending.current = true; setBusy(true); setError('')
    try { await onRename(nextTitle); finishEditing() }
    catch (e) { setError(e.message || '重命名失败，请重试') }
    finally { pending.current = false; setBusy(false) }
  }
  const remove = async () => {
    if (pending.current || inProgress) return
    pending.current = true; setBusy(true); setError('')
    try {
      if (await showConfirm(`确定删除探索记录“${title}”吗？已生成的适配器会保留。`, '删除探索记录', { danger: true, dismissible: false })) await onDelete()
    } catch (e) { setError(e.message || '删除失败，请重试') }
    finally { pending.current = false; setBusy(false) }
  }
  return <><div ref={row} role="button" tabIndex={disabled || editing ? -1 : 0} className={'wx-record work-list-item' + (selected ? ' is-active' : '') + (inProgress ? ' is-in-progress' : '') + (editing ? ' is-renaming' : '')}
    aria-current={selected ? 'true' : undefined} aria-disabled={disabled || undefined} onClick={() => { if (!disabled && !editing && !busy) onSelect?.() }} onKeyDown={event => {
      if (event.target !== event.currentTarget || editing || disabled || busy) return
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect?.() }
    }}>
    {inProgress && <span className="wx-status wx-record-progress" role="img" aria-label={generating ? '生成中' : '探索中'} title={generating ? '生成中' : '探索中'}><SettingOutlined className="wx-record-progress-gear" aria-hidden="true" /></span>}
    <span className="work-list-item__title">{editing ? <input ref={input} className="wx-record-title-input" aria-label="探索记录标题" maxLength={200} value={value} disabled={busy} onChange={event => setValue(event.target.value)} onClick={event => event.stopPropagation()} onBlur={save} onKeyDown={event => {
      event.stopPropagation()
      if (event.nativeEvent.isComposing) return
      if (event.key === 'Enter') { event.preventDefault(); void save() }
      if (event.key === 'Escape' && !pending.current) { event.preventDefault(); finishEditing() }
    }} /> : title}</span>
    {!editing && Number.isFinite(timestamp) && <time className="work-list-item__time" dateTime={new Date(timestamp).toISOString()}>{formatConversationAge(timestamp, now)}</time>}
    {!editing && <span className="sidebar-row-actions">
      <button type="button" className="sidebar-row-action work-item-action" title="重命名" aria-label={`重命名 ${title}`} disabled={disabled || busy || !onRename} onClick={event => {
        event.stopPropagation(); cancelled.current = false; setValue(title); setError(''); setEditing(true)
      }}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg></button>
      <button type="button" className="sidebar-row-action work-item-action" title={inProgress ? '正在执行，请停止后再删除' : '删除'} aria-label={`删除 ${title}`} disabled={disabled || busy || inProgress || !onDelete} onClick={event => { event.stopPropagation(); void remove() }}><TrashIcon size={13} /></button>
    </span>}
  </div><ErrorMessage>{error}</ErrorMessage></>
}

export function ExplorationComposer({ value, onChange, onAction, inputRef, conversationId, draftModelKey, onModelReadyChange, actionMode = 'send', disabled = false, actionDisabled = false, modelDisabled = false, attachments = EMPTY_ATTACHMENTS, onAttachmentsChange, usage, placeholder = '发送消息，补充探索目标或要求…', children }) {
  const internalInput = useRef(null)
  const input = inputRef || internalInput
  const maxAttachments = useSettingsStore(s => s.maxChatAttachments)
  const attachmentLimit = Math.max(1, Number(maxAttachments) || 60)
  const [notice, setNotice] = useState('')
  const [modelPending, setModelPending] = useState(false)
  const [modelReady, setModelReady] = useState(false)
  const modelReadyChanged = useCallback(ready => { setModelReady(ready); onModelReadyChange?.(ready) }, [onModelReadyChange])
  const attachmentsRef = useRef(attachments)
  attachmentsRef.current = attachments
  const attach = paths => {
    if (disabled || !paths?.length) return
    const next = mergeAttachmentPaths(attachmentsRef.current, paths, attachmentLimit)
    onAttachmentsChange?.(next.attachments); setNotice(next.notice)
  }
  const upload = async () => {
    try { attach(await window.electronAPI?.selectFiles?.()) }
    catch { setNotice('文件选择失败，请重试') }
  }
  const paste = async event => {
    const paths = getPathsFromPasteEvent(event)
    if (paths.length) { event.preventDefault(); attach(paths); return }
    if (Array.from(event.clipboardData?.items || []).some(item => item.type.startsWith('image/'))) {
      event.preventDefault()
      try { const image = await window.electronAPI?.saveClipboardImage?.(); if (image?.path) attach([image.path]) }
      catch { setNotice('剪切板图片添加失败') }
    }
  }
  const stopping = actionMode === 'stop'
  const actionLabel = stopping ? '停止探索' : '发送消息'
  const blocked = disabled || actionDisabled || (!stopping && (!modelReady || modelPending || attachments.length > attachmentLimit))
  useEffect(() => {
    if (!input.current) return
    input.current.style.height = 'auto'
    input.current.style.height = Math.min(input.current.scrollHeight, 180) + 'px'
  }, [value, input])
  return <div className="wx-chat-composer chat-input-composer">
    <div className="chat-input-surface wx-chat-input" data-exploration-file-drop="true" onDragOver={e => { if (Array.from(e.dataTransfer?.types || []).includes('Files')) e.preventDefault() }} onDrop={e => {
      if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return
      e.preventDefault(); e.stopPropagation()
      const nativePaths = window.electronAPI?.getLastDroppedFilePaths?.() || []
      const files = nativePaths.length ? nativePaths : Array.from(e.dataTransfer?.files || []).map(file => file.path || window.electronAPI?.getPathForFile?.(file)).filter(Boolean)
      attach(files)
    }}>
      {(attachments.length > 0 || notice) && <div className="wx-composer-attachments"><AttachmentTray attachments={attachments} maxAttachments={attachmentLimit} notice={notice} disabled={disabled} onRemove={index => { onAttachmentsChange?.(attachments.filter((_, i) => i !== index)); setNotice('') }} /></div>}
      <textarea ref={input} rows={1} aria-label="探索消息" value={value} disabled={disabled} onPaste={paste} onChange={e => onChange(e.target.value)} placeholder={placeholder} onKeyDown={e => {
        if (shouldSubmitExploration(e, actionMode)) { e.preventDefault(); if (!blocked) onAction() }
      }} />
      <div className="chat-input-toolbar wx-chat-toolbar">
        <button type="button" className="chat-input-upload" aria-label="上传文件" title="上传文件" disabled={disabled || !onAttachmentsChange} onClick={upload}><span>+</span></button>
        <ExplorationModelSelector conversationId={conversationId} draftModelKey={draftModelKey} usage={usage} disabled={disabled || modelDisabled || stopping} onPendingChange={setModelPending} onReadyChange={modelReadyChanged}>
          {children}
          <button type="button" className={'chat-input-action wx-chat-send ' + (stopping ? 'chat-input-action-stop' : 'chat-input-action-send')} aria-label={actionLabel} title={actionLabel} disabled={blocked} onClick={onAction} />
        </ExplorationModelSelector>
      </div>
    </div>
  </div>
}

function NewExploration({ context, disabled, modelDisabled, onCreated, onBusyChange, renderHeader }) {
  const composerInput = useRef(null)
  const tool = context?.tool
  const draftKey = tool ? context.toolkitId + '/' + tool.tool_id + '/new' : 'site/new/instruction'
  const [url, setUrl] = useDraft('site/new/url')
  const [instruction, setInstruction] = useDraft(draftKey)
  const [attachments, setAttachments] = useDraft(draftKey + '/attachments', EMPTY_ATTACHMENTS)
  const [modelSelection, setModelSelection] = useDraft(draftKey + '/model', null)
  const [target, setTarget] = useState(null)
  const [targets, setTargets] = useState([])
  const action = useAction()
  const startAction = useAction()
  const busy = action.busy || startAction.busy
  const startUrl = tool?.start_url || url
  const valid = isExplorationUrl(startUrl)
  const canSubmit = valid && !disabled && !busy && (!tool || Boolean(target))
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false) }, [busy, onBusyChange])
  const submit = () => {
    if (!canSubmit) return
    void startAction.run(async () => {
      const created = tool
        ? await api.createExploration(context.toolkitId, tool.tool_id, instruction, target.target_id, attachments, modelSelection)
        : await api.createSiteExploration({ start_url: startUrl.trim(), instruction, model_selection: modelSelection, ...(attachments.length ? { attachments } : {}) })
      setInstruction('')
      setAttachments([])
      setModelSelection(null)
      if (!tool) setUrl('')
      onCreated(created.exploration_id)
    })
  }
  return <section className="wx-detail wx-chat-detail">
    {renderHeader('新探索')}
    <div className="wx-scroll wx-new-conversation">
      <article className="wx-chat-message wx-chat-assistant wx-message-content">
        <div className="user-choice-block wx-url-question" role="group" aria-labelledby="wx-start-question">
          <div className="user-choice-block__question" id="wx-start-question">{tool ? '请确认本次探索的起始网址，并选择已准备好的页面。' : '你想从哪里开始探索?'}</div>
          <div className="user-choice-block__options">
            <label className="wx-url-answer"><span className="user-choice-block__option-label">起始网址<RequiredMark /></span>
              <input autoFocus={!tool} type="url" required aria-label="起始网址" aria-describedby="wx-url-help" aria-invalid={Boolean(startUrl && !valid)} value={startUrl} readOnly={Boolean(tool)} disabled={busy} placeholder="https://example.com" onChange={e => setUrl(e.target.value)} onKeyDown={e => { if (shouldSubmitExploration(e)) { e.preventDefault(); if (valid && !busy) composerInput.current?.focus() } }} />
              <span className="user-choice-block__option-desc" id="wx-url-help">{startUrl && !valid ? '请输入有效的 http:// 或 https:// 网址，不要包含账号密码。' : tool ? '确认目标页面后，在下方输入探索目标并发送。' : '填写网址后，在下方输入探索目标并发送即可开始。'}</span>
            </label>
          </div>
          {tool && <p>{tool.goal}</p>}
          {tool && <div className="wx-actions">
            <button type="button" data-app-button="action" disabled={disabled || busy} onClick={() => action.run(async () => {
              setTarget(null); setTargets([])
              const match = await api.matchBrowser(startUrl, context.toolkitId, tool.tool_id)
              if (!match.targets?.length) throw new Error('未找到允许域名内的页面，请在 Agent 浏览器中打开起始网址，或修改 Adapter 允许域名后重新检测')
              setTargets(match.targets); setTarget(match.target)
            })}>检测目标页面</button>
          </div>}
          {targets.length > 0 && <label>探索页面<select value={target?.target_id || ''} disabled={busy || disabled} onChange={e => setTarget(targets.find(item => item.target_id === e.target.value) || null)}>
            <option value="" disabled>请选择要探索的页面</option>
            {targets.map(item => <option key={item.target_id} value={item.target_id}>{item.title ? item.title + ' — ' : ''}{item.url}</option>)}
          </select></label>}
          {target && <p className="wx-url">当前页面：{target.url}</p>}
        </div>
        <ErrorMessage>{startAction.error || action.error}</ErrorMessage>
      </article>
    </div>
    <ExplorationComposer draftModelKey={draftKey + '/model'} inputRef={composerInput} value={instruction} onChange={setInstruction} onAction={submit} attachments={attachments} onAttachmentsChange={setAttachments} actionMode={explorationComposerMode(undefined, startAction.busy)} disabled={busy} modelDisabled={modelDisabled} actionDisabled={!canSubmit} placeholder="告诉我你想在这个网站上干什么" />
  </section>
}

export function ExplorationControls({ replayActive = false, cancelReplayDisabled = true, onCancelReplay }) {
  if (!replayActive) return null
  return <button type="button" className="wx-chat-control" title="停止当前回放" disabled={cancelReplayDisabled} onClick={onCancelReplay}>停止回放</button>
}

export function CompletionQuestion({ submitted = false, developing = false, developDisabled = false, continueDisabled = false, onDevelop, onContinue }) {
  const questionId = useId()
  if (submitted) return <div className="user-choice-block wx-completion-question" role="status">
    <div className="user-choice-block__question">探索任务已完成，本次探索结果可生成可复用的网站适配器，以便下次直接操作网站。是否分析探索结果并生成网站适配器？</div>
    <div className="user-choice-block__answered">是，生成网站适配器</div>
  </div>
  return <div className="user-choice-block wx-completion-question" role="group" aria-labelledby={questionId}>
    <div className="user-choice-block__question" id={questionId}>探索任务已完成，本次探索结果可生成可复用的网站适配器，以便下次直接操作网站。是否分析探索结果并生成网站适配器？</div>
    {developing ? <div className="user-choice-block__answered">是，生成网站适配器</div> : <div className="user-choice-block__options">
      <button type="button" className="user-choice-block__option" disabled={developDisabled} onClick={onDevelop}>
        <span className="user-choice-block__option-label">是，生成网站适配器</span>
        <span className="user-choice-block__option-desc">分析本次探索结果，复用或完善已有网站适配器，必要时生成新的适配器。</span>
      </button>
      <button type="button" className="user-choice-block__option" disabled={continueDisabled} onClick={onContinue}>
        <span className="user-choice-block__option-label">否，还需要进一步探索</span>
        <span className="user-choice-block__option-desc">按输入框中的补充要求继续；未填写时，继续探索尚未覆盖的功能。</span>
      </button>
    </div>}
  </div>
}

export function BrowserConfirmation({ issue, disabled, onOpen, onContinue }) {
  if (issue?.type !== 'browser_confirmation_required') return null
  return <article className="wx-chat-message wx-chat-assistant" role="status">
    <h3>需要在浏览器中确认</h3>
    <p>{issue.message}</p>
    <button type="button" className="wx-quiet" disabled={disabled} onClick={onOpen}>打开浏览器</button>
    <button type="button" className="wx-quiet" disabled={disabled} onClick={onContinue}>已处理，继续探索</button>
  </article>
}

export function UserIntervention({ issue, disabled, onOpen, onContinue }) {
  if (issue?.type !== 'user_takeover_required') return null
  const needsInput = issue.mode === 'input'
  return <article className="wx-chat-message wx-chat-assistant" role="status">
    <h3>{needsInput ? '需要你补充信息' : '需要你处理'}</h3>
    <p>{issue.message}</p>
    <p className="wx-muted">探索已暂停。{needsInput ? '请在下方输入框补充信息，发送后继续探索。' : '请在浏览器中处理后继续，也可以在下方补充信息。'}</p>
    {!needsInput && <>
      <button type="button" className="wx-quiet" disabled={disabled} onClick={onOpen}>打开当前页面</button>
      <button type="button" className="wx-quiet" disabled={disabled} onClick={onContinue}>我已处理，继续探索</button>
    </>}
  </article>
}

function ExplorationDetail({ id, title, developmentReady, disabled, globalBusy, modelReady, onBusyChange, renderHeader }) {
  useEffect(() => () => {
    const panel = useFileChangesStore.getState()
    if (panel.scope === 'exploration' && panel.workId === id) panel.closePanel()
  }, [id])
  const [sessionModelReady, setSessionModelReady] = useState(false)
  const sessions = useExplorationDevelopmentHandoffsStore(s => s.sessions)
  const [historyWorkId, setHistoryWorkId] = useState(null)
  const snapshot = useSnapshot(() => api.getExploration(id), [id], '/api/explorations/' + id + '/events')
  const transferAction = useAction()
  const transferBusy = transferAction.busy
  useEffect(() => { onBusyChange(transferBusy); return () => onBusyChange(false) }, [transferBusy, onBusyChange])
  const action = useAction(snapshot.refresh)
  const messageAction = useAction(snapshot.refresh)
  const [prompt, setPrompt] = useDraft(id + '/prompt')
  const [attachments, setAttachments] = useDraft(id + '/attachments', EMPTY_ATTACHMENTS)
  const [replayId] = useDraft(id + '/replay')
  const replay = useSnapshot(() => replayId ? api.request('/api/replays/' + replayId) : Promise.resolve(null), [replayId], replayId ? '/api/replays/' + replayId + '/events' : undefined)
  const replayAction = useAction(replay.refresh)
  const rounds = Object.values(sessions).filter(s => s.explorationId === id)
  const lastDevelopment = rounds.at(-1)
  const data = snapshot.data || (snapshot.error && lastDevelopment ? {
    title: lastDevelopment.work.title, last_run_id: lastDevelopment.runId, status: 'succeeded', timeline: [],
  } : null)
  const development = rounds.find(s => s.work.id === historyWorkId) || rounds.find(s => s.runId === (data?.last_run_id ?? null))
  useEffect(() => {
    useStore.setState({ activeDevelopmentWorkId: development?.work.id ?? null })
    return () => useStore.setState({ activeDevelopmentWorkId: null })
  }, [development?.work.id])
  const developmentQueue = useMessageQueueStore(s => s.queues[development?.work.id])
  const developmentMessages = useWorksStore(s => s.messages[development?.work.id])
  // Recover a prepared-but-unsent work without silently executing tools merely
  // because its history was opened. The explicit retry keeps the same work.
  const needsStart = development?.needsInitialMessage && !developmentMessages?.length
    && !developmentQueue?.running && !developmentQueue?.items.length
  if (!data) return <section className="wx-detail" aria-busy={snapshot.loading}>{renderHeader(title || '网站探索')}<ErrorMessage>{snapshot.error}</ErrorMessage></section>
  const replayActive = Boolean(replayId && (!replay.data || !['succeeded', 'failed', 'cancelled', 'stopped'].includes(replay.data.status)))
  const controls = explorationControls({ ...data, disabled, busy: action.busy || messageAction.busy || replayAction.busy || transferBusy, globalBusy, modelReady: modelReady && sessionModelReady, replayActive })
  const actionMode = explorationComposerMode(data.status, messageAction.busy)
  const transferring = transferBusy
  const submitted = Boolean(development)
  const developDisabled = !developmentReady || submitted || disabled || globalBusy || action.busy || messageAction.busy || transferBusy || replayActive
  const sendMessage = content => {
    if (!controls.canSend || (!content.trim() && !attachments.length)) return
    void messageAction.run(async () => {
      await continueWebsiteExploration(id, content, controls.resumable, attachments)
      setPrompt('')
      setAttachments([])
    })
  }
  const explorationMessages = <>
      {snapshot.data && <article className="wx-chat-message wx-chat-user"><div className="wx-user-bubble"><p className="wx-url">{data.start_url}</p><p>{data.instruction || '请探索这个网站的主要功能。'}</p><ExplorationAttachments files={data.attachments} /></div></article>}
      {(data.timeline || []).map((item, index) => item.type === 'agent_step' ? <ExplorationStep key={item.id || 'step-' + (item.step ?? index)} item={item} />
        : <article className={'wx-chat-message ' + (item.type === 'user' ? 'wx-chat-user' : 'wx-chat-assistant')} key={'message-' + index}><div className={item.type === 'user' ? 'wx-user-bubble' : ''}><p>{item.content}</p><ExplorationAttachments files={item.attachments} /></div></article>)}
      {snapshot.data && <FileChangesCard scope="exploration" workId={id} streaming={isExplorationInProgress(data)} revision={`${data.status}:${data.timeline?.length || 0}`} />}
      {!snapshot.data && <p className="wx-muted" role="status">探索记录暂不可用，仍可继续生成网站适配器。</p>}
      {data.status === 'succeeded' && <article className="wx-chat-message wx-chat-assistant">
        <CompletionQuestion submitted={submitted} developing={transferring} developDisabled={developDisabled} continueDisabled={!controls.canSend}
          onDevelop={() => { if (!developDisabled) void transferAction.run(() => finishExplorationTransfer({ explorationId: id, runId: data.last_run_id ?? null })) }}
          onContinue={() => sendMessage(prompt.trim() || '继续探索这个网站，进一步了解尚未覆盖的功能和操作流程。')} />
      </article>}
      {development && <div className="wx-development-transition" role="status">{needsStart ? '网站适配器生成已准备，尚未发送。' : '网站适配器生成'}</div>}
      {needsStart && <button type="button" className="wx-quiet" disabled={transferBusy} onClick={() => transferAction.run(() => startDevelopmentSession(development))}>继续生成网站适配器</button>}
      {rounds.length > 0 && (!development || rounds.length > 1 || historyWorkId) && <details className="wx-development-rounds"><summary>网站适配器生成（{rounds.length}）</summary>{rounds.map((round, index) => <button key={round.work.id} type="button" className="wx-quiet" onClick={() => setHistoryWorkId(round.work.id)} aria-pressed={development?.work.id === round.work.id}>第 {index + 1} 次生成</button>)}{historyWorkId && <button type="button" className="wx-quiet" onClick={() => setHistoryWorkId(null)}>返回当前探索</button>}</details>}
      {data.active_issue?.type === 'browser_confirmation_required'
        ? <BrowserConfirmation issue={data.active_issue} disabled={!controls.canSend}
          onOpen={() => action.run(() => api.openExplorationBrowser(id))}
          onContinue={() => sendMessage(prompt.trim() || '我已处理浏览器提示，网站可以正常打开，请继续探索。')} />
        : data.active_issue?.type === 'user_takeover_required'
          ? <UserIntervention issue={data.active_issue} disabled={!controls.canSend}
            onOpen={() => action.run(() => api.openExplorationBrowser(id))}
            onContinue={() => sendMessage(prompt.trim() || '我已处理好，请先检查当前页面，再继续探索。')} />
          : data.active_issue?.message && <p className={data.active_issue.type === 'failed' ? 'wx-error' : 'wx-muted'} role="status">{data.active_issue.message}</p>}
      {replayId && <div className="wx-replay-status" role="status">回放 <Status value={replay.data?.status} /></div>}
      <ErrorMessage>{snapshot.error || messageAction.error || action.error || transferAction.error || replay.error || replayAction.error}</ErrorMessage>
    </>
  return <section className="wx-detail wx-chat-detail">
    {renderHeader(title || data.title || '网站探索', development ? <span className="wx-status">网站适配器生成</span> : <ExplorationStatus value={data.status} />)}
    {development ? <ChatView key={development.work.id} workId={development.work.id} embedded hidePermissionMode {...explorationDevelopmentPermissionSettings(development.work.id)} historyPrefix={<div className="wx-development-context">{explorationMessages}</div>} /> : <>
    <ScrollArea name={id} revision={JSON.stringify([data.status, data.timeline, transferring, submitted])}><div className="wx-message-content">{explorationMessages}</div></ScrollArea>
    <ExplorationComposer conversationId={id} onModelReadyChange={setSessionModelReady} value={prompt} onChange={setPrompt} actionMode={actionMode}
      attachments={attachments} onAttachmentsChange={setAttachments} usage={data.context_usage} modelDisabled={globalBusy}
      onAction={actionMode === 'stop' ? () => action.run(() => api.stopExploration(id)) : () => sendMessage(prompt)}
      actionDisabled={actionMode === 'stop' ? !controls.canStop : !controls.canSend || (!prompt.trim() && !attachments.length)} disabled={action.busy || messageAction.busy || transferBusy}
      hint={data.status === 'cancel_requested' ? '正在停止探索…' : actionMode === 'stop' ? '点击右侧按钮停止探索' : 'Enter 发送 · Shift + Enter 换行'}>
      <ExplorationControls replayActive={replayActive} cancelReplayDisabled={disabled || action.busy || messageAction.busy || replayAction.busy || transferBusy || !replay.data || replay.data.status === 'cancel_requested'}
        onCancelReplay={() => replayAction.run(() => api.request('/api/replays/' + replayId + '/cancel', { method: 'POST' }))} />
    </ExplorationComposer>
    </>}
  </section>
}

function ExplorationAttachments({ files = [] }) {
  if (!files.length) return null
  return <div className="wx-message-attachments">{files.map((file, index) => <span key={file.path || index} className="chat-attachment">{file.name}</span>)}</div>
}
