import React, { useEffect, useState } from 'react'
import * as api from '../../api/website-exploration-api.js'
import { finishExplorationTransfer, useWebsiteExplorationStore as useStore } from '../../store/website-exploration.js'
import { Icon, ErrorMessage, JsonView, Modal, RequiredMark, ResourceImage, ScrollArea, Status, useAction, useDraft, useSnapshot } from './shared.jsx'

export default function ExploreWorkspace({ disabled, globalBusy, modelReady = true }) {
  const key = 'site'
  const context = useStore(s => s.explorationContext)
  const selected = useStore(s => s.selections[key + '/exploration'])
  const [creating, setCreating] = useState(Boolean(context))
  useEffect(() => { if (context) setCreating(true) }, [context])
  const [filter, setFilter] = useDraft(key + '/filter')
  const list = useSnapshot(() => api.listExplorations(), [key])
  const currentId = selected && list.data?.some(item => item.exploration_id === selected) ? selected : list.data?.[0]?.exploration_id
  return <div className="wx-explore">
    <aside className="wx-history"><header><h2>探索记录</h2><button className="wx-icon-button" title="新建探索" aria-label="新建探索" disabled={disabled || globalBusy || !modelReady} onClick={() => { useStore.setState({ explorationContext: null }); setCreating(true) }}><Icon name="plus" /></button></header>
      <input aria-label="搜索探索记录" placeholder="搜索记录或状态" value={filter} onChange={e => setFilter(e.target.value)} />
      <ErrorMessage>{list.error}</ErrorMessage>
      {list.loading && <p>正在加载…</p>}
      {list.data?.filter(item => JSON.stringify([item.exploration_id, item.status, item.instruction, item.title, item.start_url]).includes(filter)).map(item => <button className={'wx-record ' + (currentId === item.exploration_id ? 'is-active' : '')} key={item.exploration_id} onClick={() => useStore.getState().selectRecord(key + '/exploration', item.exploration_id)}>
        <strong>{item.title || item.instruction || item.created_at || '探索记录'}</strong><Status value={item.status} /><small>{item.start_url}</small><small>{item.created_at}</small>
      </button>)}
      {!list.loading && !list.data?.length && <p className="wx-empty">输入起始网址即可探索，无需先创建 Adapter 或 Tool。</p>}
    </aside>
    {currentId ? <ExplorationDetail key={currentId} id={currentId} scope={key} disabled={disabled} globalBusy={globalBusy} /> : <div className="wx-empty"><p>选择或新建探索，执行过程与结果将在这里显示。</p><button data-app-button="action" className="wx-primary" disabled={disabled || globalBusy || !modelReady} onClick={() => { useStore.setState({ explorationContext: null }); setCreating(true) }}>开始第一次探索</button></div>}
    {creating && (context ? <NewExploration toolkitId={context.toolkitId} tool={context.tool} disabled={disabled || globalBusy || !modelReady} onClose={() => { setCreating(false); useStore.setState({ explorationContext: null }) }} onCreated={id => { useStore.getState().selectRecord(key + '/exploration', id); setCreating(false); useStore.setState({ explorationContext: null }); void list.refresh() }} /> : <NewSiteExploration disabled={disabled || globalBusy || !modelReady} onClose={() => setCreating(false)} onCreated={id => { useStore.getState().selectRecord(key + '/exploration', id); setCreating(false); void list.refresh() }} />)}
  </div>
}

function NewExploration({ toolkitId, tool, disabled, onClose, onCreated }) {
  const [instruction, setInstruction] = useDraft(toolkitId + '/' + tool.tool_id + '/new')
  const [target, setTarget] = useState(null)
  const [targets, setTargets] = useState([])
  const action = useAction()
  return <Modal title="新建探索" onClose={onClose}>
    <p>{tool.goal}</p><p className="wx-url">{tool.start_url}</p>
    <p>如网站需要登录，请先在 Agent 浏览器中完成登录。探索将从所选页面的当前状态开始，网址路径和参数可以变化。</p>
    <div className="wx-actions"><button data-app-button="action" disabled={action.busy || disabled} onClick={() => action.run(async () => { setTarget(null); setTargets([]); await api.openBrowser(tool.start_url) })}>打开起始网址</button>
      <button data-app-button="action" disabled={action.busy || disabled} onClick={() => action.run(async () => {
        setTarget(null)
        setTargets([])
        const match = await api.matchBrowser(tool.start_url, toolkitId, tool.tool_id)
        if (!match.targets?.length) throw new Error('未找到允许域名内的页面，请打开起始网址并完成登录，或修改 Adapter 允许域名后重新检测')
        setTargets(match.targets)
        setTarget(match.target)
      })}>检测目标页面</button></div>
    {targets.length > 0 && <label>探索页面<select value={target?.target_id || ''} disabled={action.busy || disabled} onChange={e => setTarget(targets.find(item => item.target_id === e.target.value) || null)}>
      <option value="" disabled>请选择要探索的页面</option>
      {targets.map(item => <option key={item.target_id} value={item.target_id}>{item.title ? item.title + ' — ' : ''}{item.url}</option>)}
    </select></label>}
    {target && <p className="wx-url">当前页面：{target.url}</p>}
    <label>补充探索指令<textarea value={instruction} onChange={e => setInstruction(e.target.value)} placeholder="说明本次需要探索的操作和预期结果" /></label>
    <ErrorMessage>{action.error}</ErrorMessage>
    <footer><button data-app-button="action" onClick={onClose}>取消</button><button data-app-button="action" className="wx-primary" disabled={!target || action.busy || disabled} onClick={() => action.run(async () => {
      const created = await api.createExploration(toolkitId, tool.tool_id, instruction, target.target_id)
      setInstruction(''); onCreated(created.exploration_id)
    })}>开始探索</button></footer>
  </Modal>
}

