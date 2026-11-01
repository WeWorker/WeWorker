import { needsAdapterApplyReview, adapterApplyFeedback } from '../../utils/website-adapter-apply.js'
import React, { useState } from 'react'
import * as api from '../../api/website-exploration-api.js'
import { useToolPackagePageStore } from '../../store/tool-package-page.js'
import { ErrorMessage, Modal, useAction, useSnapshot } from './shared.jsx'

export default function ApplyAdapter({ toolkitId, revision, disabled, onInstalled }) {
  const review = useSnapshot(() => api.getInstallReview(toolkitId), [toolkitId, revision])
  const action = useAction(review.refresh)
  const [pending, setPending] = useState(null)
  const [message, setMessage] = useState('')
  const [downloading, setDownloading] = useState(false)
  const apply = async (selected, acceptChanges) => {
    const result = await api.applyAdapter(toolkitId, selected.reviewId, acceptChanges)
    setPending(null)
    setMessage(adapterApplyFeedback(result))
    await onInstalled?.()
    useToolPackagePageStore.setState(s => ({ openSessionId: s.openSessionId + 1 }))
  }
  const requestApply = () => action.run(async () => {
    const selected = await api.getInstallReview(toolkitId)
    if (needsAdapterApplyReview(selected)) setPending(selected)
    else await apply(selected, false)
  })
  const download = () => action.run(async () => {
    if (window.electronAPI?.downloadWebsiteAdapter) {
      setDownloading(true)
      try {
        const result = await window.electronAPI.downloadWebsiteAdapter(toolkitId)
        setMessage(result.saved ? 'Adapter 已导出' : '已取消导出')
      } finally { setDownloading(false) }
      return
    }
    const blob = await api.resourceBlob(api.exportToolkitUrl(toolkitId))
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a'); link.href = url; link.download = (review.data?.name || toolkitId) + '.zip'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  })
  return <section className="wx-dev-card">
    <div className="wx-actions">
      <button className="wx-primary" disabled={disabled || action.busy || !review.data} onClick={requestApply}>{review.data?.applied ? '重新同步已应用 Adapter' : '应用到 Adapter'}</button>
      <button disabled={disabled || action.busy || !review.data} onClick={download}>导出 Adapter</button>
      {downloading && <button onClick={() => window.electronAPI?.cancelWebsiteAdapterDownload?.()}>取消导出</button>}
    </div>
    <p>应用范围：整个 Adapter 的已保存代码。即时调试为可选操作。</p>
    {review.data && <p>{review.data.name} v{review.data.version} · 本次变更：{review.data.changedTools?.join('、') || '无待应用修改'}</p>}
    <ErrorMessage>{review.error || action.error}</ErrorMessage>
    {message && <p role="status">{message}</p>}
    {pending && <Modal title="确认应用 Adapter" onClose={() => setPending(null)}>
      <p>{pending.name} v{pending.version}</p>
      <p>将应用全部已保存变更：{pending.changedTools?.join('、') || '无代码变更'}</p>
      <p>新增权限：{pending.addedPermissions.join('、') || '无'}</p>
      {pending.sourceChange && <p>来源将从 {pending.currentSource} 切换为网站探索agent生成版本。</p>}
      {pending.downgrade && <p>版本将从 {pending.currentVersion} 降至 {pending.version}。</p>}
      {pending.overwritesNewerBase && <p>将覆盖草稿创建后安装的更新。</p>}
      <ErrorMessage>{action.error}</ErrorMessage>
      <footer><button onClick={() => setPending(null)}>取消</button><button className="wx-primary" disabled={disabled || action.busy} onClick={() => action.run(() => apply(pending, true))}>确认并应用</button></footer>
    </Modal>}
  </section>
}
