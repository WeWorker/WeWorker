import React, { useEffect, useId, useRef, useState } from 'react'
import { FormOutlined } from '@ant-design/icons'
import * as api from '../../api/website-exploration-api.js'
import { continueWebsiteExploration, finishExplorationTransfer, useWebsiteExplorationStore as useStore } from '../../store/website-exploration.js'
import { isDevelopmentSubmitted, useExplorationDevelopmentHandoffsStore } from '../../store/exploration-development-handoffs.js'
import { explorationComposerMode, explorationControls, isExplorationUrl, shouldSubmitExploration, sortExplorations } from '../../utils/exploration-chat.js'
import { ErrorMessage, JsonView, RequiredMark, ResourceImage, ScrollArea, Status, useAction, useDraft, useSnapshot } from './shared.jsx'

export default function ExploreWorkspace({ disabled, globalBusy, modelReady = true, activeExplorationId = '' }) {
  const key = 'site'
  const context = useStore(s => s.explorationContext)
  const selected = useStore(s => s.selections[key + '/exploration'])
  const [creating, setCreating] = useState(Boolean(context))
  const [submitting, setSubmitting] = useState(false)
  useEffect(() => { if (context) setCreating(true) }, [context])
  // Keep explicit record selection separate from draft creation and list ordering.
  useEffect(() => useStore.subscribe((state, previous) => {
    if (state.selections !== previous.selections) setCreating(false)
  }), [])
  const list = useSnapshot(() => api.listExplorations(), [key])
  const records = sortExplorations(list.data, activeExplorationId)
  const currentId = selected || records[0]?.exploration_id
  // Reordering the list must not replace the conversation the user is reading.
  useEffect(() => {
    if (!selected && !creating && currentId) useStore.getState().selectRecord(key + '/exploration', currentId)
  }, [selected, creating, currentId])
  const showNew = creating || (!currentId && !list.loading && !list.error)
  const onCreated = id => {
    useStore.getState().selectRecord(key + '/exploration', id)
    setCreating(false)
    useStore.setState({ explorationContext: null })
    void list.refresh()
  }
  return <div className="wx-explore">
    <aside className="wx-history workspace-sidebar">
      <button type="button" className="sidebar-new-chat sidebar-conversation-action" title="新探索" aria-label="新探索" disabled={submitting} onClick={() => { useStore.setState({ explorationContext: null }); setCreating(true) }}>
        <FormOutlined aria-hidden="true" /><span>新探索</span>
      </button>
      <header className="sidebar-conversation-header"><span className="sidebar-workspaces-label">探索列表</span></header>
      <div className="wx-history-records">
      <ErrorMessage>{list.error}</ErrorMessage>
      {list.loading && <p>正在加载…</p>}
      {records.map(item => <button className={'wx-record ' + (!showNew && currentId === item.exploration_id ? 'is-active' : '')} key={item.exploration_id} disabled={submitting} onClick={() => { useStore.getState().selectRecord(key + '/exploration', item.exploration_id); useStore.setState({ explorationContext: null }); setCreating(false) }}>
        <strong>{item.title || item.instruction || item.created_at || '探索'}</strong><Status value={item.status} /><small>{item.start_url}</small><small>{item.created_at}</small>
      </button>)}
      {!list.loading && !list.error && !list.data?.length && <p className="wx-empty">从一个网址开始，探索会保存在这里。</p>}
      </div>
    </aside>
    {showNew ? <NewExploration key={context ? context.toolkitId + '/' + context.tool.tool_id : 'site'} context={context} disabled={disabled || globalBusy || !modelReady} onCreated={onCreated} onBusyChange={setSubmitting} />
      : currentId ? <ExplorationDetail key={currentId} id={currentId} disabled={disabled} globalBusy={globalBusy} modelReady={modelReady} onBusyChange={setSubmitting} />
        : <div className="wx-empty">{list.loading ? '正在加载探索…' : '暂时无法加载探索记录，请重试或新建探索。'}</div>}
  </div>
}

