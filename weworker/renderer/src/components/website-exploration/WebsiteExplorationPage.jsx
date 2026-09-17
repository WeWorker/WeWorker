import React, { useEffect, useState } from 'react'
import * as api from '../../api/website-exploration-api.js'
import { useWebsiteExplorationStore as useStore, changeWebsiteContext } from '../../store/website-exploration.js'
import { useToolPackagePageStore } from '../../store/tool-package-page.js'
import ExploreWorkspace from './ExploreWorkspace.jsx'
import DevelopWorkspace, { TestRunner } from './DevelopWorkspace.jsx'
import { ActionMenu, Icon, ErrorMessage, Modal, Status, useAction, useDraft, useSnapshot } from './shared.jsx'
import './website-exploration.css'

export default function WebsiteExplorationPage({ onOpenSettings }) {
  const toolkitId = useStore(s => s.toolkitId)
  const toolId = useStore(s => s.toolId)
  const workspace = useStore(s => s.workspace)
  const [search, setSearch] = useDraft('adapter-search')
  const [treeVisible, setTreeVisible] = useState(true)
  const [modal, setModal] = useState(null)
  const [expanded, setExpanded] = useState({})
  const catalog = useSnapshot(async () => {
    const kits = await api.listToolkits()
    return Promise.all(kits.map(async kit => ({ ...kit, tools: await api.listTools(kit.toolkit_id) })))
  }, [])
  const status = useSnapshot(async () => {
    const [health, browser, activity] = await Promise.all([api.getHealth(), api.getBrowserStatus(), api.getActivity()])
    useStore.setState({ activity, connection: 'running' })
    return { health, browser, activity }
  }, [])
  const action = useAction(async () => { await catalog.refresh(); await status.refresh() })
  const kit = catalog.data?.find(item => item.toolkit_id === toolkitId)
  const tool = kit?.tools.find(item => item.tool_id === toolId)
  const unavailable = Boolean(status.error || !status.data)
  const globalBusy = Boolean(status.data?.activity.running)
  useEffect(() => {
    if (toolkitId) setExpanded(current => toolkitId in current ? current : { ...current, [toolkitId]: true })
  }, [toolkitId])
  useEffect(() => {
    if (!catalog.data) return
    const nextKit = catalog.data.find(item => item.toolkit_id === toolkitId) || catalog.data[0]
    const nextTool = nextKit?.tools.find(item => item.tool_id === toolId) || nextKit?.tools[0]
    if (nextKit?.toolkit_id !== toolkitId || (nextTool?.tool_id || '') !== toolId) {
      useStore.setState({ toolkitId: nextKit?.toolkit_id || '', toolId: nextTool?.tool_id || '' })
    }
  }, [catalog.data, toolkitId, toolId])
  const query = search.trim().toLowerCase()
  const matches = item => (item.name + ' ' + item.toolkit_id).toLowerCase().includes(query)
  return <div className="website-exploration wx-page">
    <header className="wx-topbar"><div className="wx-actions"><button className="wx-icon-button" title="Adapter 列表" aria-label="Adapter 列表" aria-expanded={treeVisible} onClick={() => setTreeVisible(!treeVisible)}><Icon name="panel" /></button><h1>网站探索agent</h1></div>
      <div className="wx-actions">
        {globalBusy && <button className="wx-quiet" onClick={() => { const activity = status.data.activity; void changeWebsiteContext({ toolkitId: activity.toolkit_id || toolkitId, toolId: activity.tool_id || toolId, workspace: activity.kind === 'development' ? 'develop' : activity.kind === 'debug' ? 'verify' : 'explore' }) }}>查看当前活动</button>}
        <ActionMenu label={unavailable ? '服务未就绪' : status.data?.browser.running ? '浏览器已连接' : '浏览器未连接'}>
          <button onClick={onOpenSettings}>模型设置</button><button disabled={action.busy || unavailable} onClick={() => action.run(() => api.openBrowser(tool?.start_url || ''))}>打开浏览器</button>
        </ActionMenu>
        {!unavailable && !status.data?.browser.running && <button onClick={() => action.run(() => api.openBrowser(tool?.start_url || ''))} disabled={action.busy}>连接浏览器</button>}
      </div>
    </header>
    <ErrorMessage>{status.error || catalog.error || action.error}</ErrorMessage>
    {unavailable && <div className="wx-actions"><p>正在等待客户端托管的网站探索服务。连接恢复后会自动同步。</p><button onClick={() => action.run(async () => {})}>重新检查</button></div>}
    <div className="wx-layout">
      {treeVisible && <aside className="wx-tree" aria-label="Adapter 目录">
        <header><h2>Adapters</h2><button className="wx-icon-button" aria-label="新建 Adapter" title="新建 Adapter" disabled={unavailable || globalBusy} onClick={() => setModal({ kind: 'kit', create: true })}><Icon name="plus" /></button></header>
        <input aria-label="搜索 Adapter 或 Tool" placeholder="搜索 Adapter 或 Tool" value={search} onChange={e => setSearch(e.target.value)} />
        {catalog.data?.filter(item => matches(item) || item.tools.some(t => (t.name + ' ' + t.tool_id).toLowerCase().includes(query))).map(item => {
          const isOpen = Boolean(query) || (expanded[item.toolkit_id] ?? item.toolkit_id === toolkitId)
          const selectedKit = item.toolkit_id === toolkitId
          return <section key={item.toolkit_id}>
            <div className={'wx-tree-row ' + (selectedKit ? 'is-parent' : '')}>
              <button className={'wx-icon-button wx-disclosure ' + (isOpen ? 'is-open' : '')} aria-label={'展开 ' + item.name} aria-expanded={isOpen} onClick={() => setExpanded({ ...expanded, [item.toolkit_id]: !isOpen })}><Icon name="chevron" /></button>
              <button className="wx-tree-kit" title={item.name} onClick={() => changeWebsiteContext({ toolkitId: item.toolkit_id, toolId: item.tools[0]?.tool_id || '' })}>{item.name}</button>
              <small>{item.tools.length}</small>
              <ActionMenu compact label={item.name + ' 操作'}>
                <button disabled={unavailable || globalBusy} onClick={() => setModal({ kind: 'tool', create: true, toolkitId: item.toolkit_id })}>新建 Tool</button>
                <button disabled={unavailable || globalBusy} onClick={() => setModal({ kind: 'kit', value: item, toolkitId: item.toolkit_id })}>管理 Adapter</button>
              </ActionMenu>
            </div>
            {isOpen && item.tools.filter(t => !query || matches(item) || (t.name + ' ' + t.tool_id).toLowerCase().includes(query)).map(t => <div key={t.tool_id} className={'wx-tree-row wx-tool-row ' + (selectedKit && t.tool_id === toolId ? 'is-selected' : '')}>
              <Icon name="tool" /><button className="wx-tree-tool" aria-current={selectedKit && t.tool_id === toolId ? 'page' : undefined} title={t.name} onClick={() => changeWebsiteContext({ toolkitId: item.toolkit_id, toolId: t.tool_id })}>{t.name}</button>
              <ActionMenu compact label={t.name + ' 操作'}><button disabled={unavailable || globalBusy} onClick={() => setModal({ kind: 'tool', value: t, toolkitId: item.toolkit_id })}>管理 Tool</button></ActionMenu>
            </div>)}
          </section>
        })}
        {query && catalog.data && !catalog.data.some(item => matches(item) || item.tools.some(t => (t.name + ' ' + t.tool_id).toLowerCase().includes(query))) && <p className="wx-muted">没有匹配的 Adapter 或 Tool</p>}
        {!catalog.loading && !catalog.data?.length && <p>还没有 Adapter，点击上方新增入口创建。</p>}
      </aside>}
      <main className="wx-main">
        {kit ? <><header className="wx-context"><div><div className="wx-breadcrumb"><span>{kit.name}</span>{tool && <><span aria-hidden="true">/</span><strong>{tool.name}</strong></>}</div><p>{kit.description}</p></div></header>
          <nav className="wx-tabs" aria-label="网站探索工作区">{[['explore', '探索'], ['develop', '开发'], ['verify', 'Adapter 验证']].map(([id, label]) => <button key={id} aria-current={workspace === id ? 'page' : undefined} className={workspace === id ? 'is-active' : ''} onClick={() => changeWebsiteContext({ workspace: id })}>{label}</button>)}</nav>
          <div className="wx-workspace">{workspace === 'verify' ? <VerifyWorkspace key={kit.toolkit_id} kit={kit} tool={tool} disabled={unavailable} globalBusy={globalBusy} /> : tool ? workspace === 'develop' ? <DevelopWorkspace key={toolkitId + '/' + toolId} toolkitId={toolkitId} tool={tool} disabled={unavailable} globalBusy={globalBusy} /> : <ExploreWorkspace key={toolkitId + '/' + toolId} toolkitId={toolkitId} tool={tool} disabled={unavailable} globalBusy={globalBusy} /> : <div className="wx-empty">创建一个 Tool，说明目标、起始网址和预期效果。</div>}</div>
        </> : <div className="wx-empty">{catalog.loading ? '正在加载 Adapter…' : '创建或选择 Adapter，开始探索网站能力。'}</div>}
      </main>
    </div>
    {modal && <ManageModal config={modal} toolkitId={modal.toolkitId || toolkitId} onClose={() => setModal(null)} onSaved={async () => { setModal(null); await catalog.refresh() }} />}
  </div>
}

