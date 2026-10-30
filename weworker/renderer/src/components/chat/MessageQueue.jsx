import React, { useState } from 'react'
import { DeleteOutlined, EditOutlined, SendOutlined, DownOutlined, UpOutlined } from '@ant-design/icons'
import './message-queue.css'

export default function MessageQueue({ state, controller, disabled = false }) {
  const [collapsed, setCollapsed] = useState(false)
  const draft = state.editingText || ''
  if (!state.items.length) return null
  const locked = disabled || state.transitioning
  return (
    <section className="message-queue" aria-label="待发送消息">
      <div className="message-queue__header">
        <button type="button" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed}>
          {collapsed ? <DownOutlined /> : <UpOutlined />}<span>{state.items.length} 条排队中</span>
        </button>
        {state.pausedReason && !state.transitioning
          ? <button data-app-button="action" type="button" disabled={locked} onClick={() => controller.resume()}>继续队列</button>
          : <span>当前回复结束后依次发送</span>}
      </div>
      {state.pausedReason && <div className="message-queue__notice" role="status">{state.pausedReason}</div>}
      {!collapsed && <ol className="message-queue__list">{state.items.map((item, index) => (
        <li key={item.id} className="message-queue__item">
          <span className="message-queue__index">{index + 1}</span>
          <div className="message-queue__body">
            {state.editingId === item.id ? (
              <div className="message-queue__editor">
                <textarea aria-label="编辑排队消息" value={draft} autoFocus disabled={locked} onChange={event => controller.updateEdit(event.target.value)}
                  onKeyDown={event => {
                    if (event.nativeEvent.isComposing) return
                    if (event.key === 'Escape') { event.preventDefault(); controller.cancelEdit() }
                    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); controller.saveEdit(item.id, draft) }
                  }} />
                <div className="message-queue__edit-actions">
                  <button data-app-button="action" type="button" disabled={locked} onClick={() => controller.cancelEdit()}>取消</button>
                  <button data-app-button="action" type="button" disabled={locked || (!draft.trim() && !item.files.length)} onClick={() => controller.saveEdit(item.id, draft)}>保存</button>
                </div>
              </div>
            ) : <div className="message-queue__preview" title={item.text}>{item.text || '附件消息'}</div>}
            {item.files.length > 0 && <div className="message-queue__files">{item.files.map((file, fileIndex) => <span key={fileIndex} title={file.name}>📎 {file.name}</span>)}</div>}
          </div>
          {state.editingId !== item.id && <div className="workspace-toolbar__actions message-queue__actions">
            <button className="workspace-toolbar__button" type="button" disabled={locked} title="立即发送：作为补充指令接入当前执行，不中断工具" aria-label={'立即发送第 ' + (index + 1) + ' 条消息'} onClick={() => { void controller.sendNow(item.id).catch(() => {}) }}>
              <SendOutlined />
            </button>
            <button className="workspace-toolbar__button" type="button" disabled={locked} title="编辑" aria-label={'编辑第 ' + (index + 1) + ' 条消息'} onClick={() => controller.beginEdit(item.id)}><EditOutlined /></button>
            <button className="workspace-toolbar__button" type="button" disabled={locked} title="删除" aria-label={'删除第 ' + (index + 1) + ' 条消息'} onClick={() => controller.remove(item.id)}><DeleteOutlined /></button>
          </div>}
        </li>
      ))}</ol>}
    </section>
  )
}
