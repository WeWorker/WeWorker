import React from 'react'

// Shared presentation only: each surface supplies its own title and actions.
export default function WorkspaceToolbar({ context, children, label = '工作区工具栏' }) {
  return <div className="workspace-toolbar" aria-label={label}>
    <div id="workspace-toolbar-context" className="workspace-toolbar__context">{context}</div>
    <div className="workspace-toolbar__actions">{children}</div>
  </div>
}
