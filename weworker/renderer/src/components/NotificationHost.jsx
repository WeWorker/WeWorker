import React, { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircleOutlined, CloseOutlined, ExclamationCircleOutlined, InfoCircleOutlined } from '@ant-design/icons'
import { useNotificationsStore } from '../store/notifications.js'
import './notification-host.css'

function Notice({ notice, dismiss }) {
  useEffect(() => {
    if (notice.duration <= 0) return undefined
    const timer = window.setTimeout(() => dismiss(notice.id), notice.duration)
    return () => window.clearTimeout(timer)
  }, [notice.id, notice.duration, dismiss])

  const urgent = notice.type === 'error' || notice.type === 'warning'
  const Icon = notice.type === 'success' ? CheckCircleOutlined : urgent ? ExclamationCircleOutlined : InfoCircleOutlined
  return (
    <div className={`app-notice app-notice--${notice.type}`} role={urgent ? 'alert' : 'status'}>
      <Icon aria-hidden="true" />
      <span>{notice.message}</span>
      <button type="button" aria-label="关闭提示" title="关闭" onClick={() => dismiss(notice.id)}><CloseOutlined aria-hidden="true" /></button>
    </div>
  )
}

export default function NotificationHost() {
  const notices = useNotificationsStore((state) => state.notices)
  const dismiss = useNotificationsStore((state) => state.dismiss)
  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="app-notification-layer" aria-label="全局提示">
      {notices.map((notice) => <Notice key={notice.id} notice={notice} dismiss={dismiss} />)}
    </div>,
    document.body,
  )
}
