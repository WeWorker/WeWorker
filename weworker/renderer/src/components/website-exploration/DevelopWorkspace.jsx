import AppDropdownSelect from '../common/AppDropdownSelect.jsx'
import React, { useEffect, useState } from 'react'
import * as api from '../../api/website-exploration-api.js'
import { useWebsiteExplorationStore as useStore, changeWebsiteContext } from '../../store/website-exploration.js'
import { ErrorMessage, JsonView, Modal, RequiredMark, ResourceImage, Status, useAction, useDraft, useSnapshot } from './shared.jsx'

export default function DevelopWorkspace({ toolkitId, tool, disabled, globalBusy, modelReady = true }) {
  const scope = toolkitId + '/' + tool.tool_id
  const snapshot = useSnapshot(() => api.getSlots(toolkitId, tool.tool_id), [scope], '/api/toolkits/' + scope.replace('/', '/tools/') + '/development/events')
  const action = useAction(snapshot.refresh)
  const codeDraft = useStore(s => s.codeDraft)
  const [instruction, setInstruction] = useDraft(scope + '/instruction')
  const [initialInstruction, setInitialInstruction] = useDraft(scope + '/initial-instruction')
  const [source, setSource] = useDraft(scope + '/source')
  const [evidence, setEvidence] = useDraft(scope + '/evidence', null)
  const [rebuilding, setRebuilding] = useDraft(scope + '/rebuilding', false)
  const [confirm, setConfirm] = useState(null)
  const [pickedSource, setPickedSource] = useState('')
  const [message, setMessage] = useState('')
  useEffect(() => {
    if (!message) return
    const timer = setTimeout(() => setMessage(''), 5000)
    return () => clearTimeout(timer)
  }, [message])
  const explorations = useSnapshot(() => api.listExplorations(toolkitId, tool.tool_id), [scope])
  const runs = useSnapshot(() => api.listDebugRuns(toolkitId, tool.tool_id), [scope])
  const data = snapshot.data
  const dev = data?.development
  const dirty = Boolean(codeDraft)
  const developing = ['queued', 'running'].includes(data?.latest_run?.status)
  const blocked = disabled || globalBusy || developing || action.busy || dirty || snapshot.loading
  const initial = (!dev && !data?.formal) || rebuilding || (developing && !dev)
  const effectiveSource = source || String(data?.latest_run?.source_exploration_id || '')
  const successful = explorations.data?.filter(item => item.status === 'succeeded') || []
  const perform = (task, feedback) => action.run(async () => { setMessage(''); await task(); setMessage(feedback) })
  const stopDevelopment = () => perform(() => api.cancelDevelopment(toolkitId, tool.tool_id), '已取消本次开发')
  const failure = data?.latest_run?.status === 'failed' && <div key={data.latest_run.development_run_id}>
    <ErrorMessage>{typeof data.latest_run.error === 'string' ? data.latest_run.error : data.latest_run.error?.message || '开发失败，请调整指令后重试。'}</ErrorMessage>
    <RunLog path={'/api/development-runs/' + data.latest_run.development_run_id + '/files/process.log'} label="查看 Developer 日志" />
    {data.latest_run.has_runtime_errors && <RunLog path={'/api/development-runs/' + data.latest_run.development_run_id + '/files/runtime_errors.jsonl'} label="查看异常详情" />}
  </div>
  return <div className="wx-development-workspace">
    <div className="wx-actions wx-development-toolbar">
      {!developing && !initial && (dev ? <>
        <button data-app-button="action" className="wx-quiet" disabled={blocked} onClick={() => setConfirm('discard')}>重新开始</button>
        <button data-app-button="action" className="wx-primary" disabled={blocked || !data.publish_eligible} title="应用后本次修改正式生效" onClick={() => perform(() => api.publishTool(toolkitId, tool.tool_id), '已成功应用到 Adapter')}>应用到 Adapter</button>
      </> : <>
        <button data-app-button="action" className="wx-primary" disabled={blocked} onClick={() => perform(async () => { await api.startDevelopmentFromFormal(toolkitId, tool.tool_id); setRebuilding(false) }, '已基于已应用代码创建本轮开发')}>基于已应用版本开发</button>
        <button data-app-button="action" className="wx-quiet" disabled={blocked} onClick={() => { setPickedSource(successful.some(item => item.exploration_id === source) ? source : successful[0]?.exploration_id || ''); setConfirm('source') }}>从探索重新开发</button>
      </>)}
    </div>
    {message && <p role="status" className="wx-development-notice">{message}</p>}
    <ErrorMessage>{snapshot.error || action.error}</ErrorMessage>
    {snapshot.loading ? <p>正在加载…</p> : data && <>
      {dirty && <p className="wx-development-notice">正在编辑当前开发代码。请先保存或取消修改，再执行其他开发操作。</p>}
      {dev && !data.publish_eligible && !developing && <p className="wx-development-notice">当前修改尚未应用到 Adapter。请先在即时调试区运行一次测试。</p>}
      <div className="wx-development">
        <div className="wx-code-pane">
          {initial ? <section className="wx-dev-card">
            <h3>首次开发</h3><p>来源探索：{effectiveSource || '尚未选择'}</p>
            {!developing && (effectiveSource ? <p className="wx-muted">{rebuilding ? '本轮会完全基于所选探索重新实现此 Tool。点击「开始开发」后才清空当前开发中修改。' : source ? 'Developer Agent 将基于所选探索和下面的指令生成首个实现。' : '上次开发未完成，Developer Agent 将沿用其来源探索和下面的指令重新生成首个实现。'}</p> : <p>请先到探索工作区选择一次成功探索作为开发输入。<button data-app-button="action" className="wx-quiet" onClick={() => changeWebsiteContext({ workspace: 'explore' })}>前往探索</button></p>)}
            {failure}
            <DevelopmentPrompt label="首次开发指令" value={initialInstruction} onChange={setInitialInstruction} placeholder="描述首个实现需要重点关注的内容" hint="必填。该指令会与所选探索一起提供给 Developer Agent。" submitLabel="开始开发" developing={developing} disabled={blocked || !modelReady || !effectiveSource || !initialInstruction.trim()} stopDisabled={disabled || action.busy} onStop={stopDevelopment} onSubmit={() => perform(async () => {
              if (rebuilding) await api.restartDevelopmentFromExploration(toolkitId, tool.tool_id, effectiveSource, initialInstruction)
              else await api.startDevelopment(toolkitId, tool.tool_id, { instruction: initialInstruction, sourceExplorationId: effectiveSource })
              setSource(''); setRebuilding(false); setEvidence(null); setInitialInstruction('')
            }, '已提交开发指令')} />
          </section> : dev ? <>
            <section className="wx-dev-card"><h3>{dev.description || '当前开发代码'}</h3><SlotContract slot={dev} />
              {dirty ? <label><span>开发中 Python 代码<RequiredMark /></span><textarea required className="wx-code-editor" aria-label="开发中 Python 代码" spellCheck={false} value={codeDraft.code} onChange={e => useStore.getState().setCodeDraft({ ...codeDraft, code: e.target.value })} /></label> : <JsonView value={dev.code} />}
              <div className="wx-actions">{dirty ? <><button data-app-button="action" disabled={action.busy} onClick={() => { useStore.getState().setCodeDraft(null); setMessage('已取消代码修改') }}>取消修改</button><button data-app-button="action" className="wx-primary" disabled={disabled || globalBusy || developing || action.busy || !codeDraft.code.trim()} onClick={() => perform(() => useStore.getState().saveCode(), '代码已保存，请重新调试当前版本')}>保存修改</button><span className="wx-muted">只修改 Python 代码；函数签名必须与当前参数 Schema 保持一致。</span></> : <button data-app-button="action" className="wx-quiet" disabled={blocked} onClick={() => useStore.getState().setCodeDraft({ toolkitId, toolId: tool.tool_id, hash: dev.code_hash, code: dev.code })}>编辑代码</button>}</div>
            </section>
            <section className="wx-dev-card wx-agent"><h3>继续开发</h3>
              {failure}
              <label>上下文参考<AppDropdownSelect ariaLabel="上下文参考" className="wx-dropdown" value={evidence?.debug_run_id || ""} disabled={blocked} onChange={value => setEvidence(runs.data?.find(run => run.debug_run_id === value) || null)} options={[{ value: "", label: "关联试运行记录（可选）" }, ...(runs.data || []).map(run => ({ value: run.debug_run_id, label: run.created_at + " · " + run.status + " · " + run.debug_run_id }))]} /></label>
              <ErrorMessage>{runs.error}</ErrorMessage>
              {evidence && <p className="wx-muted">{evidence.code_hash === dev.code_hash ? '当前代码的参考记录' : '旧代码的参考记录'}<button data-app-button="action" className="wx-quiet" disabled={blocked} onClick={() => setEvidence(null)}>清除引用</button></p>}
              <DevelopmentPrompt label="继续开发" value={instruction} onChange={setInstruction} placeholder="描述本次要修改或补充的内容，例如：增加分页参数、修复搜索框定位不稳定的问题" submitLabel="提交" developing={developing} disabled={blocked || !modelReady || !instruction.trim()} stopDisabled={disabled || action.busy} onStop={stopDevelopment} onSubmit={() => perform(async () => { await api.continueDevelopment(toolkitId, tool.tool_id, instruction, evidence?.debug_run_id || ''); if (useStore.getState().drafts[scope + '/instruction'] === instruction) setInstruction('') }, '已提交开发指令')} />
            </section>
          </> : <section className="wx-dev-card">{failure}<p className="wx-empty">尚未开始开发。可以基于已应用版本继续开发，或选择一次成功探索重新开发。</p></section>}
        </div>
        <section className="wx-test-pane">{dev ? <TestRunner toolkitId={toolkitId} tool={tool} slot={dev} channel="development" disabled={blocked} onRefresh={async () => { await snapshot.refresh(); await runs.refresh() }} /> : <div className="wx-dev-card"><p className="wx-empty">请先在左侧开始开发，生成开发中代码。</p></div>}</section>
      </div>
    </>}
    {confirm === 'discard' && <Modal title="重新开始开发" onClose={() => setConfirm(null)}><p>当前开发中的全部修改将被清空且不可恢复。</p><p>已应用版本不受影响。清空后，如需继续开发，请重新选择开发入口。</p><ErrorMessage>{action.error}</ErrorMessage><footer><button data-app-button="action" onClick={() => setConfirm(null)}>取消</button><button data-app-button="action" data-variant="danger" className="wx-danger" disabled={blocked} onClick={() => perform(async () => { await api.restartDevelopment(toolkitId, tool.tool_id); setSource(''); setRebuilding(false); setEvidence(null); setConfirm(null) }, '已清空本次开发的全部修改')}>确认清空</button></footer></Modal>}
    {confirm === 'source' && <Modal title="从探索重新开发" onClose={() => setConfirm(null)}><p>选择当前 Tool 的一次成功探索，Developer Agent 将完全基于该探索重新实现此 Tool。</p><ErrorMessage>{explorations.error}</ErrorMessage>{successful.length ? <fieldset aria-label="探索记录"><legend>探索记录<RequiredMark /></legend>{successful.map(item => <label className="wx-exploration-choice" key={item.exploration_id}><input required type="radio" name="development-source" value={item.exploration_id} checked={pickedSource === item.exploration_id} onChange={() => setPickedSource(item.exploration_id)} /><span>{item.exploration_id}</span><Status value={item.status} /><span className="wx-muted">{item.created_at}</span></label>)}</fieldset> : <p>当前 Tool 没有成功的探索，请先到探索工作区完成一次探索。</p>}<p>已应用版本不受影响；选择后先填写开发指令，真正开始开发时才清空当前开发中修改。</p><footer><button data-app-button="action" onClick={() => setConfirm(null)}>取消</button><button data-app-button="action" className="wx-primary" disabled={blocked || !successful.some(item => item.exploration_id === pickedSource)} onClick={() => { setSource(pickedSource); setRebuilding(true); setEvidence(null); setConfirm(null); setMessage('已选择探索，请填写开发指令后开始重新开发') }}>选择并填写指令</button></footer></Modal>}
  </div>
}

