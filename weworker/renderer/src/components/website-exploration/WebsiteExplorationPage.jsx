import React, { useEffect, useState } from 'react'
import { message } from 'antd'
import * as api from '../../api/website-exploration-api.js'
import { useWebsiteExplorationStore as useStore } from '../../store/website-exploration.js'
import ExploreWorkspace from './ExploreWorkspace.jsx'
import { ActionMenu, ErrorMessage, Modal, useAction, useSnapshot } from './shared.jsx'
import './website-exploration.css'

export default function WebsiteExplorationPage({ onOpenSettings, sidebarWidth, sidebarCollapsed, onSidebarResizeStart, toolbar }) {
  const [messageApi, messageContextHolder] = message.useMessage()
  const status = useSnapshot(async () => {
    const [health, activity] = await Promise.all([api.getHealth(), api.getActivity()])
    useStore.setState({ activity, connection: 'running' })
    return { health, activity }
  }, [])
  // Browser control can be slower than reading history; it must not block entry.
  const browser = useSnapshot(() => api.getBrowserStatus(), [])
  const action = useAction(() => Promise.all([status.refresh(), browser.refresh()]))
  const pageError = status.error || browser.error || action.error
  useEffect(() => {
    if (pageError) messageApi.error(pageError)
  }, [messageApi, pageError])
  const unavailable = Boolean(status.error || !status.data)
  const globalBusy = Boolean(status.data?.activity.running)
  const activeExploration = globalBusy && status.data?.activity.kind === 'exploration' && status.data.activity.id
  const serviceActions = <div className="wx-actions wx-service-actions">
        <ActionMenu label={unavailable ? '服务未就绪' : !browser.data ? '服务已就绪' : browser.data.running ? '浏览器已连接' : '浏览器未连接'}>
          <button onClick={onOpenSettings}>模型设置</button><button disabled={action.busy || unavailable} onClick={() => action.run(() => api.openBrowser(''))}>打开浏览器</button>
        </ActionMenu>
        {!unavailable && browser.data && !browser.data.running && <button data-app-button="action" onClick={() => action.run(() => api.openBrowser(''))} disabled={action.busy}>连接浏览器</button>}
      </div>
  const notices = <>
    <ErrorMessage>{pageError}</ErrorMessage>
  </>
  return <div className="website-exploration wx-page" aria-label="Adapter工坊" aria-busy={status.loading}>
    {messageContextHolder}
    <ExploreWorkspace disabled={unavailable || browser.loading || Boolean(browser.error)} globalBusy={globalBusy} activeExplorationId={activeExploration || ''} activityReady={Boolean(status.data || status.error)}
      sidebarWidth={sidebarWidth} sidebarCollapsed={sidebarCollapsed} onSidebarResizeStart={onSidebarResizeStart} toolbar={toolbar} serviceActions={serviceActions} notices={notices} />
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