export function ExplorationComposer({ value, onChange, onAction, inputRef, actionMode = 'send', disabled = false, actionDisabled = false, placeholder = '发送消息，补充探索目标或要求…', children, hint = 'Enter 发送 · Shift + Enter 换行' }) {
  const internalInput = useRef(null)
  const input = inputRef || internalInput
  const pausing = actionMode === 'pause'
  const actionLabel = pausing ? '暂停探索' : actionMode === 'resume' && !value.trim() ? '继续探索' : '发送消息'
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
          <button type="button" className={'chat-input-action wx-chat-send ' + (pausing ? 'chat-input-action-stop' : 'chat-input-action-send')} aria-label={actionLabel} title={actionLabel} disabled={disabled || actionDisabled} onClick={onAction} />
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
    <ExplorationComposer inputRef={composerInput} value={instruction} onChange={setInstruction} onAction={submit} actionMode={explorationComposerMode(undefined, startAction.busy)} disabled={busy} actionDisabled={!canSubmit} placeholder="告诉我你想在这个网站上干什么" hint={disabled ? '等待服务、模型和浏览器任务就绪' : '填写起始网址后发送，即可开始探索'}>
      <ExplorationControls controls={explorationControls({})} />
    </ExplorationComposer>
  </section>
}

export function ExplorationControls({ controls, onReplay, onCancel, replayActive = false, cancelReplayDisabled = true, onCancelReplay }) {
  return <>
    <button type="button" className="wx-chat-control" title={replayActive ? '停止当前回放' : '回放探索过程'} disabled={replayActive ? cancelReplayDisabled : !controls.canReplay} onClick={replayActive ? onCancelReplay : onReplay}>{replayActive ? '停止回放' : '回放'}</button>
    <button type="button" className="wx-chat-control" title="取消本次探索" disabled={!controls.canCancel} onClick={onCancel}>取消</button>
  </>
}

export function CompletionQuestion({ submitted = false, developing = false, developDisabled = false, continueDisabled = false, onDevelop, onContinue }) {
  const questionId = useId()
  if (submitted) return <div className="user-choice-block wx-completion-question" role="status">
    <p>探索结束已转开发，请在开发对话中完成开发。如需继续探索，请继续补充探索目标或要求。</p>
  </div>
  return <div className="user-choice-block wx-completion-question" role="group" aria-labelledby={questionId}>
    <div className="user-choice-block__question" id={questionId}>探索已完成，是否基于本次探索结果开始开发？</div>
    {developing ? <div className="user-choice-block__answered">是，开始开发</div> : <div className="user-choice-block__options">
      <button type="button" className="user-choice-block__option" disabled={developDisabled} onClick={onDevelop}>
        <span className="user-choice-block__option-label">是，开始开发</span>
        <span className="user-choice-block__option-desc">自动提交探索结果并开始开发，由 Agent 判断复用、新建或修改。</span>
      </button>
      <button type="button" className="user-choice-block__option" disabled={continueDisabled} onClick={onContinue}>
        <span className="user-choice-block__option-label">继续探索</span>
        <span className="user-choice-block__option-desc">按输入框中的补充要求继续；未填写时，继续探索尚未覆盖的功能。</span>
      </button>
    </div>}
  </div>
}

