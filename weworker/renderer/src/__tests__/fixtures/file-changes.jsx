import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import MainWorkspaceShell from '../../components/layout/MainWorkspaceShell.jsx'
import MessageList from '../../components/chat/MessageList.jsx'
import FileChangesCard from '../../components/chat/FileChangesCard.jsx'
import { useFileChangesStore } from '../../store/file-changes.js'
import '../../index.css'
import '../../workspace-refresh.css'

function Fixture() {
  const [workId, setWorkId] = useState('example-work')
  const [streaming, setStreaming] = useState(false)
  const [scope, setScope] = useState('chat')
  window.changeFixtureWork = id => { useFileChangesStore.getState().closePanel(); setWorkId(id) }
  window.changeFixtureScope = scope => { useFileChangesStore.getState().closePanel(); setScope(scope) }
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
      {scope === 'chat' ? <MessageList workId={workId} messages={messages} streaming={streaming} /> : <FileChangesCard workId={workId} scope="exploration" streaming={streaming} />}
    </div></MainWorkspaceShell>
  </div>
}
createRoot(document.getElementById('root')).render(<Fixture />)
