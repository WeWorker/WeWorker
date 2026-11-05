import React, { useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'

export default function DraftProjectNotice({ projectName }) {
  const [toolbarTarget, setToolbarTarget] = useState(null)

  useLayoutEffect(() => {
    setToolbarTarget(document.getElementById('workspace-toolbar-context'))
  }, [])

  if (!toolbarTarget) return null

  return createPortal(
    <div className="draft-project-notice">
      <span className="draft-project-notice__title" title={`新对话 · ${projectName}`}>
        新对话 · {projectName}
      </span>
      <span className="draft-project-notice__hint" title="发送第一条消息后保存">发送第一条消息后保存</span>
    </div>,
    toolbarTarget,
  )
}
