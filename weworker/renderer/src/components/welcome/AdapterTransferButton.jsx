import React, { useEffect, useState } from 'react'
import './adapter-hub.css'

function formatBytes(bytes, speed = false) {
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)}MB`
  if (speed || bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${bytes}B`
}

export default function AdapterTransferButton({ job, entry, activeLabel = '下载中…', minimumWaitingProgress = 0 }) {
  const [waitingProgress, setWaitingProgress] = useState(4)
  const queued = job.status === 'queued'
  const phaseLabels = { verifying: '校验中…', extracting: '解包中…', writing: '写入中…', complete: '已完成' }
  const phaseLabel = phaseLabels[job.status]
  const received = job.receivedBytes ?? 0
  const total = job.totalBytes ?? entry.totalBytes
  const percent = received > 0 && total >= received ? Math.floor(received / total * 100) : null
  const waiting = !queued && !phaseLabel && waitingProgress < 50
    && (percent === null || percent < minimumWaitingProgress)

  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => setWaitingProgress(value => Math.min(50, value + 2)), 250)
    return () => clearInterval(timer)
  }, [waiting])

  const width = queued ? 0 : phaseLabel ? 100 : Math.max(waitingProgress, percent ?? 0)
  const label = phaseLabel || (queued ? '排队中' : job.status === 'preparing' ? '准备中…' : activeLabel)
  const stats = job.status !== 'downloading' || percent === null ? '' : `${percent}% (${formatBytes(received)}/${formatBytes(total)}) · ${formatBytes(job.bytesPerSecond ?? 0, true)}/s`
  const status = queued && job.queuePosition ? `排队第 ${job.queuePosition} 位` : stats || label
  return (
    <button type="button" disabled className="tool-package-card-action adapter-hub__transfer"
      aria-label={`${label} ${entry.name}`} title={status} style={{ '--transfer-progress': `${width}%` }}>
      <span className="adapter-hub__transfer-fill" aria-hidden="true" />
      <span className="adapter-hub__transfer-label">{label}</span>
    </button>
  )
}