function DevelopmentPrompt({ label, value, onChange, placeholder, hint, submitLabel, developing, disabled, stopDisabled, onSubmit, onStop }) {
  return <div className="wx-development-prompt">
    <label><span>{label}<RequiredMark /></span><textarea aria-label={label} required value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} /></label>
    <div className="wx-development-prompt-footer">
      <span className="wx-muted" role={developing ? 'status' : undefined}>{developing ? '正在开发，完成后自动更新代码。可先填写下一条指令。' : hint}</span>
      <button type="button" className={'chat-input-action wx-development-send ' + (developing ? 'chat-input-action-stop' : 'chat-input-action-send')} aria-label={developing ? '停止开发' : submitLabel} title={developing ? '停止开发' : submitLabel} disabled={developing ? stopDisabled : disabled} onClick={developing ? onStop : onSubmit} />
    </div>
  </div>
}

function SlotContract({ slot }) {
  const describe = schema => Object.entries(schema?.properties || {}).map(([name, field]) => name + (schema.required?.includes(name) ? '*' : '') + ':' + field.type).join('、') || '—'
  return <dl className="wx-dev-facts"><dt>参数</dt><dd>{describe(slot.parameters_schema)}</dd><dt>返回</dt><dd>{describe(slot.result_schema)}</dd><dt>requires</dt><dd>{slot.requires?.join('、') || '—'}</dd><dt>ensures</dt><dd>{slot.ensures?.join('、') || '—'}</dd><dt>副作用</dt><dd>{slot.side_effects?.join('、') || '无'}</dd></dl>
}

