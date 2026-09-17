import React, { useState } from 'react'
import * as api from '../../api/website-exploration-api.js'
import { useWebsiteExplorationStore as useStore, changeWebsiteContext } from '../../store/website-exploration.js'
import { ActionMenu, ErrorMessage, JsonView, Modal, ResourceImage, Status, useAction, useDraft, useSnapshot } from './shared.jsx'

export default function DevelopWorkspace({ toolkitId, tool, disabled, globalBusy }) {
  const scope = toolkitId + '/' + tool.tool_id
  const snapshot = useSnapshot(() => api.getSlots(toolkitId, tool.tool_id), [scope], '/api/toolkits/' + scope.replace('/', '/tools/') + '/development/events')
  const action = useAction(snapshot.refresh)
  const codeDraft = useStore(s => s.codeDraft)
  const [instruction, setInstruction] = useDraft(scope + '/instruction')
  const [source, setSource] = useDraft(scope + '/source')
  const [evidence, setEvidence] = useDraft(scope + '/evidence', null)
  const [confirm, setConfirm] = useState(null)
  const data = snapshot.data
  const dev = data?.development
  const slot = dev || data?.formal
  const dirty = Boolean(codeDraft)
  const blocked = disabled || globalBusy || action.busy || dirty
  const explorations = useSnapshot(() => api.listExplorations(toolkitId, tool.tool_id), [scope])
  return <div className="wx-development">
    <section className="wx-code-pane">
      <header><h2>{dev ? '开发中版本' : data?.formal ? '已应用版本' : '开始开发'}</h2><div className="wx-actions">
        {dev && !dirty && <button disabled={disabled || globalBusy} onClick={() => useStore.getState().setCodeDraft({ toolkitId, toolId: tool.tool_id, hash: dev.code_hash, code: dev.code })}>编辑代码</button>}
        {dirty && <><button disabled={action.busy} onClick={() => useStore.getState().setCodeDraft(null)}>取消修改</button><button className="wx-primary" disabled={disabled || globalBusy || action.busy} onClick={() => action.run(() => useStore.getState().saveCode())}>保存修改</button></>}
      </div></header>
      <ErrorMessage>{snapshot.error || action.error}</ErrorMessage>
      {snapshot.loading && <p>正在加载…</p>}
      {slot && (dirty ? <textarea className="wx-code-editor" aria-label="开发中 Python 代码" spellCheck={false} value={codeDraft.code} onChange={e => useStore.getState().setCodeDraft({ ...codeDraft, code: e.target.value })} /> : <JsonView value={slot.code} />)}
      {slot && <details><summary>运行契约</summary><JsonView value={{ parameters: slot.parameters_schema, result: slot.result_schema, requires: slot.requires, ensures: slot.ensures }} /></details>}
      {dirty && <p>保存当前修改后才能测试或提交给 Agent。</p>}
      <div className="wx-actions">
        {dev && !dirty && <button className="wx-quiet" disabled={blocked || !data?.publish_eligible} title={!data?.publish_eligible ? '请先通过当前代码的测试' : ''} onClick={() => action.run(() => api.publishTool(toolkitId, tool.tool_id))}>应用到 Adapter</button>}
        {data?.formal && !dev && <button disabled={blocked} onClick={() => action.run(() => api.startDevelopmentFromFormal(toolkitId, tool.tool_id))}>基于已应用版本开发</button>}
        {dev && !dirty && <ActionMenu compact label="开发版本操作"><button disabled={blocked} onClick={() => setConfirm('discard')}>放弃开发中版本</button></ActionMenu>}

      </div>
      {!data?.publish_eligible && dev && <p className="wx-muted">当前修改尚未应用，请先通过即时测试。</p>}
      <section className="wx-agent">
        <h3>Developer Agent</h3>
        <label>探索依据<select value={source} disabled={blocked} onChange={e => setSource(e.target.value)}><option value="">选择探索记录</option>{explorations.data?.map(item => <option key={item.exploration_id} value={item.exploration_id}>{item.created_at} · {item.status}</option>)}</select></label>
        {dev?.source_exploration_id && <p>当前开发来源：{dev.source_exploration_id}</p>}
        {evidence && <p>修复依据：{evidence.debug_run_id} {evidence.code_hash !== slot?.code_hash ? '（来自旧代码版本）' : '（当前代码）'} <button onClick={() => setEvidence(null)}>移除</button></p>}
        <label>开发指令<textarea value={instruction} onChange={e => setInstruction(e.target.value)} placeholder="描述需要开发或修复的行为" /></label>
        <div className="wx-actions"><button className="wx-quiet" disabled={blocked || !instruction.trim() || (!dev && !source)} onClick={() => action.run(async () => {
          if (dev) await api.continueDevelopment(toolkitId, tool.tool_id, instruction, evidence?.debug_run_id || '')
          else await api.startDevelopment(toolkitId, tool.tool_id, { instruction, sourceExplorationId: source })
          setInstruction('')
        })}>提交给 Developer Agent</button>
          {dev && source && <button disabled={blocked || !instruction.trim()} onClick={() => setConfirm('restart')}>从所选探索重新开发</button>}
          {['queued', 'running'].includes(data?.latest_run?.status) && <button disabled={disabled || action.busy} onClick={() => action.run(() => api.cancelDevelopment(toolkitId, tool.tool_id))}>取消开发</button>}
        </div>
        {data?.latest_run && <details><summary>最近开发运行 · <Status value={data.latest_run.status} /></summary><RunDetail run={data.latest_run} /></details>}
      </section>
    </section>
    <section className="wx-test-pane"><h2>即时测试</h2>{dev ? <TestRunner toolkitId={toolkitId} tool={tool} slot={dev} channel="development" disabled={blocked} onRefresh={snapshot.refresh} onEvidence={setEvidence} /> : <p className="wx-empty">生成或创建开发中版本后，在这里测试当前修改。</p>}</section>
    {confirm && <Modal title={confirm === 'discard' ? '放弃开发中版本' : '重新开发'} onClose={() => setConfirm(null)}><p>这会替换或移除当前开发中版本，已应用版本保留。</p><ErrorMessage>{action.error}</ErrorMessage><footer><button onClick={() => setConfirm(null)}>取消</button><button disabled={action.busy} onClick={() => action.run(async () => {
      if (confirm === 'discard') await api.restartDevelopment(toolkitId, tool.tool_id)
      else await api.restartDevelopmentFromExploration(toolkitId, tool.tool_id, source, instruction)
      setConfirm(null)
    })}>确认</button></footer></Modal>}
  </div>
}

