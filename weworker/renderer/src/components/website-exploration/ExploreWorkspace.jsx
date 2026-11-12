import React, { useEffect, useId, useRef, useState } from 'react'
import ChatView from '../chat/ChatView.jsx'
import { explorationDevelopmentPermissionSettings } from '../../utils/chat-permission-preferences.js'
import { useWorksStore } from '../../store/works.js'
import { useMessageQueueStore } from '../../store/message-queue.js'
import { FormOutlined, SettingOutlined } from '@ant-design/icons'
import * as api from '../../api/website-exploration-api.js'
import { continueWebsiteExploration, finishExplorationTransfer, rememberDevelopmentSession, startDevelopmentSession, useWebsiteExplorationStore as useStore } from '../../store/website-exploration.js'
import { useExplorationDevelopmentHandoffsStore } from '../../store/exploration-development-handoffs.js'
import { explorationComposerMode, explorationControls, explorationEntryId, isExplorationInProgress, isExplorationUrl, shouldSubmitExploration, sortExplorations } from '../../utils/exploration-chat.js'
import { ErrorMessage, JsonView, RequiredMark, ResourceImage, ScrollArea, Status, useAction, useDraft, useSnapshot } from './shared.jsx'

export default function ExploreWorkspace({ disabled, globalBusy, modelReady = true, activeExplorationId = '', activityReady = true }) {
  const key = 'site'
  const context = useStore(s => s.explorationContext)
  // null: resolve entry from fresh activity; '': new exploration; ID: explicit record.
  // Do not restore the previous visit's historical selection as the landing page.
  const [currentId, setCurrentId] = useState(context ? '' : null)
  const [submitting, setSubmitting] = useState(false)
  useEffect(() => { if (context) setCurrentId('') }, [context])
  useEffect(() => useStore.subscribe((state, previous) => {
    const selected = state.selections[key + '/exploration']
    if (selected !== previous.selections[key + '/exploration']) setCurrentId(selected || '')
  }), [])
  const list = useSnapshot(() => api.listExplorations(), [key])
  const developments = useSnapshot(() => api.listDevelopmentChats(), [])
  const sessions = useExplorationDevelopmentHandoffsStore(s => s.sessions)
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
  const records = sortExplorations(availableRecords, activeExplorationId, developingIds)
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
  return <div className="wx-explore">
    <aside className="wx-history workspace-sidebar">
      <button type="button" className="sidebar-new-chat sidebar-conversation-action" title="新探索" aria-label="新探索" disabled={submitting} onClick={() => { useStore.setState({ explorationContext: null }); setCurrentId('') }}>
        <FormOutlined aria-hidden="true" /><span>新探索</span>
      </button>
      <header className="sidebar-conversation-header"><span className="sidebar-workspaces-label">工作记录</span></header>
      <div className="wx-history-records">
      <ErrorMessage>{list.error || developments.error}</ErrorMessage>
      {list.loading && <p>正在加载…</p>}
      {records.map(item => <ExplorationRecord key={item.exploration_id} item={item} selected={!showNew && currentId === item.exploration_id}
        inProgress={isExplorationInProgress(item, activeExplorationId, developingIds)} generating={developingIds.has(item.exploration_id)} disabled={submitting}
        onSelect={() => { useStore.getState().selectRecord(key + '/exploration', item.exploration_id); useStore.setState({ explorationContext: null }); setCurrentId(item.exploration_id) }} />)}
      {!list.loading && !list.error && !records.length && <p className="wx-empty">从一个网址开始探索；探索和适配器生成记录会保存在这里。</p>}
      </div>
    </aside>
    {showNew ? <NewExploration key={context ? context.toolkitId + '/' + context.tool.tool_id : 'site'} context={context} disabled={disabled || globalBusy || !modelReady} onCreated={onCreated} onBusyChange={setSubmitting} />
      : currentId ? <ExplorationDetail key={currentId} id={currentId} developmentReady={!developments.loading && !developments.error} disabled={disabled} globalBusy={globalBusy} modelReady={modelReady} onBusyChange={setSubmitting} />
        : <div className="wx-empty">{list.loading || !activityReady || currentId === null ? '正在加载探索…' : '暂时无法加载探索记录，请重试或新建探索。'}</div>}
  </div>
}

