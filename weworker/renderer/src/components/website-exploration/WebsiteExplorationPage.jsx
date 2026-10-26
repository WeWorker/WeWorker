import React, { useEffect, useState } from 'react'
import * as api from '../../api/website-exploration-api.js'
import { useWebsiteExplorationStore as useStore, changeWebsiteContext } from '../../store/website-exploration.js'
import { useToolPackagePageStore } from '../../store/tool-package-page.js'
import ExploreWorkspace from './ExploreWorkspace.jsx'
import { useSettingsStore } from '../../store/settings.js'
import { connectionMessage } from '../../utils/model-connection.js'
import DevelopWorkspace, { TestRunner } from './DevelopWorkspace.jsx'
import { ActionMenu, Icon, ErrorMessage, Modal, RequiredMark, Status, useAction, useDraft, useSnapshot } from './shared.jsx'
import './website-exploration.css'

export default function WebsiteExplorationPage({ onOpenSettings }) {
  const toolkitId = useStore(s => s.toolkitId)
  const toolId = useStore(s => s.toolId)
  const workspace = useStore(s => s.workspace)
  const [search, setSearch] = useDraft('adapter-search')
  const [treeVisible, setTreeVisible] = useState(true)
  const [modal, setModal] = useState(null)
  const [deleteNotice, setDeleteNotice] = useState('')
  const [expanded, setExpanded] = useState({})
  const [modelReady, setModelReady] = useState(false)
  const [modelConnection, setModelConnection] = useState(null)
  const [modelRetry, setModelRetry] = useState(0)
  const providers = useSettingsStore(s => s.providers)
  const activeProvider = useSettingsStore(s => s.activeProvider)
  const model = useSettingsStore(s => s.model)
  const modelRevision = useSettingsStore(s => s.explorationModelRevision)
  useEffect(() => {
    let current = true
    setModelReady(false)
    setModelConnection(null)
    api.checkExplorationModel(modelRetry > 0).then(result => {
      if (!current) return
      setModelReady(Boolean(result.ok))
      setModelConnection(result)
    }).catch(error => {
      if (current) setModelConnection({ ok: false, detail: error.message })
    })
    return () => { current = false }
  }, [providers, activeProvider, model, modelRevision, modelRetry])
  const catalog = useSnapshot(async () => {
    const [kits, installed] = await Promise.all([api.listToolkits(), api.listInstalledAdapters()])
    const draftRows = await Promise.all(kits.map(async kit => {
      const tools = await api.listTools(kit.toolkit_id)
      const status = tools.some(tool => tool.has_formal) ? await api.getExportStatus(kit.toolkit_id).catch(() => null) : null
      return { ...kit, tools, publishedDigest: status?.distribution_hash }
    }))
    const byName = new Map(draftRows.map(kit => [kit.adapter_name || kit.name.replaceAll('_', '-'), kit]))
    for (const adapter of installed) {
      const existing = byName.get(adapter.name)
      if (existing) Object.assign(existing, { installedVersion: adapter.version, installedDigest: adapter.digest, installedSource: adapter.source, installedCommands: adapter.commands, canDeleteGeneratedCommands: adapter.canDeleteGeneratedCommands, applied: existing.publishedDigest === adapter.digest })
      else byName.set(adapter.name, { toolkit_id: 'installed:' + adapter.name, name: adapter.name, description: adapter.description, tools: [], installedOnly: true, installedVersion: adapter.version, installedDigest: adapter.digest, installedSource: adapter.source, installedCommands: adapter.commands, canDeleteGeneratedCommands: adapter.canDeleteGeneratedCommands })
    }
    return [...byName.values()]
  }, [])
  const status = useSnapshot(async () => {
    const [health, browser, activity] = await Promise.all([api.getHealth(), api.getBrowserStatus(), api.getActivity()])
    useStore.setState({ activity, connection: 'running' })
    return { health, browser, activity }
  }, [])
  const action = useAction(async () => { await catalog.refresh(); await status.refresh() })
  const kit = catalog.data?.find(item => item.toolkit_id === toolkitId)
  const tool = kit?.tools.find(item => item.tool_id === toolId)
  const installedCommand = kit?.installedCommands?.find(item => 'installed:' + item.id === toolId)
  const unavailable = Boolean(status.error || !status.data)
  const globalBusy = Boolean(status.data?.activity.running)
  useEffect(() => {
    if (toolkitId) setExpanded(current => toolkitId in current ? current : { ...current, [toolkitId]: true })
  }, [toolkitId])
  useEffect(() => {
    if (!catalog.data) return
    const nextKit = catalog.data.find(item => item.toolkit_id === toolkitId) || catalog.data[0]
    const nextTool = nextKit?.tools.find(item => item.tool_id === toolId)
    const installedId = nextKit?.installedCommands?.find(item => 'installed:' + item.id === toolId)?.id
    const selectedToolId = nextTool?.tool_id || (installedId && 'installed:' + installedId) || nextKit?.tools[0]?.tool_id || (nextKit?.installedCommands?.[0] ? 'installed:' + nextKit.installedCommands[0].id : '')
    if (nextKit?.toolkit_id !== toolkitId || selectedToolId !== toolId) {
      useStore.setState({ toolkitId: nextKit?.toolkit_id || '', toolId: selectedToolId || '' })
    }
  }, [catalog.data, toolkitId, toolId])
  const query = search.trim().toLowerCase()
  const matches = item => (item.name + ' ' + item.toolkit_id).toLowerCase().includes(query)
  const extend = name => action.run(async () => {
    if (!await useStore.getState().guard()) return
    const result = await api.extendAdapter(name)
    await catalog.refresh()
    await changeWebsiteContext({ toolkitId: result.toolkit_id, toolId: '', workspace: 'explore' })
  })
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
    <ErrorMessage>{status.error || catalog.error || action.error || deleteNotice}</ErrorMessage>
    {!modelConnection && <p role="status">正在检查模型连接…</p>}
    {modelConnection && !modelConnection.ok && <div className="wx-actions" role="status">
      <p>{connectionMessage(modelConnection)}</p>
      <button onClick={() => setModelRetry(value => value + 1)}>重试</button>
      <button onClick={onOpenSettings}>模型设置</button>
    </div>}
    {unavailable && <div className="wx-actions"><p>正在等待客户端托管的网站探索服务。连接恢复后会自动同步。</p><button onClick={() => action.run(async () => {})}>重新检查</button></div>}
    <div className="wx-layout">
      {treeVisible && <aside className="wx-tree" aria-label="Adapter 目录">
        <header><h2>Adapters</h2><button className="wx-icon-button" aria-label="新建 Adapter" title="新建 Adapter" disabled={unavailable || globalBusy} onClick={() => setModal({ kind: 'kit', create: true })}><Icon name="plus" /></button></header>
        <input aria-label="搜索 Adapter 或 Tool" placeholder="搜索 Adapter 或 Tool" value={search} onChange={e => setSearch(e.target.value)} />
        {catalog.data?.filter(item => matches(item) || [...item.tools, ...(item.installedCommands || [])].some(t => (t.name + ' ' + (t.tool_id || t.id)).toLowerCase().includes(query))).map(item => {
          const isOpen = Boolean(query) || (expanded[item.toolkit_id] ?? item.toolkit_id === toolkitId)
          const selectedKit = item.toolkit_id === toolkitId
          return <section key={item.toolkit_id}>
            <div className={'wx-tree-row ' + (selectedKit ? 'is-parent' : '')}>
              <button className={'wx-icon-button wx-disclosure ' + (isOpen ? 'is-open' : '')} aria-label={'展开 ' + item.name} aria-expanded={isOpen} onClick={() => setExpanded({ ...expanded, [item.toolkit_id]: !isOpen })}><Icon name="chevron" /></button>
              <button className="wx-tree-kit" title={item.name} onClick={() => changeWebsiteContext({ toolkitId: item.toolkit_id, toolId: item.tools[0]?.tool_id || (item.installedCommands?.[0] ? 'installed:' + item.installedCommands[0].id : '') })}>{item.name}</button>
              <small>{item.installedVersion ? item.installedVersion : '草稿'}</small>
              <ActionMenu compact label={item.name + ' 操作'}>
                <button disabled={unavailable || globalBusy} onClick={item.installedOnly ? () => extend(item.name) : () => setModal({ kind: 'tool', create: true, toolkitId: item.toolkit_id })}>{item.installedOnly ? '新增 Toolkit 命令' : '新建 Tool'}</button>
                {!item.installedOnly && <button disabled={unavailable || globalBusy} onClick={() => setModal({ kind: 'kit', value: item, toolkitId: item.toolkit_id })}>管理 Adapter</button>}
              </ActionMenu>
            </div>
            {isOpen && item.tools.filter(t => !query || matches(item) || (t.name + ' ' + t.tool_id).toLowerCase().includes(query)).map(t => <div key={t.tool_id} className={'wx-tree-row wx-tool-row ' + (selectedKit && t.tool_id === toolId ? 'is-selected' : '')}>
              <Icon name="tool" /><button className="wx-tree-tool" aria-current={selectedKit && t.tool_id === toolId ? 'page' : undefined} title={t.name} onClick={() => changeWebsiteContext({ toolkitId: item.toolkit_id, toolId: t.tool_id })}>{t.name} · {t.has_development ? '开发中' : t.has_formal ? item.applied ? '已应用' : '待应用' : '未开始'}</button>
              <ActionMenu compact label={t.name + ' 操作'}><button disabled={unavailable || globalBusy} onClick={() => setModal({ kind: 'tool', value: t, toolkitId: item.toolkit_id, installedDigest: item.installedDigest || null, removesInstalled: item.installedCommands?.some(command => command.id === t.tool_id.replaceAll('_', '-')), uninstallsAdapter: item.installedCommands?.length === 1 })}>管理 Tool</button></ActionMenu>
            </div>)}
            {isOpen && (item.installedCommands || []).filter(t => !item.tools.some(draft => draft.tool_id.replaceAll('_', '-') === t.id) && (!query || matches(item) || (t.id + ' ' + t.description).toLowerCase().includes(query))).map(t => <div key={'installed:' + t.id} className={'wx-tree-row wx-tool-row ' + (selectedKit && toolId === 'installed:' + t.id ? 'is-selected' : '')}>
              <Icon name="tool" /><button className="wx-tree-tool" aria-current={selectedKit && toolId === 'installed:' + t.id ? 'page' : undefined} onClick={() => changeWebsiteContext({ toolkitId: item.toolkit_id, toolId: 'installed:' + t.id })}>{t.id} · {t.runtime === 'wewright' ? 'Toolkit' : t.runtime === 'extension' ? 'Extension' : 'HTTP'}</button>
              {t.runtime === 'wewright' && item.canDeleteGeneratedCommands && <ActionMenu compact label={t.id + ' 操作'}><button disabled={unavailable || globalBusy} onClick={() => setModal({ kind: 'installed-command', value: t, adapterName: item.name, installedDigest: item.installedDigest, uninstallsAdapter: item.installedCommands.length === 1 })}>删除命令</button></ActionMenu>}
            </div>)}
          </section>
        })}
        {query && catalog.data && !catalog.data.some(item => matches(item) || [...item.tools, ...(item.installedCommands || [])].some(t => (t.name + ' ' + (t.tool_id || t.id)).toLowerCase().includes(query))) && <p className="wx-muted">没有匹配的 Adapter 或 Tool</p>}
        {!catalog.loading && !catalog.data?.length && <p>还没有 Adapter，点击上方新增入口创建。</p>}
      </aside>}
      <main className="wx-main">
        {kit ? <><header className="wx-context"><div><div className="wx-breadcrumb"><span>{kit.name}</span>{(tool || installedCommand) && <><span aria-hidden="true">/</span><strong>{tool?.name || installedCommand?.id}</strong></>}</div><p>{kit.description}{kit.installedVersion && ` · 已安装 ${kit.installedVersion}（${kit.installedSource}）`}</p></div></header>
          {kit.installedOnly || installedCommand ? <div className="wx-workspace"><h2>{installedCommand?.id || kit.name}</h2><p>{installedCommand?.description || '选择此 Adapter，新增 Toolkit 命令。'}</p>{installedCommand && <p>运行方式：{installedCommand.runtime === 'wewright' ? 'Toolkit' : installedCommand.runtime === 'extension' ? 'Extension' : 'HTTP'}</p>}{installedCommand?.schema && <pre>{JSON.stringify(installedCommand.schema, null, 2)}</pre>}{kit.installedOnly && <button className="wx-primary" disabled={unavailable || globalBusy || action.busy} onClick={() => extend(kit.name)}>新增 Toolkit 命令</button>}</div> : <><nav className="wx-tabs" aria-label="网站探索工作区">{[['explore', '探索'], ['develop', '开发'], ['verify', 'Adapter 验证']].map(([id, label]) => <button key={id} aria-current={workspace === id ? 'page' : undefined} className={workspace === id ? 'is-active' : ''} onClick={() => changeWebsiteContext({ workspace: id })}>{label}</button>)}</nav>
          <div className="wx-workspace">{workspace === 'verify' ? <VerifyWorkspace key={kit.toolkit_id} kit={kit} tool={tool} disabled={unavailable} globalBusy={globalBusy} onInstalled={catalog.refresh} /> : tool ? workspace === 'develop' ? <DevelopWorkspace key={toolkitId + '/' + toolId} toolkitId={toolkitId} tool={tool} disabled={unavailable} modelReady={modelReady} globalBusy={globalBusy} /> : <ExploreWorkspace key={toolkitId + '/' + toolId} toolkitId={toolkitId} tool={tool} disabled={unavailable} modelReady={modelReady} globalBusy={globalBusy} /> : <div className="wx-empty">创建一个 Tool，说明目标、起始网址和预期效果。</div>}</div></>}
        </> : <div className="wx-empty">{catalog.loading ? '正在加载 Adapter…' : '创建或选择 Adapter，开始探索网站能力。'}</div>}
      </main>
    </div>
    {modal && (modal.kind === 'installed-command' ? <DeleteInstalledCommandModal config={modal} onClose={() => setModal(null)} onSaved={async result => { setModal(null); setDeleteNotice(result?.cleanupPending ? '命令已移除，但暂存数据清理待完成。' : result?.refreshed === false ? '命令已移除，但能力同步待完成。' : ''); await catalog.refresh() }} /> : <ManageModal config={modal} toolkitId={modal.toolkitId || toolkitId} onClose={() => setModal(null)} onSaved={async result => { setModal(null); setDeleteNotice(result?.cleanupPending ? 'Tool 已移除，但暂存数据清理待完成。' : result?.refreshed === false ? 'Tool 已移除，但能力同步待完成。' : ''); await catalog.refresh() }} />)}
  </div>
}

