import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Popconfirm, Tag } from 'antd'
import { DeleteOutlined, LoadingOutlined, PlusOutlined } from '@ant-design/icons'
import ChatView from '../chat/ChatView.jsx'
import { useWorksStore } from '../../store/works.js'
import { useStatusStore } from '../../store/status.js'
import { createConversation, deleteConversation } from '../../api/dedicated-agents-api.js'
import { agentChannelOf, channelLabel, conversationPresentation, formatRelativeTime } from '../../utils/dedicated-agents.js'
import { showAlert } from '../../store/dialog.js'
import { hintStyle } from './styles.js'

function AgentChatIntro({ agent, siteName, fill }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 32, textAlign: 'center' }}>
      <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>{agent.name}</div>
      <div style={{ ...hintStyle, maxWidth: 480, marginBottom: 18 }}>
        {agent.description || `专门处理「${siteName}」上的工作。`}
        <br />
        在这里对话和在{channelLabel(agentChannelOf(agent))}里一样，但回复只显示在桌面端。
      </div>
      {agent.examples?.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', maxWidth: 560 }}>
          {agent.examples.map((example) => (
            <Button key={example} onClick={() => fill(example)} style={{ whiteSpace: 'normal', height: 'auto', padding: '6px 12px', textAlign: 'left' }}>
              {example}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

function ConversationItem({ conversation, agent, active, onSelect, onDelete }) {
  const [hovered, setHovered] = useState(false)
  const presentation = conversationPresentation(conversation, agent.name)
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ position: 'relative', borderRadius: 8, background: active ? 'var(--bg-active)' : hovered ? 'var(--bg-hover)' : 'transparent' }}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? 'true' : undefined}
        style={{ width: '100%', display: 'block', textAlign: 'left', padding: '8px 30px 8px 10px', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-primary)', fontFamily: 'inherit' }}
      >
        <span style={{ display: 'block', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{presentation.title}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
          <Tag bordered={false} color={presentation.source === 'wecom' ? 'green' : 'blue'} style={{ fontSize: 10, lineHeight: '16px', padding: '0 5px', marginInlineEnd: 0 }}>
            {presentation.source === 'wecom' ? channelLabel(agentChannelOf(agent), { short: true }) : '桌面'}
          </Tag>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{formatRelativeTime(conversation.updated_at)}</span>
        </span>
      </button>
      {(hovered || active) && (
        <Popconfirm title="删除这段对话？" okText="删除" okButtonProps={{ danger: true }} cancelText="取消" onConfirm={onDelete}>
          <Button
            type="text"
            size="small"
            icon={<DeleteOutlined />}
            aria-label="删除对话"
            style={{ position: 'absolute', right: 4, top: 8, color: 'var(--text-muted)' }}
          />
        </Popconfirm>
      )}
    </div>
  )
}

/**
 * Chat with a dedicated agent like the main page. Conversations started in
 * WeCom and on the desktop share the list; new WeCom messages appear live.
 */
export default function AgentChatPanel({ agent, siteName, conversations, onConversationsChanged }) {
  const [activeId, setActiveId] = useState(null)
  const [creating, setCreating] = useState(false)
  const lastExternalWrite = useStatusStore((s) => s._lastExternalWrite)
  const streaming = useWorksStore((s) => (activeId ? s.streamingWorkIds.has(activeId) : false))
  const refreshWorkMessages = useWorksStore((s) => s.refreshWorkMessages)
  const firstWriteRef = useRef(lastExternalWrite)

  // Default to the most recent conversation; keep the selection while it still exists.
  useEffect(() => {
    if (activeId && conversations.some((conversation) => conversation.id === activeId)) return
    setActiveId(conversations[0]?.id ?? null)
  }, [conversations, activeId])

  // Messages that arrive from WeCom are written by the backend: refresh live.
  useEffect(() => {
    if (lastExternalWrite === firstWriteRef.current) return
    firstWriteRef.current = lastExternalWrite
    onConversationsChanged?.()
    if (activeId && !streaming) refreshWorkMessages(activeId)
  }, [lastExternalWrite, activeId, streaming, refreshWorkMessages, onConversationsChanged])

  const startConversation = useCallback(async () => {
    setCreating(true)
    try {
      const result = await createConversation(agent.id)
      await onConversationsChanged?.()
      setActiveId(result.conversation.id)
    } catch (error) {
      void showAlert(error.message || '创建对话失败')
    } finally {
      setCreating(false)
    }
  }, [agent.id, onConversationsChanged])

  const removeConversation = async (workId) => {
    try {
      await deleteConversation(agent.id, workId)
      if (workId === activeId) setActiveId(null)
      await onConversationsChanged?.()
    } catch (error) {
      void showAlert(error.message || '删除失败')
    }
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', borderTop: '1px solid var(--border)' }}>
      <div style={{ width: 220, minWidth: 220, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: 10 }}>
          <Button block icon={creating ? <LoadingOutlined /> : <PlusOutlined />} onClick={startConversation} disabled={creating}>新对话</Button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 6px 10px' }} aria-label="对话列表">
          {conversations.length === 0
            ? <div style={{ ...hintStyle, padding: '8px 6px' }}>还没有对话。在{channelLabel(agentChannelOf(agent))}里给机器人发消息，或点「新对话」在这里直接聊。</div>
            : conversations.map((conversation) => (
              <ConversationItem
                key={conversation.id}
                conversation={conversation}
                agent={agent}
                active={conversation.id === activeId}
                onSelect={() => setActiveId(conversation.id)}
                onDelete={() => removeConversation(conversation.id)}
              />
            ))}
        </div>
        <div style={{ ...hintStyle, fontSize: 11, padding: '8px 10px', borderTop: '1px solid var(--border)' }}>
          {channelLabel(agentChannelOf(agent))}里发送 /new 开启新对话，/stop 停止当前任务。
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {activeId ? (
          <ChatView
            key={activeId}
            workId={activeId}
            embedded
            onTurnFinished={onConversationsChanged}
            renderEmpty={(fill) => <AgentChatIntro agent={agent} siteName={siteName} fill={fill} />}
          />
        ) : (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
            <div style={hintStyle}>选择左侧的对话，或开始一个新对话。</div>
            <Button data-app-button="action" type="primary" icon={<PlusOutlined />} onClick={startConversation} disabled={creating}>开始新对话</Button>
          </div>
        )}
      </div>
    </div>
  )
}
