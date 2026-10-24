import React, { useState } from 'react'
import * as api from '../../api/website-exploration-api.js'
import { changeWebsiteContext, useWebsiteExplorationStore as useStore } from '../../store/website-exploration.js'
import { ActionMenu, Icon, ErrorMessage, JsonView, Modal, RequiredMark, ResourceImage, ScrollArea, Status, useAction, useDraft, useSnapshot } from './shared.jsx'

export default function ExploreWorkspace({ toolkitId, tool, disabled, globalBusy, modelReady = true }) {
  const key = toolkitId + '/' + tool.tool_id
  const selected = useStore(s => s.selections[key + '/exploration'])
  const [creating, setCreating] = useState(false)
  const [filter, setFilter] = useDraft(key + '/filter')
  const list = useSnapshot(() => api.listExplorations(toolkitId, tool.tool_id), [key])
  const currentId = selected && list.data?.some(item => item.exploration_id === selected) ? selected : list.data?.[0]?.exploration_id
  return <div className="wx-explore">
    <aside className="wx-history"><header><h2>探索记录</h2><button className="wx-icon-button" title="新建探索" aria-label="新建探索" disabled={disabled || globalBusy || !modelReady} onClick={() => setCreating(true)}><Icon name="plus" /></button></header>
      <input aria-label="搜索探索记录" placeholder="搜索记录或状态" value={filter} onChange={e => setFilter(e.target.value)} />
      <ErrorMessage>{list.error}</ErrorMessage>
      {list.loading && <p>正在加载…</p>}
      {list.data?.filter(item => JSON.stringify([item.exploration_id, item.status, item.instruction]).includes(filter)).map(item => <button className={'wx-record ' + (currentId === item.exploration_id ? 'is-active' : '')} key={item.exploration_id} onClick={() => useStore.getState().selectRecord(key + '/exploration', item.exploration_id)}>
        <strong>{item.instruction || item.created_at || '探索记录'}</strong><Status value={item.status} /><small>{item.created_at}</small>
      </button>)}
      {!list.loading && !list.data?.length && <p className="wx-empty">先打开目标网站并登录，再开始第一次探索。</p>}
    </aside>
    {currentId ? <ExplorationDetail key={currentId} id={currentId} scope={key} disabled={disabled} globalBusy={globalBusy} tool={tool} /> : <div className="wx-empty"><p>选择或新建探索，执行过程与结果将在这里显示。</p><button data-app-button="action" className="wx-primary" disabled={disabled || globalBusy || !modelReady} onClick={() => setCreating(true)}>开始第一次探索</button></div>}
    {creating && <NewExploration toolkitId={toolkitId} tool={tool} disabled={disabled || globalBusy || !modelReady} onClose={() => setCreating(false)} onCreated={id => { useStore.getState().selectRecord(key + '/exploration', id); setCreating(false); void list.refresh() }} />}
  </div>
}

function NewExploration({ toolkitId, tool, disabled, onClose, onCreated }) {
  const [instruction, setInstruction] = useDraft(toolkitId + '/' + tool.tool_id + '/new')
  const [target, setTarget] = useState(null)
  const action = useAction()
  return <Modal title="新建探索" onClose={onClose}>
    <p>{tool.goal}</p><p className="wx-url">{tool.start_url}</p>
    <p>如网站需要登录，请先在 Agent 浏览器中完成登录，再检测目标页面。</p>
    <div className="wx-actions"><button data-app-button="action" disabled={action.busy || disabled} onClick={() => action.run(() => api.openBrowser(tool.start_url))}>打开目标网站</button>
      <button data-app-button="action" disabled={action.busy || disabled} onClick={() => action.run(async () => {
        setTarget(null)
        const match = await api.matchBrowser(tool.start_url)
        if (match.status !== 'exact' || !match.target) throw new Error('尚未找到准确的起始页面，请打开并登录后重新检测')
        setTarget(match.target)
      })}>检测目标页面</button></div>
    {target && <p>已找到：{target.title || target.url}</p>}
    <label>补充探索指令<textarea value={instruction} onChange={e => setInstruction(e.target.value)} placeholder="说明本次需要探索的操作和预期结果" /></label>
    <ErrorMessage>{action.error}</ErrorMessage>
    <footer><button data-app-button="action" onClick={onClose}>取消</button><button data-app-button="action" className="wx-primary" disabled={!target || action.busy || disabled} onClick={() => action.run(async () => {
      const created = await api.createExploration(toolkitId, tool.tool_id, instruction, target.target_id)
      setInstruction(''); onCreated(created.exploration_id)
    })}>开始探索</button></footer>
  </Modal>
}

