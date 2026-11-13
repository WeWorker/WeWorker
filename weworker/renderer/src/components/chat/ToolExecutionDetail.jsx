import React from 'react'

// Keep chat tool output and exploration details on the same reading surface.
export default function ToolExecutionDetail({ children, id, hidden = false, className = '' }) {
  return <div id={id} hidden={hidden} className={`tool-exec-group__detail${className ? ` ${className}` : ''}`}>
    <div className="tool-exec-group__detail-scroll">{children}</div>
  </div>
}

export function ToolExecutionText({ children }) {
  return <pre className="tool-exec-group__detail-pre">{children}</pre>
}