export function collectParameters(schema, values) {
  const result = {}
  for (const [name, property] of Object.entries(schema?.properties || {})) {
    const value = values[name] ?? property.default
    if (value === undefined || value === '') {
      if (schema.required?.includes(name)) throw new Error('请填写参数：' + name)
      continue
    }
    if (property.type === 'boolean') result[name] = value === true || value === 'true'
    else if (['integer', 'number'].includes(property.type)) {
      const number = Number(value)
      if (!Number.isFinite(number) || (property.type === 'integer' && !Number.isInteger(number))) throw new Error('参数格式不正确：' + name)
      result[name] = number
    } else if (['object', 'array'].includes(property.type)) {
      try { result[name] = typeof value === 'string' ? JSON.parse(value) : value } catch { throw new Error('参数需要有效 JSON：' + name) }
      if (property.type === 'array' ? !Array.isArray(result[name]) : !result[name] || typeof result[name] !== 'object' || Array.isArray(result[name])) throw new Error('参数类型不正确：' + name)
    } else result[name] = value
    if (property.enum && !property.enum.includes(result[name])) throw new Error('请选择有效参数：' + name)
  }
  return result
}

export function TestRunner({ toolkitId, tool, slot, channel, disabled, onRefresh, onEvidence, primary = true }) {
  const scope = toolkitId + '/' + tool.tool_id + '/' + channel
  const [values, setValues] = useDraft(scope + '/params/' + slot.code_hash, {})
  const selected = useStore(s => s.selections[scope + '/run'])
  const runs = useSnapshot(() => api.listDebugRuns(toolkitId, tool.tool_id), [scope])
  const history = runs.data?.filter(run => run.channel === channel) || []
  const id = history.some(run => run.debug_run_id === selected) ? selected : history[0]?.debug_run_id
  const snapshot = useSnapshot(() => id ? api.request('/api/debug-runs/' + id) : Promise.resolve(null), [id], id ? '/api/debug-runs/' + id + '/events' : null)
  const action = useAction(async () => { await runs.refresh(); await snapshot.refresh(); await onRefresh?.() })
  const run = snapshot.data
  return <>
    <form onSubmit={e => { e.preventDefault(); void action.run(async () => {
      const result = await api.runDebugTool(toolkitId, tool.tool_id, channel, collectParameters(slot.parameters_schema, values))
      useStore.getState().selectRecord(scope + '/run', result.debug_run_id)
    }) }}>
      <fieldset disabled={disabled || action.busy}>
      {Object.entries(slot.parameters_schema?.properties || {}).map(([name, field]) => <label key={name}>{name}{slot.parameters_schema.required?.includes(name) ? ' *' : ''}
        {field.type === 'boolean' ? <select value={String(values[name] ?? field.default ?? '')} onChange={e => setValues({ ...values, [name]: e.target.value })}><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select> : field.enum ? <select value={values[name] ?? field.default ?? ''} onChange={e => setValues({ ...values, [name]: e.target.value })}><option value="">请选择</option>{field.enum.map(value => <option key={String(value)} value={value}>{String(value)}</option>)}</select> : <input type={['integer', 'number'].includes(field.type) ? 'number' : 'text'} step={field.type === 'integer' ? '1' : 'any'} value={typeof (values[name] ?? field.default) === 'object' ? JSON.stringify(values[name] ?? field.default) : values[name] ?? field.default ?? ''} onChange={e => setValues({ ...values, [name]: e.target.value })} />}
        {field.description && <small>{field.description}</small>}
      </label>)}
      </fieldset>
      {!Object.keys(slot.parameters_schema?.properties || {}).length && <p>该 Tool 无需业务参数。</p>}
      <button className={primary ? "wx-primary" : "wx-quiet"} disabled={disabled || action.busy}>{channel === 'formal' ? '验证正式产物' : '测试当前代码'}</button>
    </form>
    <ErrorMessage>{action.error || runs.error || snapshot.error}</ErrorMessage>
    <label>运行历史<select value={id || ''} onChange={e => useStore.getState().selectRecord(scope + '/run', e.target.value)}><option value="">暂无运行</option>{history.map(item => <option key={item.debug_run_id} value={item.debug_run_id}>{item.created_at} · {item.status}</option>)}</select></label>
    {run && <><RunDetail run={run} /><p>{run.code_hash === slot.code_hash ? '当前代码的结果' : '旧代码的结果'}</p>
      {['queued', 'running'].includes(run.status) && <button disabled={action.busy} onClick={() => action.run(() => api.cancelDebugRun(run.debug_run_id))}>取消运行</button>}
      {run.status === 'failed' && onEvidence && <button disabled={disabled} onClick={() => onEvidence(run)}>作为修复依据</button>}
    </>}
  </>
}