function ExplorationDetail({ id, disabled, globalBusy }) {
  const snapshot = useSnapshot(() => api.getExploration(id), [id], '/api/explorations/' + id + '/events')
  const [transferring, setTransferring] = useState(false)
  const action = useAction(snapshot.refresh)
  const [prompt, setPrompt] = useDraft(id + '/prompt')
  const [replayId, setReplayId] = useState('')
  const data = snapshot.data
  if (!data) return <div className="wx-empty"><ErrorMessage>{snapshot.error}</ErrorMessage>{snapshot.loading && '正在加载探索…'}</div>
  const active = ['queued', 'running', 'pending', 'starting', 'waiting_for_user', 'pause_requested', 'cancel_requested'].includes(data.status)
  return <section className="wx-detail">
    {transferring && <TransferExploration exploration={data} disabled={disabled || globalBusy} onClose={() => setTransferring(false)} />}
    <header><div><h2>{data.title || '网站探索'}</h2><Status value={data.status} /></div><div className="wx-actions">
      {['running', 'waiting_for_user'].includes(data.status) && <button data-app-button="action" disabled={disabled || action.busy} onClick={() => action.run(() => api.pauseExploration(id))}>暂停</button>}
      {['paused', 'waiting_for_user'].includes(data.status) && <button data-app-button="action" disabled={disabled || action.busy} onClick={() => action.run(async () => { await api.resumeExploration(id, prompt); setPrompt('') })}>继续</button>}
      {(active || data.status === 'paused') && <button data-app-button="action" disabled={disabled || action.busy} onClick={() => action.run(() => api.cancelExploration(id))}>取消运行</button>}
      {data.status === 'succeeded' && <button data-app-button="action" className="wx-primary" disabled={disabled || globalBusy || action.busy}
        title="选择目标 Adapter 和 Tool，准备 input.json 并打开对话草稿"
        onClick={() => setTransferring(true)}>到WeWorker中开发</button>}
      {!active && <button data-app-button="action" className="wx-quiet" disabled={disabled || globalBusy || action.busy || !data.timeline?.some(item => item.type === 'agent_step')} onClick={() => action.run(async () => { const replay = await api.replayExploration(id); setReplayId(replay.replay_id) })}>回放</button>}
    </div></header>
    <ErrorMessage>{snapshot.error || action.error}</ErrorMessage>
    {data.active_issue?.message && <p className={data.active_issue.type === 'failed' ? 'wx-error' : 'wx-muted'}>{data.active_issue.message}</p>}
    <ScrollArea name={id} revision={JSON.stringify(data.timeline)}>
      <p>{data.instruction}</p><p className="wx-url">{data.start_url}</p>
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

function NewSiteExploration({ disabled, onClose, onCreated }) {
  const [url, setUrl] = useDraft('site/new/url')
  const [instruction, setInstruction] = useDraft('site/new/instruction')
  const action = useAction()
  let valid = false
  try { const parsed = new URL(url); valid = ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password } catch {}
  return <Modal title="新建探索" onClose={onClose}>
    <form onSubmit={e => { e.preventDefault(); if (!valid) return; void action.run(async () => {
      const created = await api.createSiteExploration({ start_url: url.trim(), instruction })
      setInstruction(''); onCreated(created.exploration_id)
    }) }}>
      <label>起始网址<RequiredMark /><input type="url" required aria-label="起始网址" value={url} placeholder="https://example.com" onChange={e => setUrl(e.target.value)} /></label>
      <label>探索目标（可选）<textarea value={instruction} onChange={e => setInstruction(e.target.value)} placeholder="留空则初步探索网站能力；也可以描述希望了解的功能。" /></label>
      <p>无需先创建 Adapter 或 Tool。将使用受管浏览器探索；如网站需要登录，可先打开网址完成登录。</p>
      <button type="button" data-app-button="action" disabled={!valid || disabled || action.busy} onClick={() => action.run(() => api.openBrowser(url.trim()))}>打开网址 / 登录</button>
      <ErrorMessage>{action.error}</ErrorMessage>
      <footer><button type="button" data-app-button="action" disabled={action.busy} onClick={onClose}>取消</button><button data-app-button="action" className="wx-primary" disabled={!valid || disabled || action.busy}>开始探索</button></footer>
    </form>
  </Modal>
}

function TransferExploration({ exploration, disabled, onClose }) {
  const owned = Boolean(exploration.toolkit_id || exploration.tool_id)
  const [kitId, setKitId] = useState(exploration.toolkit_id || '')
  const [toolId, setToolId] = useState(exploration.tool_id || '')
  const [kitName, setKitName] = useState('')
  const [toolName, setToolName] = useState('')
  const [goal, setGoal] = useState(exploration.instruction || '')
  const action = useAction()
  const host = (() => { try { return new URL(exploration.start_url).hostname.toLowerCase() } catch { return '' } })()
  const catalog = useSnapshot(() => api.listToolkits(), [])
  const tools = useSnapshot(() => kitId ? api.listTools(kitId) : Promise.resolve([]), [kitId])
  const candidates = catalog.data?.filter(kit => owned ? kit.toolkit_id === exploration.toolkit_id : kit.allowed_domains?.includes(host)) || []
  const availableTools = tools.data?.filter(tool => owned ? tool.tool_id === exploration.tool_id : true) || []
  const incomplete = (!kitId && !kitName.trim()) || (!toolId && (!toolName.trim() || !goal.trim()))
  return <Modal title="到WeWorker中开发" onClose={onClose}>
    <form onSubmit={e => { e.preventDefault(); if (incomplete || disabled || action.busy || catalog.loading || tools.loading) return; void action.run(async () => {
      if (!await useStore.getState().guard()) return
      let targetKit = kitId
      let targetTool = toolId
      if (!targetKit) {
        const created = await api.createToolkit({ name: kitName, allowed_domains: host, description: '' })
        targetKit = created.toolkit_id; setKitId(targetKit); await catalog.refresh()
      }
      if (!targetTool) {
        const created = await api.createTool(targetKit, { name: toolName.trim(), goal: goal.trim(), start_url: exploration.start_url, expected_effect: '' })
        targetTool = created.tool_id; setToolId(targetTool)
      }
      await finishExplorationTransfer({
        toolkitId: targetKit, toolId: targetTool, explorationId: exploration.exploration_id,
        instruction: goal.trim(),
      })
    }) }}>
      <p>选择目标 Adapter 和 Tool，随后打开带有 input.json 和开发提示词的对话，由你点击发送。独立探索记录可以复用于多个 Tool。</p>
      <label>目标 Adapter<RequiredMark /><select aria-label="目标 Adapter" disabled={owned || action.busy} value={kitId} onChange={e => { setKitId(e.target.value); setToolId('') }}>
        {!owned && <option value="">新建 Adapter</option>}
        {candidates.map(kit => <option key={kit.toolkit_id} value={kit.toolkit_id}>{kit.name}</option>)}
      </select></label>
      {!kitId && <label>Adapter 名称<RequiredMark /><input required value={kitName} onChange={e => setKitName(e.target.value)} placeholder="example_site" /><small>允许域名：{host}</small></label>}
      <label>目标 Tool<RequiredMark /><select aria-label="目标 Tool" disabled={owned || action.busy} value={toolId} onChange={e => setToolId(e.target.value)}>
        {!owned && <option value="">新建 Tool</option>}
        {availableTools.map(tool => <option key={tool.tool_id} value={tool.tool_id}>{tool.name}</option>)}
      </select></label>
      {!toolId && <><label>Tool 名称<RequiredMark /><input required value={toolName} onChange={e => setToolName(e.target.value)} placeholder="search_items" /></label><label>功能目标<RequiredMark /><textarea required value={goal} onChange={e => setGoal(e.target.value)} /></label></>}
      <p className="wx-muted">仅列出允许当前站点的 Adapter。本次以当前探索作为开发输入；此处不会替换已有代码、自动发送消息或应用 Adapter。</p>
      <ErrorMessage>{action.error || catalog.error || tools.error}</ErrorMessage>
      <footer><button type="button" data-app-button="action" disabled={action.busy} onClick={onClose}>取消</button><button data-app-button="action" className="wx-primary" disabled={incomplete || disabled || action.busy || catalog.loading || tools.loading}>选择并打开对话</button></footer>
    </form>
  </Modal>
}