export function collectParameters(schema, values) {
  const result = {}
  for (const [name, property] of Object.entries(schema?.properties || {})) {
    const value = values[name] ?? property.default
    if (value === undefined || (typeof value === 'string' && !value.trim())) {
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
  const [values, setValues] = useDraft(scope + '/params/' + (slot.distribution_hash || slot.code_hash), {})
  const selected = useStore(s => s.selections[scope + '/run'])
  const runs = useSnapshot(() => api.listDebugRuns(toolkitId, tool.tool_id), [scope])
  const history = runs.data?.filter(run => run.channel === channel) || []
  const id = history.some(run => run.debug_run_id === selected) ? selected : history[0]?.debug_run_id
  const snapshot = useSnapshot(() => id ? api.request('/api/debug-runs/' + id) : Promise.resolve(null), [id], id ? '/api/debug-runs/' + id + '/events' : null)
  const action = useAction(async () => { await runs.refresh(); await snapshot.refresh(); await onRefresh?.() })
  const run = snapshot.data
  const development = channel === 'development'
  const [parametersTouched, setParametersTouched] = useState(false)
  let parameterError = ''
  try { collectParameters(slot.parameters_schema, values) } catch (error) { parameterError = error.message }
  const [message, setMessage] = useState('')
  return <>
    <section className={development ? 'wx-dev-card' : undefined}>
    {development && <h3>即时调试</h3>}
    <form onSubmit={e => { e.preventDefault(); if (parameterError) return; void action.run(async () => {
      const result = await api.runDebugTool(toolkitId, tool.tool_id, channel, collectParameters(slot.parameters_schema, values), slot.distribution_hash)
      useStore.getState().selectRecord(scope + '/run', result.debug_run_id)
      setMessage('已提交测试运行')
    }) }}>
      <fieldset disabled={disabled || action.busy} onBlur={() => setParametersTouched(true)} onChange={() => setParametersTouched(true)}>
      {Object.entries(slot.parameters_schema?.properties || {}).map(([name, field]) => <label key={name}><span>{name}{slot.parameters_schema.required?.includes(name) && <RequiredMark />}</span>
        {field.type === 'boolean' || field.enum ? <AppDropdownSelect className="wx-dropdown" ariaLabel={name + (slot.parameters_schema.required?.includes(name) ? ' *' : '')} required={slot.parameters_schema.required?.includes(name)} disabled={disabled || action.busy} value={String(values[name] ?? field.default ?? '')} onChange={value => { setValues({ ...values, [name]: value }); setParametersTouched(true) }} options={[{ value: '', label: '请选择' }, ...(field.type === 'boolean' ? [{ value: 'true', label: '是' }, { value: 'false', label: '否' }] : field.enum.map(value => ({ value: String(value), label: String(value) })))]} /> : <input aria-label={name + (slot.parameters_schema.required?.includes(name) ? ' *' : '')} required={slot.parameters_schema.required?.includes(name)} type={['integer', 'number'].includes(field.type) ? 'number' : 'text'} step={field.type === 'integer' ? '1' : 'any'} value={typeof (values[name] ?? field.default) === 'object' ? JSON.stringify(values[name] ?? field.default) : values[name] ?? field.default ?? ''} onChange={e => setValues({ ...values, [name]: e.target.value })} />}
        {field.description && <small>{field.description}</small>}
      </label>)}
      </fieldset>
      {!Object.keys(slot.parameters_schema?.properties || {}).length && <p>该 Tool 无需业务参数。</p>}
      <button data-app-button="action" className={primary ? "wx-primary" : "wx-quiet"} disabled={disabled || action.busy || Boolean(parameterError)} title={parameterError || undefined}>{channel === 'formal' ? '验证正式产物' : '运行测试'}</button>
    </form>
    {message && <p role="status">{message}</p>}
    <ErrorMessage>{(parametersTouched && parameterError) || action.error || runs.error || snapshot.error}</ErrorMessage>
    </section>
    <section className={development ? 'wx-dev-card' : undefined}>
    {development && <h3>试运行历史</h3>}
    <label>运行历史<AppDropdownSelect ariaLabel="运行历史" className="wx-dropdown" value={id || ""} onChange={value => useStore.getState().selectRecord(scope + "/run", value)} options={[{ value: "", label: "暂无运行" }, ...history.map(item => ({ value: item.debug_run_id, label: item.created_at + " · " + item.status }))]} /></label>
    {run && <><RunDetail run={run} /><p>{development ? (run.code_hash === slot.code_hash ? '当前代码的结果' : '旧代码的结果') : (run.distribution_hash === slot.distribution_hash ? '当前产物的结果' : '旧产物的结果')}</p>
      {['queued', 'running'].includes(run.status) && <button data-app-button="action" disabled={action.busy} onClick={() => action.run(() => api.cancelDebugRun(run.debug_run_id))}>取消运行</button>}
      {run.status === 'failed' && onEvidence && <button data-app-button="action" disabled={disabled} onClick={() => onEvidence(run)}>作为修复依据</button>}
    </>}
    </section>
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
