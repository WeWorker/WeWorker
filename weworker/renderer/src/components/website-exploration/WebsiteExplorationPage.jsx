import React, { useEffect, useState } from 'react'
import { message } from 'antd'
import * as api from '../../api/website-exploration-api.js'
import { useWebsiteExplorationStore as useStore } from '../../store/website-exploration.js'
import ExploreWorkspace from './ExploreWorkspace.jsx'
import { useSettingsStore } from '../../store/settings.js'
import { connectionMessage } from '../../utils/model-connection.js'
import { ActionMenu, ErrorMessage, Modal, useAction, useSnapshot } from './shared.jsx'
import './website-exploration.css'

export default function WebsiteExplorationPage({ onOpenSettings }) {
  const [messageApi, messageContextHolder] = message.useMessage()
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
  const status = useSnapshot(async () => {
    const [health, browser, activity] = await Promise.all([api.getHealth(), api.getBrowserStatus(), api.getActivity()])
    useStore.setState({ activity, connection: 'running' })
    return { health, browser, activity }
  }, [])
  const action = useAction(status.refresh)
  const pageError = status.error || action.error
  useEffect(() => {
    if (pageError) messageApi.error(pageError)
  }, [messageApi, pageError])
  const unavailable = Boolean(status.error || !status.data)
  const globalBusy = Boolean(status.data?.activity.running)
  const activeExploration = globalBusy && status.data?.activity.kind === 'exploration' && status.data.activity.id
  return <div className="website-exploration wx-page">
    {messageContextHolder}
    <header className="wx-topbar"><div><h1>Adapter工坊</h1><p className="wx-workshop-subtitle">从一次网站操作探索开始，一句话生成适配器，让每次网站操作皆可复用</p></div>
      <div className="wx-actions">
        <ActionMenu label={unavailable ? '服务未就绪' : status.data?.browser.running ? '浏览器已连接' : '浏览器未连接'}>
          <button onClick={onOpenSettings}>模型设置</button><button disabled={action.busy || unavailable} onClick={() => action.run(() => api.openBrowser(''))}>打开浏览器</button>
        </ActionMenu>
        {!unavailable && !status.data?.browser.running && <button data-app-button="action" onClick={() => action.run(() => api.openBrowser(''))} disabled={action.busy}>连接浏览器</button>}
      </div>
    </header>
    <ErrorMessage>{pageError}</ErrorMessage>
    {!modelConnection && <p role="status">正在检查模型连接…</p>}
    {modelConnection && !modelConnection.ok && <div className="wx-actions" role="status">
      <p>{connectionMessage(modelConnection)}</p>
      <button data-app-button="action" onClick={() => setModelRetry(value => value + 1)}>重试</button>
      <button data-app-button="action" onClick={onOpenSettings}>模型设置</button>
    </div>}
    <div className="wx-layout"><main className="wx-main"><div className="wx-workspace">
      <ExploreWorkspace disabled={unavailable} modelReady={modelReady} globalBusy={globalBusy} activeExplorationId={activeExploration || ''} activityReady={Boolean(status.data || status.error)} />
    </div></main></div>
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
    <button data-app-button="action" onClick={() => useStore.getState().resolveLeave(false)}>留在当前页</button><button data-app-button="action" data-variant="danger" disabled={action.busy} onClick={() => { useStore.setState({ codeDraft: null }); useStore.getState().resolveLeave(true) }}>放弃修改</button><button data-app-button="action" className="wx-primary" disabled={action.busy || emptyCode} title={emptyCode ? '请先填写代码' : undefined} onClick={() => action.run(async () => { await useStore.getState().saveCode(); useStore.getState().resolveLeave(true) })}>保存并继续</button>
  </footer></Modal>
}
