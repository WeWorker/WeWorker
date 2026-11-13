import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import MainWorkspaceShell from '../../components/layout/MainWorkspaceShell.jsx'
import MessageList from '../../components/chat/MessageList.jsx'
import '../../index.css'
import '../../workspace-refresh.css'

function Fixture() {
  const [workId, setWorkId] = useState('example-work')
  const [streaming, setStreaming] = useState(false)
  window.changeFixtureWork = setWorkId
  window.streamFixtureWork = setStreaming
  const messages = [
    { id: 'example-user', role: 'user', content: [{ type: 'text', text: '请将示例文件里的标题改成新版，并调整卡片间距。' }] },
    { id: 'example-assistant', role: 'assistant', content: [
      { type: 'tool_use', id: 'edit-title', name: 'Edit', args: { file_path: '/example/site/title.txt' }, status: 'done', result: 'Updated' },
      { type: 'tool_use', id: 'edit-style', name: 'Edit', args: { file_path: '/example/site/style.css' }, status: 'done', result: 'Updated' },
      { type: 'text', text: '已更新标题和卡片间距，可以查看本轮修改。' },
    ] },
  ]
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <div style={{ padding: 16, borderBottom: '1px solid var(--border)' }}>WeWorker · 文件修改记录</div>
    <MainWorkspaceShell><div style={{ display: 'flex', flexDirection: 'column', height: '100%', maxWidth: 900, margin: 'auto' }}>
      <MessageList workId={workId} messages={messages} streaming={streaming} />
    </div></MainWorkspaceShell>
  </div>
}
createRoot(document.getElementById('root')).render(<Fixture />)