function ExplorationDetail({ id, disabled, globalBusy, modelReady, onBusyChange }) {
  const handoff = useExplorationDevelopmentHandoffsStore(s => s.handoffs[id])
  const snapshot = useSnapshot(() => api.getExploration(id), [id], '/api/explorations/' + id + '/events')
  const transferAction = useAction()
  const transferBusy = transferAction.busy
  useEffect(() => { onBusyChange(transferBusy); return () => onBusyChange(false) }, [transferBusy, onBusyChange])
  const action = useAction(snapshot.refresh)
  const messageAction = useAction(snapshot.refresh)
  const [prompt, setPrompt] = useDraft(id + '/prompt')
  const [replayId, setReplayId] = useDraft(id + '/replay')
  const replay = useSnapshot(() => replayId ? api.request('/api/replays/' + replayId) : Promise.resolve(null), [replayId], replayId ? '/api/replays/' + replayId + '/events' : undefined)
  const replayAction = useAction(replay.refresh)
  const data = snapshot.data
  if (!data) return <div className="wx-empty"><ErrorMessage>{snapshot.error}</ErrorMessage>{snapshot.loading && '正在加载探索…'}</div>
  const replayActive = Boolean(replayId && (!replay.data || !['succeeded', 'failed', 'cancelled', 'stopped'].includes(replay.data.status)))
  const controls = explorationControls({ ...data, disabled, busy: action.busy || messageAction.busy || replayAction.busy || transferBusy, globalBusy, modelReady, replayActive })
  const actionMode = explorationComposerMode(data.status, messageAction.busy)
  const transferring = transferBusy
  const submitted = isDevelopmentSubmitted(handoff, data.last_run_id ?? null)
  const developDisabled = submitted || disabled || globalBusy || action.busy || messageAction.busy || transferBusy || replayActive
  const sendMessage = content => {
    if (controls.resumable ? !controls.canResume : !controls.canSend || !content.trim()) return
    void messageAction.run(async () => {
      await continueWebsiteExploration(id, content, controls.resumable)
      setPrompt('')
    })
  }
  return <section className="wx-detail wx-chat-detail">
    <header><div><h2>{data.title || '网站探索'}</h2><Status value={data.status} /></div></header>
    <ScrollArea name={id} revision={JSON.stringify([data.status, data.timeline, transferring, submitted])}>
      <article className="wx-chat-message wx-chat-user"><div className="wx-user-bubble"><p className="wx-url">{data.start_url}</p><p>{data.instruction || '请探索这个网站的主要功能。'}</p></div></article>
      {(data.timeline || []).map((item, index) => item.type === 'agent_step' ? <article className="wx-step wx-chat-message wx-chat-assistant" key={'step-' + (item.step ?? index)}>
        <header><h3>步骤 {item.step}</h3><Status value={item.status} /></header>
        {item.thought && <p>{item.thought}</p>}
        {item.code && <details><summary>执行动作</summary><JsonView value={item.code} /></details>}
        {item.observation && <details><summary>{item.observation.title || '执行后页面'}</summary><p className="wx-url">{item.observation.url}</p><ResourceImage path={item.observation.screenshot_url} /></details>}
        {item.exception && <ErrorMessage>{typeof item.exception === 'string' ? item.exception : item.exception.message}</ErrorMessage>}
      </article> : <article className={'wx-chat-message ' + (item.type === 'user' ? 'wx-chat-user' : 'wx-chat-assistant')} key={'message-' + index}><div className={item.type === 'user' ? 'wx-user-bubble' : ''}><p>{item.content}</p></div></article>)}
      {!data.timeline?.length && <p className="wx-muted" role="status">等待执行步骤…</p>}
      {data.status === 'succeeded' && <article className="wx-chat-message wx-chat-assistant">
        <CompletionQuestion submitted={submitted} developing={transferring} developDisabled={developDisabled} continueDisabled={!controls.canSend}
          onDevelop={() => { if (!developDisabled) void transferAction.run(() => finishExplorationTransfer({ explorationId: id, runId: data.last_run_id ?? null })) }}
          onContinue={() => sendMessage(prompt.trim() || '继续探索这个网站，进一步了解尚未覆盖的功能和操作流程。')} />
      </article>}
      {data.active_issue?.message && <p className={data.active_issue.type === 'failed' ? 'wx-error' : 'wx-muted'} role="status">{data.active_issue.message}</p>}
      {replayId && <div className="wx-replay-status" role="status">回放 <Status value={replay.data?.status} /></div>}
      <ErrorMessage>{snapshot.error || messageAction.error || action.error || transferAction.error || replay.error || replayAction.error}</ErrorMessage>
    </ScrollArea>
    <ExplorationComposer value={prompt} onChange={setPrompt} actionMode={actionMode}
      onAction={actionMode === 'pause' ? () => action.run(() => api.pauseExploration(id)) : () => sendMessage(prompt)}
      actionDisabled={actionMode === 'pause' ? !controls.canPause : controls.resumable ? !controls.canResume : !controls.canSend || !prompt.trim()} disabled={action.busy || messageAction.busy || transferBusy}
      hint={actionMode === 'pause' ? '正在探索，可点击右侧按钮暂停' : controls.resumable ? '发送补充说明，或直接继续探索' : 'Enter 发送 · Shift + Enter 换行'}>
      <ExplorationControls controls={controls} replayActive={replayActive} cancelReplayDisabled={disabled || action.busy || messageAction.busy || replayAction.busy || transferBusy || !replay.data || replay.data.status === 'cancel_requested'}
        onReplay={() => action.run(async () => { const result = await api.replayExploration(id); setReplayId(result.replay_id) })}
        onCancel={() => action.run(() => api.cancelExploration(id))}
        onCancelReplay={() => replayAction.run(() => api.request('/api/replays/' + replayId + '/cancel', { method: 'POST' }))} />
    </ExplorationComposer>
  </section>
}