function ManageModal({ config, toolkitId, onClose, onSaved }) {
  const isKit = config.kind === 'kit'
  const [values, setValues] = useState({ ...config.value, allowed_domains: config.value?.allowed_domains?.join('\n') || '' })
  const [deleting, setDeleting] = useState(false)
  const [touched, setTouched] = useState({})
  const action = useAction()
  const fields = isKit ? [['name', 'Adapter 名称'], ['description', '描述'], ['allowed_domains', '允许域名，一行一个']] : [['name', 'Tool 名称'], ['goal', '功能目标'], ['start_url', '起始网址'], ['expected_effect', '运行后预期效果']]
  const requiredFields = isKit ? ['name', 'allowed_domains'] : ['name', 'goal', 'start_url']
  const missing = name => name === 'allowed_domains' ? !String(values[name] || '').split(/[,，\s]+/).filter(Boolean).length : !String(values[name] || '').trim()
  const incomplete = requiredFields.some(missing)
  return <Modal title={(config.create ? '新建' : '管理') + (isKit ? ' Adapter' : ' Tool')} onClose={onClose}>
    <form onSubmit={e => { e.preventDefault(); if (incomplete) return; void action.run(async () => {
      const body = { ...values }
      if (isKit) body.allowed_domains = String(values.allowed_domains || '').split(/[,，\s]+/).filter(Boolean)
      if (config.create) {
        if (isKit) { const result = await api.createToolkit({ ...values }); await changeWebsiteContext({ toolkitId: result.toolkit_id, toolId: '' }) }
        else { const result = await api.createTool(toolkitId, body); await changeWebsiteContext({ toolkitId, toolId: result.tool_id }) }
      } else if (isKit) await api.updateToolkit(toolkitId, body)
      else await api.updateTool(toolkitId, config.value.tool_id, body)
      await onSaved()
    }) }}>
      {fields.map(([name, label]) => {
        const required = requiredFields.includes(name)
        const invalid = Boolean(required && touched[name] && missing(name))
        const props = { 'aria-label': label, required, 'aria-invalid': invalid, disabled: name === 'name' && !config.create, value: values[name] || '', onBlur: () => setTouched(current => ({ ...current, [name]: true })), onChange: e => setValues({ ...values, [name]: e.target.value }) }
        return <label key={name}><span>{label}{required && <RequiredMark />}</span>{name === 'allowed_domains' ? <textarea {...props} rows={4} /> : <input {...props} />}{invalid && <small className="wx-required">请填写{label.split('，')[0]}</small>}</label>
      })}
      <ErrorMessage>{action.error}</ErrorMessage><footer>{!config.create && <button type="button" className="wx-danger" onClick={() => setDeleting(true)}>删除</button>}<button type="button" onClick={onClose}>取消</button><button className="wx-primary" disabled={action.busy || incomplete} title={incomplete ? '请填写所有必填项' : undefined}>保存</button></footer>
    </form>
    {deleting && <section className="wx-delete"><p>{isKit ? '确认删除此 Adapter？' : `确认删除 Tool「${config.value.name}」${config.removesInstalled ? `，并${config.uninstallsAdapter ? '卸载整个已安装 Adapter' : '从已安装 Adapter 中移除同名命令'}` : ''}？关联探索历史将不再从此 Tool 展示。`}删除后无法恢复。</p><button onClick={() => setDeleting(false)}>取消删除</button><button className="wx-danger" disabled={action.busy} onClick={() => action.run(async () => {
      if (!await useStore.getState().guard()) return
      if (isKit) await api.deleteToolkit(toolkitId)
      else {
        const result = await api.deleteTool(toolkitId, config.value.tool_id, config.installedDigest)
        await onSaved(result)
        return
      }
      await onSaved()
    })}>确认删除</button></section>}
  </Modal>
}