export function RunDetail({ run }) {
  return <section className="wx-run"><Status value={run.status} />
    {run.error && <ErrorMessage>{typeof run.error === 'string' ? run.error : run.error.message}</ErrorMessage>}
    {run.result !== undefined && <><h3>运行结果</h3><JsonView value={run.result} /></>}
    {run.summary && <p>{run.summary}</p>}
    {run.before_page && <details><summary>执行前页面</summary><p>{run.before_page.title}</p><p className="wx-url">{run.before_page.url}</p><ResourceImage path={run.before_page.screenshot_url} /></details>}
    {run.after_page && <details><summary>执行后页面</summary><p>{run.after_page.title}</p><p className="wx-url">{run.after_page.url}</p><ResourceImage path={run.after_page.screenshot_url} /></details>}
    {run.logs && <details><summary>运行日志</summary><JsonView value={run.logs} /></details>}
    {run.development_run_id && <><RunLog path={'/api/development-runs/' + run.development_run_id + '/files/process.log'} label="Developer 日志" />{run.has_runtime_errors && <RunLog path={'/api/development-runs/' + run.development_run_id + '/files/runtime_errors.jsonl'} label="异常详情" />}</>}
  </section>
}

function RunLog({ path, label }) {
  const [text, setText] = useState('')
  const action = useAction()
  return <details onToggle={e => { if (e.currentTarget.open && !text) void action.run(async () => { const blob = await api.resourceBlob(path); setText(await blob.text()) }) }}><summary>{label}</summary><ErrorMessage>{action.error}</ErrorMessage><JsonView value={text || '正在读取…'} /></details>
}