function ManageModal({ config, toolkitId, onClose, onSaved }) {
  const isKit = config.kind === 'kit'
  const [values, setValues] = useState({ ...config.value, allowed_domains: config.value?.allowed_domains?.join('\n') || '' })
  const [deleting, setDeleting] = useState(false)
  const action = useAction()
  const fields = isKit ? [['name', 'Adapter 名称'], ['description', '描述'], ['allowed_domains', '允许域名，一行一个']] : [['name', 'Tool 名称'], ['goal', '功能目标'], ['start_url', '起始网址'], ['expected_effect', '运行后预期效果']]
  return <Modal title={(config.create ? '新建' : '管理') + (isKit ? ' Adapter' : ' Tool')} onClose={onClose}>
    <form onSubmit={e => { e.preventDefault(); void action.run(async () => {
      const body = { ...values }
      if (isKit) body.allowed_domains = String(values.allowed_domains || '').split(/[,，\s]+/).filter(Boolean)
      if (config.create) {
        if (isKit) { const result = await api.createToolkit({ ...values }); await changeWebsiteContext({ toolkitId: result.toolkit_id, toolId: '' }) }
        else { const result = await api.createTool(toolkitId, body); await changeWebsiteContext({ toolkitId, toolId: result.tool_id }) }
      } else if (isKit) await api.updateToolkit(toolkitId, body)
      else await api.updateTool(toolkitId, config.value.tool_id, body)
      await onSaved()
    }) }}>
      {fields.map(([name, label]) => <label key={name}>{label}<input disabled={name === 'name' && !config.create} required={['name', 'allowed_domains', 'goal', 'start_url'].includes(name)} value={values[name] || ''} onChange={e => setValues({ ...values, [name]: e.target.value })} /></label>)}
      <ErrorMessage>{action.error}</ErrorMessage><footer>{!config.create && <button type="button" className="wx-danger" onClick={() => setDeleting(true)}>删除</button>}<button type="button" onClick={onClose}>取消</button><button className="wx-primary" disabled={action.busy}>保存</button></footer>
    </form>
    {deleting && <section className="wx-delete"><p>确认删除{isKit ? '此 Adapter 及其 Tool' : '此 Tool'}？相关内容将被移除。</p><button onClick={() => setDeleting(false)}>取消删除</button><button className="wx-danger" disabled={action.busy} onClick={() => action.run(async () => {
      if (!await useStore.getState().guard()) return
      if (isKit) await api.deleteToolkit(toolkitId)
      else await api.deleteTool(toolkitId, config.value.tool_id)
      await onSaved()
    })}>确认删除</button></section>}
  </Modal>
}