export function ExplorationRecord({ item, selected = false, inProgress = false, generating = false, disabled = false, onSelect }) {
  return <button type="button" className={'wx-record' + (selected ? ' is-active' : '') + (inProgress ? ' is-in-progress' : '')}
    aria-current={selected ? 'true' : undefined} disabled={disabled} onClick={onSelect}>
    <strong>{item.title || item.instruction || item.created_at || '探索'}</strong>
    {inProgress && <span className="wx-status wx-record-progress"><SettingOutlined className="wx-record-progress-gear" aria-hidden="true" /><span>{generating ? '生成中' : '探索中'}</span></span>}
    <small>{item.start_url}</small><small>{item.created_at}</small>
  </button>
}

export function ExplorationComposer({ value, onChange, onAction, inputRef, actionMode = 'send', disabled = false, actionDisabled = false, placeholder = '发送消息，补充探索目标或要求…', children, hint = 'Enter 发送 · Shift + Enter 换行' }) {
  const internalInput = useRef(null)
  const input = inputRef || internalInput
  const stopping = actionMode === 'stop'
  const actionLabel = stopping ? '停止探索' : '发送消息'
  useEffect(() => {
    if (!input.current) return
    input.current.style.height = 'auto'
    input.current.style.height = Math.min(input.current.scrollHeight, 180) + 'px'
  }, [value, input])
  return <div className="wx-chat-composer chat-input-composer">
    <div className="chat-input-surface wx-chat-input">
      <textarea ref={input} rows={2} aria-label="探索消息" value={value} disabled={disabled} onChange={e => onChange(e.target.value)} placeholder={placeholder} onKeyDown={e => {
        if (shouldSubmitExploration(e, actionMode)) { e.preventDefault(); if (!disabled && !actionDisabled) onAction() }
      }} />
      <div className="chat-input-toolbar wx-chat-toolbar">
        <small className="wx-composer-hint">{hint}</small>
        <div className="chat-input-toolbar-actions wx-chat-controls">
          {children}
          <button type="button" className={'chat-input-action wx-chat-send ' + (stopping ? 'chat-input-action-stop' : 'chat-input-action-send')} aria-label={actionLabel} title={actionLabel} disabled={disabled || actionDisabled} onClick={onAction} />
        </div>
      </div>
    </div>
  </div>
}

function NewExploration({ context, disabled, onCreated, onBusyChange }) {
  const composerInput = useRef(null)
  const tool = context?.tool
  const draftKey = tool ? context.toolkitId + '/' + tool.tool_id + '/new' : 'site/new/instruction'
  const [url, setUrl] = useDraft('site/new/url')
  const [instruction, setInstruction] = useDraft(draftKey)
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
        ? await api.createExploration(context.toolkitId, tool.tool_id, instruction, target.target_id)
        : await api.createSiteExploration({ start_url: startUrl.trim(), instruction })
      setInstruction('')
      if (!tool) setUrl('')
      onCreated(created.exploration_id)
    })
  }
  return <section className="wx-detail wx-chat-detail">
    <header><h2>新探索</h2></header>
    <div className="wx-scroll wx-new-conversation">
      <article className="wx-chat-message wx-chat-assistant">
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
    <ExplorationComposer inputRef={composerInput} value={instruction} onChange={setInstruction} onAction={submit} actionMode={explorationComposerMode(undefined, startAction.busy)} disabled={busy} actionDisabled={!canSubmit} placeholder="告诉我你想在这个网站上干什么" hint={disabled ? '等待服务、模型和浏览器任务就绪' : '填写起始网址后发送，即可开始探索'} />
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

