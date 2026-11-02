import React from 'react'
import { formatTimingDuration } from '../../utils/format-timing-duration.js'

export default function ToolTimingBadge({ thinkMs, execMs, totalMs }) {
  const parts = []

  const thinkText = formatTimingDuration(thinkMs)
  if (thinkText) parts.push(`思考/等待 ${thinkText}`)

  const execText = formatTimingDuration(execMs)
  if (execText) parts.push(`执行 ${execText}`)

  const totalText = formatTimingDuration(totalMs)
  if (totalText) parts.push(`总计 ${totalText}`)

  if (!parts.length) return null

  const label = parts.join(' / ')

  return (
    <span className="tool-timing-badge" title={label}>
      {label}
    </span>
  )
}