function VerifyWorkspace({ kit, tool, disabled, globalBusy }) {
  const snapshot = useSnapshot(() => api.getExportStatus(kit.toolkit_id), [kit.toolkit_id])
  const slots = useSnapshot(() => tool ? api.getSlots(kit.toolkit_id, tool.tool_id) : Promise.resolve(null), [kit.toolkit_id, tool?.tool_id])
  const [message, setMessage] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [installedSkill, setInstalledSkill] = useState('')
  const action = useAction(snapshot.refresh)
  const eligible = snapshot.data?.export_eligible
  return <div className="wx-verify"><header><div><h2>正式产物验证</h2><p>全部正式 Tool 通过当前产物验证后，即可导出或安装。</p></div><div className="wx-actions">
    <button disabled={!eligible || disabled || globalBusy || action.busy} onClick={() => action.run(async () => {
      if (window.electronAPI?.downloadWebsiteAdapter) {
        setDownloading(true)
        try {
          const result = await window.electronAPI.downloadWebsiteAdapter(kit.toolkit_id)
          setMessage(result.saved ? 'Adapter 已导出' : '已取消导出')
        } finally { setDownloading(false) }
        return
      }
      const blob = await api.resourceBlob(api.exportToolkitUrl(kit.toolkit_id))
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a'); link.href = url; link.download = kit.name + '.zip'; link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    })}>导出 Adapter</button>
    {downloading && <button onClick={() => window.electronAPI?.cancelWebsiteAdapterDownload?.()}>取消导出</button>}
    <button className={eligible ? "wx-primary" : "wx-quiet"} disabled={!eligible || disabled || globalBusy || action.busy} onClick={() => action.run(async () => {
      const result = await api.installToolkitToWeWorker(kit.toolkit_id)
      setInstalledSkill(result.skill_name || '')
      setMessage(result.status === 'updated' ? 'Adapter 已更新' : result.status === 'unchanged' ? '已安装最新版本' : 'Adapter 已安装')
      useToolPackagePageStore.setState(s => ({ openSessionId: s.openSessionId + 1 }))
    })}>安装到 WeWorker</button>
  </div></header>
    <ErrorMessage>{snapshot.error || slots.error || action.error}</ErrorMessage>{message && <p role="status">{message} {installedSkill && <button onClick={async () => { if (await useStore.getState().guard()) { useStore.setState({ open: false }); useToolPackagePageStore.getState().openPage('', { publicSkillName: installedSkill }) } }}>查看已安装能力</button>}</p>}
    {!eligible && <p>待验证：{snapshot.data?.unverified_tools?.join('、') || '请先将开发中版本应用到 Adapter'}</p>}
    <table><thead><tr><th>Tool</th><th>当前产物</th></tr></thead><tbody>{snapshot.data?.tools?.map(item => <tr key={item.tool_id}><td><button className="wx-quiet" aria-current={tool?.tool_id === item.tool_id ? 'true' : undefined} onClick={() => changeWebsiteContext({ toolId: item.tool_id })}>{item.tool_id}</button></td><td>{item.verified ? '已验证' : '待验证'}</td></tr>)}</tbody></table>
    {tool && slots.data?.formal && <section><h3>{tool.name}</h3><TestRunner key={tool.tool_id} toolkitId={kit.toolkit_id} tool={tool} slot={slots.data.formal} channel="formal" primary={!eligible} disabled={disabled || globalBusy} onRefresh={snapshot.refresh} onEvidence={run => action.run(async () => {
      if (!slots.data.development) await api.startDevelopmentFromFormal(kit.toolkit_id, tool.tool_id)
      useStore.getState().setDraft(kit.toolkit_id + '/' + tool.tool_id + '/evidence', run)
      await changeWebsiteContext({ workspace: 'develop' })
    })} /></section>}
  </div>
}

export function WebsiteExplorationGuard() {
  const leave = useStore(s => s.leaveRequest)
  const action = useAction()
  useEffect(() => {
    const sync = state => window.electronAPI?.setExplorationDirty?.(Boolean(state.codeDraft))
    sync(useStore.getState())
    const unsubscribe = useStore.subscribe(sync)
    const offLeave = window.electronAPI?.onExplorationLeave?.(() => useStore.getState().guard())
    let polling = false
    const activityTimer = setInterval(async () => {
      if (polling || useStore.getState().open || useStore.getState().connection === 'starting') return
      polling = true
      try { useStore.setState({ activity: await api.getActivity(), connection: 'running' }) }
      catch { useStore.setState({ connection: 'error', activity: { running: false } }) }
      finally { polling = false }
    }, 5000)
    const beforeUnload = event => {
      if (!useStore.getState().codeDraft) return
      event.preventDefault(); event.returnValue = ''
      void useStore.getState().guard()
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => { window.removeEventListener('beforeunload', beforeUnload); unsubscribe(); offLeave?.(); clearInterval(activityTimer) }
  }, [])
  if (!leave) return null
  return <Modal title="有未保存的代码修改" onClose={() => useStore.getState().resolveLeave(false)}><p>保存当前代码后继续，或明确放弃修改。</p><ErrorMessage>{action.error}</ErrorMessage><footer>
    <button onClick={() => useStore.getState().resolveLeave(false)}>留在当前页</button><button disabled={action.busy} onClick={() => { useStore.setState({ codeDraft: null }); useStore.getState().resolveLeave(true) }}>放弃修改</button><button className="wx-primary" disabled={action.busy} onClick={() => action.run(async () => { await useStore.getState().saveCode(); useStore.getState().resolveLeave(true) })}>保存并继续</button>
  </footer></Modal>
}