function DeleteInstalledCommandModal({ config, onClose, onSaved }) {
  const action = useAction()
  return <Modal title="删除已安装命令" onClose={onClose}>
    <p>确认删除命令「{config.value.id}」？{config.uninstallsAdapter ? '这是唯一命令，将卸载整个 Adapter。' : '它将从已安装 Adapter 中移除。'}删除后无法恢复。</p>
    <ErrorMessage>{action.error}</ErrorMessage>
    <footer><button onClick={onClose}>取消</button><button className="wx-danger" disabled={action.busy} onClick={() => action.run(async () => {
      if (!await useStore.getState().guard()) return
      const result = await api.deleteInstalledCommand(config.adapterName, config.value.id, config.installedDigest)
      await onSaved(result)
    })}>确认删除</button></footer>
  </Modal>
}

function VerifyWorkspace({ kit, tool, disabled, globalBusy, onInstalled }) {
  const snapshot = useSnapshot(() => api.getExportStatus(kit.toolkit_id), [kit.toolkit_id])
  const [selectedId, setSelectedId] = useState(null)
  useEffect(() => setSelectedId(null), [kit.toolkit_id, tool?.tool_id])
  const formal = snapshot.data?.tools?.find(item => item.tool_id === (selectedId || tool?.tool_id)) || snapshot.data?.tools?.[0]
  const [message, setMessage] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [installedSkill, setInstalledSkill] = useState('')
  const action = useAction(snapshot.refresh)
  const eligible = snapshot.data?.export_eligible
  const reviewSnapshot = useSnapshot(() => eligible ? api.getInstallReview(kit.toolkit_id) : Promise.resolve(null), [kit.toolkit_id, snapshot.data?.distribution_hash, eligible])
  const [pendingReview, setPendingReview] = useState(null)
  const apply = async (review, acceptChanges) => {
    const result = await api.applyAdapter(kit.toolkit_id, review.reviewId, acceptChanges)
    setPendingReview(null)
    setInstalledSkill('webcli-' + result.name)
    setMessage(result.refreshed ? 'Adapter 已应用' : 'Adapter 已安装，能力同步待完成')
    await snapshot.refresh()
    await reviewSnapshot.refresh()
    await onInstalled?.()
    useToolPackagePageStore.setState(s => ({ openSessionId: s.openSessionId + 1 }))
  }
  const ownedFormal = kit.tools.some(item => item.tool_id === formal?.tool_id)
  return <div className="wx-verify"><header><div><h2>正式产物验证</h2><p>全部 Toolkit 命令通过当前包验证后，即可导出或应用。</p></div><div className="wx-actions">
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
    <button className={eligible ? "wx-primary" : "wx-quiet"} disabled={!eligible || disabled || globalBusy || action.busy || reviewSnapshot.data?.applied} onClick={() => action.run(async () => {
      const review = await api.getInstallReview(kit.toolkit_id)
      if (review.applied) { setMessage('当前版本已应用'); return }
      if (review.addedPermissions.length || review.sourceChange || review.downgrade) setPendingReview(review)
      else await apply(review, false)
    })}>{reviewSnapshot.data?.applied ? '已应用' : '应用到 WeWorker'}</button>
  </div></header>
    {reviewSnapshot.data && <p>目标：{reviewSnapshot.data.name} v{reviewSnapshot.data.version} · 权限：{reviewSnapshot.data.permissions?.join('、') || '无'}{reviewSnapshot.data.overwritesNewerBase && ' · 将覆盖草稿创建后安装的更新'}</p>}
    {pendingReview && <Modal title="确认安装变化" onClose={() => setPendingReview(null)}><p>Adapter：{pendingReview.name} v{pendingReview.version}</p><p>新增权限：{pendingReview.addedPermissions.join('、') || '无'}</p>{pendingReview.sourceChange && <p>来源将从 {pendingReview.currentSource} 切换为网站探索agent生成版本。</p>}{pendingReview.downgrade && <p>版本将从 {pendingReview.currentVersion} 降至 {pendingReview.version}。</p>}{pendingReview.overwritesNewerBase && <p>将覆盖草稿创建后安装的更新。</p>}<ErrorMessage>{action.error}</ErrorMessage><footer><button onClick={() => setPendingReview(null)}>取消</button><button className="wx-primary" disabled={action.busy} onClick={() => action.run(() => apply(pendingReview, true))}>确认并应用</button></footer></Modal>}
    <ErrorMessage>{snapshot.error || snapshot.data?.error || action.error}</ErrorMessage>{message && <p role="status">{message} {installedSkill && <button onClick={async () => { if (await useStore.getState().guard()) { useStore.setState({ open: false }); useToolPackagePageStore.getState().openPage('', { publicSkillName: installedSkill }) } }}>查看已安装能力</button>}</p>}
    {!eligible && <p>待验证：{snapshot.data?.unverified_tools?.join('、') || '请先将开发中版本应用到 Adapter'}</p>}
    <table><thead><tr><th>Tool</th><th>当前产物</th></tr></thead><tbody>{snapshot.data?.tools?.map(item => <tr key={item.tool_id}><td><button className="wx-quiet" aria-current={formal?.tool_id === item.tool_id ? 'true' : undefined} onClick={() => setSelectedId(item.tool_id)}>{item.tool_id}</button></td><td>{item.verified ? '已验证' : '待验证'}</td></tr>)}</tbody></table>
    {formal && <section><h3>{formal.name}</h3><TestRunner key={formal.tool_id + formal.distribution_hash} toolkitId={kit.toolkit_id} tool={formal} slot={formal} channel="formal" primary={!eligible} disabled={disabled || globalBusy} onRefresh={snapshot.refresh} onEvidence={ownedFormal ? run => action.run(async () => {
      const slots = await api.getSlots(kit.toolkit_id, formal.tool_id)
      if (!slots.development) await api.startDevelopmentFromFormal(kit.toolkit_id, formal.tool_id)
      useStore.getState().setDraft(kit.toolkit_id + '/' + formal.tool_id + '/evidence', run)
      await changeWebsiteContext({ toolId: formal.tool_id, workspace: 'develop' })
    }) : undefined} /></section>}
  </div>
}

export function WebsiteExplorationGuard() {
  const leave = useStore(s => s.leaveRequest)
  const emptyCode = useStore(s => !s.codeDraft?.code.trim())
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
    <button onClick={() => useStore.getState().resolveLeave(false)}>留在当前页</button><button disabled={action.busy} onClick={() => { useStore.setState({ codeDraft: null }); useStore.getState().resolveLeave(true) }}>放弃修改</button><button className="wx-primary" disabled={action.busy || emptyCode} title={emptyCode ? '请先填写代码' : undefined} onClick={() => action.run(async () => { await useStore.getState().saveCode(); useStore.getState().resolveLeave(true) })}>保存并继续</button>
  </footer></Modal>
}
