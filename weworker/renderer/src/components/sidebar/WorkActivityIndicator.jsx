import React from 'react'

const LABELS = { running: '正在进行', waiting: '等待你处理', completed: '已完成，未读', failed: '执行失败，未读' }

export default function WorkActivityIndicator({ status }) {
  if (!LABELS[status]) return null
  return <span className={`work-activity work-activity--${status}`} role="img" aria-label={LABELS[status]} title={LABELS[status]}>
    {status === 'running' ? <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /></svg> : <span />}
  </span>
}