function ExplorationDetail({ id, developmentReady, disabled, globalBusy, modelReady, onBusyChange }) {
  const sessions = useExplorationDevelopmentHandoffsStore(s => s.sessions)
  const [historyWorkId, setHistoryWorkId] = useState(null)
  const snapshot = useSnapshot(() => api.getExploration(id), [id], '/api/explorations/' + id + '/events')
  const transferAction = useAction()
  const transferBusy = transferAction.busy
  useEffect(() => { onBusyChange(transferBusy); return () => onBusyChange(false) }, [transferBusy, onBusyChange])
  const action = useAction(snapshot.refresh)
  const messageAction = useAction(snapshot.refresh)
  const [prompt, setPrompt] = useDraft(id + '/prompt')
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
  if (!data) return <div className="wx-empty"><ErrorMessage>{snapshot.error}</ErrorMessage>{snapshot.loading && '正在加载探索…'}</div>
  const replayActive = Boolean(replayId && (!replay.data || !['succeeded', 'failed', 'cancelled', 'stopped'].includes(replay.data.status)))
  const controls = explorationControls({ ...data, disabled, busy: action.busy || messageAction.busy || replayAction.busy || transferBusy, globalBusy, modelReady, replayActive })
  const actionMode = explorationComposerMode(data.status, messageAction.busy)
  const transferring = transferBusy
  const submitted = Boolean(development)
  const developDisabled = !developmentReady || submitted || disabled || globalBusy || action.busy || messageAction.busy || transferBusy || replayActive
  const sendMessage = content => {
    if (!controls.canSend || !content.trim()) return
    void messageAction.run(async () => {
      await continueWebsiteExploration(id, content, controls.resumable)
      setPrompt('')
    })
  }
  const explorationMessages = <>
      {snapshot.data && <article className="wx-chat-message wx-chat-user"><div className="wx-user-bubble"><p className="wx-url">{data.start_url}</p><p>{data.instruction || '请探索这个网站的主要功能。'}</p></div></article>}
      {(data.timeline || []).map((item, index) => item.type === 'agent_step' ? <article className="wx-step wx-chat-message wx-chat-assistant" key={'step-' + (item.step ?? index)}>
        <header><h3>步骤 {item.step}</h3><Status value={item.status} /></header>
        {item.thought && <p>{item.thought}</p>}
        {item.code && <details><summary>执行动作</summary><JsonView value={item.code} /></details>}
        {item.observation && <details><summary>{item.observation.title || '执行后页面'}</summary><p className="wx-url">{item.observation.url}</p><ResourceImage path={item.observation.screenshot_url} /></details>}
        {item.exception && <ErrorMessage>{typeof item.exception === 'string' ? item.exception : item.exception.message}</ErrorMessage>}
      </article> : <article className={'wx-chat-message ' + (item.type === 'user' ? 'wx-chat-user' : 'wx-chat-assistant')} key={'message-' + index}><div className={item.type === 'user' ? 'wx-user-bubble' : ''}><p>{item.content}</p></div></article>)}
      {!snapshot.data ? <p className="wx-muted" role="status">探索记录暂不可用，仍可继续生成网站适配器。</p> : !data.timeline?.length && <p className="wx-muted" role="status">等待执行步骤…</p>}
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
    <header><div><h2>{data.title || '网站探索'}</h2>{development ? <span className="wx-status">网站适配器生成</span> : <Status value={data.status === 'cancelled' ? 'stopped' : data.status === 'cancel_requested' ? 'stopping' : data.status} />}</div></header>
    {development ? <ChatView key={development.work.id} workId={development.work.id} embedded {...explorationDevelopmentPermissionSettings(development.work.id)} historyPrefix={<div className="wx-development-context">{explorationMessages}</div>} /> : <>
    <ScrollArea name={id} revision={JSON.stringify([data.status, data.timeline, transferring, submitted])}>{explorationMessages}</ScrollArea>
    <ExplorationComposer value={prompt} onChange={setPrompt} actionMode={actionMode}
      onAction={actionMode === 'stop' ? () => action.run(() => api.stopExploration(id)) : () => sendMessage(prompt)}
      actionDisabled={actionMode === 'stop' ? !controls.canStop : !controls.canSend || !prompt.trim()} disabled={action.busy || messageAction.busy || transferBusy}
      hint={data.status === 'cancel_requested' ? '正在停止探索…' : actionMode === 'stop' ? '点击右侧按钮停止探索' : 'Enter 发送 · Shift + Enter 换行'}>
      <ExplorationControls replayActive={replayActive} cancelReplayDisabled={disabled || action.busy || messageAction.busy || replayAction.busy || transferBusy || !replay.data || replay.data.status === 'cancel_requested'}
        onCancelReplay={() => replayAction.run(() => api.request('/api/replays/' + replayId + '/cancel', { method: 'POST' }))} />
    </ExplorationComposer>
    </>}
  </section>
}
