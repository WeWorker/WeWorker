import React from 'react'
import { formatTimingDuration } from '../../utils/format-timing-duration.js'

export default function ToolTimingBadge({ thinkMs, execMs }) {
  const parts = []

  const thinkText = formatTimingDuration(thinkMs)
  if (thinkText) parts.push(`非执行 ${thinkText}`)

  const execText = formatTimingDuration(execMs)
  if (execText) parts.push(`执行份额 ${execText}`)

  if (!parts.length) return null

  const label = parts.join(' / ')

  return (
    <span className="tool-timing-badge" title={label}>
      {label}
    </span>
  )
}