function ExplorationDetail({ id, scope, disabled, globalBusy, tool }) {
  const snapshot = useSnapshot(() => api.getExploration(id), [id], '/api/explorations/' + id + '/events')
  const slots = useSnapshot(() => api.getSlots(scope.split('/')[0], tool.tool_id), [scope])
  const action = useAction(snapshot.refresh)
  const [prompt, setPrompt] = useDraft(id + '/prompt')
  const [replayId, setReplayId] = useState('')
  const data = snapshot.data
  if (!data) return <div className="wx-empty"><ErrorMessage>{snapshot.error}</ErrorMessage>{snapshot.loading && '正在加载探索…'}</div>
  const active = ['queued', 'running', 'pending', 'starting', 'waiting_for_user', 'pause_requested', 'cancel_requested'].includes(data.status)
  return <section className="wx-detail">
    <header><div><h2>{tool.name}</h2><Status value={data.status} /></div><div className="wx-actions">
      {['running', 'waiting_for_user'].includes(data.status) && <button data-app-button="action" disabled={disabled || action.busy} onClick={() => action.run(() => api.pauseExploration(id))}>暂停</button>}
      {['paused', 'waiting_for_user'].includes(data.status) && <button data-app-button="action" disabled={disabled || action.busy} onClick={() => action.run(async () => { await api.resumeExploration(id, prompt); setPrompt('') })}>继续</button>}
      {(active || data.status === 'paused') && <button data-app-button="action" disabled={disabled || action.busy} onClick={() => action.run(() => api.cancelExploration(id))}>取消运行</button>}
      {!active && <ActionMenu compact label="探索记录操作"><button disabled={disabled || globalBusy || action.busy || !data.timeline?.some(item => item.type === 'agent_step')} onClick={() => action.run(async () => { const replay = await api.replayExploration(id); setReplayId(replay.replay_id) })}>回放</button></ActionMenu>}
      {slots.data && !slots.data.development && !slots.data.formal && data.status === 'succeeded' && data.completed_goal && !data.used_by_development && <button data-app-button="action" className="wx-primary" disabled={disabled || globalBusy} onClick={() => { useStore.getState().setDraft(scope + '/source', id); useStore.getState().setDraft(scope + '/rebuilding', false); void changeWebsiteContext({ workspace: 'develop' }) }}>选为开发输入</button>}
    </div></header>
    <ErrorMessage>{snapshot.error || action.error}</ErrorMessage>
    {data.active_issue?.message && <p className={data.active_issue.type === 'failed' ? 'wx-error' : 'wx-muted'}>{data.active_issue.message}</p>}
    <ScrollArea name={id} revision={JSON.stringify(data.timeline)}>
      <p>{tool.goal}</p>
      {(data.timeline || []).map((item, index) => item.type === 'agent_step' ? <article className="wx-step" key={item.step ?? index}>
        <header><h3>步骤 {item.step}</h3><Status value={item.status} /></header>
        {item.thought && <p>{item.thought}</p>}
        {item.code && <details><summary>执行动作</summary><JsonView value={item.code} /></details>}
        {item.observation && <details><summary>{item.observation.title || '执行后页面'}</summary><p className="wx-url">{item.observation.url}</p><ResourceImage path={item.observation.screenshot_url} /></details>}
        {item.exception && <ErrorMessage>{typeof item.exception === 'string' ? item.exception : item.exception.message}</ErrorMessage>}
      </article> : <article className={'wx-message wx-' + item.type} key={index}><strong>{item.type === 'user' ? '你' : '最终结果'}</strong><p>{item.content}</p></article>)}
      {!data.timeline?.length && <p className="wx-empty">等待执行步骤…</p>}
      {replayId && <ReplayStatus id={replayId} />}
    </ScrollArea>
    <form className="wx-prompt" onSubmit={e => { e.preventDefault(); void action.run(async () => {
      if (['paused', 'waiting_for_user'].includes(data.status)) await api.resumeExploration(id, prompt)
      else await api.sendExplorationFollowup(id, prompt)
      setPrompt('')
    }) }}>
      <label><span>追加指令<RequiredMark /></span><textarea aria-label="追加指令" required value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="补充目标、约束或页面操作说明" /></label>
      <button data-app-button="action" className="wx-primary" disabled={!prompt.trim() || disabled || action.busy}>发送指令</button>
    </form>
  </section>
}

function ReplayStatus({ id }) {
  const snapshot = useSnapshot(() => api.request('/api/replays/' + id), [id], '/api/replays/' + id + '/events')
  const action = useAction(snapshot.refresh)
  return <section><h3>回放</h3><Status value={snapshot.data?.status} /><ErrorMessage>{snapshot.error || action.error}</ErrorMessage>{snapshot.data?.status === 'running' && <button data-app-button="action" disabled={action.busy} onClick={() => action.run(() => api.request('/api/replays/' + id + '/cancel', { method: 'POST' }))}>停止回放</button>}</section>
}
