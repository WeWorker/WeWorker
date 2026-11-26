import WorkingIndicator from './WorkingIndicator.jsx'
import React, { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import ToolCallBlock from './ToolCallBlock.jsx'
import ToolExecutionGroup from './ToolExecutionGroup.jsx'
import ImageLightbox from './ImageLightbox.jsx'
import { formatTimingDuration, formatTimingTotal } from '../../utils/format-timing-duration.js'
import ComplexTaskPlanPanel from './ComplexTaskPlanPanel.jsx'
import { partitionContentBlocks } from '../../utils/group-tool-blocks.js'
import { isPlanManagementTool } from '../../utils/todowrite-state.js'
import { normalizeUserChoiceBlock } from '../../utils/user-choice.js'
import { localFileUrl } from '../../utils/local-file-url.js'
import { handleChatLinkClick } from '../../utils/chat-links.js'
import { isTabTableBlock, preChildText, remarkCodeFilenames } from '../../utils/code-block.js'
import ChatCodeBlock from './ChatCodeBlock.jsx'
import { captureMessageSelection, messageCopyContent } from '../../utils/message-copy.js'
import FileGlyph, { getFileTypeLabel, getFileTypeMeta } from '../files/FileTypeIcon.jsx'

const BUBBLE_USER = {
  maxWidth: '80%',
  background: 'var(--chat-user-bubble-bg)',
  borderRadius: '16px 16px 4px 16px',
  padding: '10px 14px',
  border: 'none',
}

const BUBBLE_ASSISTANT = {
  maxWidth: '100%',
  width: '100%',
  background: 'transparent',
  borderRadius: 0,
  padding: 0,
  border: 'none',
  boxShadow: 'none',
}

export default function MessageItem({ message, workId, streaming, compacting = false, isLast, selectMode, isSelected, onToggleSelect, onEnterSelectMode, onDelete, onChoice, onShellCommand, plan, planSnapshot, planSentinelRef, hideEmbeddedPlan, hideLivePlan = false, planExpanded, onPlanExpandedChange, planStepDetails, onPlanStepDetailsChange, suppressPlanTools, compactAssistant = false }) {
  const isUser = message.role === 'user'
  const showStreaming = streaming && !compacting
  const isEmpty = !message.content?.length
  const hasVisibleUserContent = isUser && !isEmpty
  const hasVisibleAssistantContent = !isUser && (
    !!plan
    || !!planSnapshot
    || (message.content ?? []).some((block) => {
      if (block.type === 'text') {
        const raw = block.text || ''
        return !!raw.trim()
      }
      return block.type !== 'text'
    })
  )
  const showBubble = isUser
    ? (hasVisibleUserContent || (isEmpty && showStreaming && isLast))
    : (hasVisibleAssistantContent || (isEmpty && showStreaming && isLast))

  const [showMenu, setShowMenu] = useState(false)
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 })
  const [showTime, setShowTime] = useState(false)
  const hoverTimerRef = useRef(null)
  const lastDblClickRef = useRef(0)
  const messageRef = useRef(null)
  const selectedContentRef = useRef(null)
  /** 打开右键菜单时的选区 Range 快照：复制后恢复蓝色高亮，方便继续复制下一行。 */
  const savedSelectionRangesRef = useRef([])

  const handleContextMenu = (e) => {
    if (selectMode || streaming) return
    const selection = window.getSelection()?.toString()?.trim() ?? ''
    if (Date.now() - lastDblClickRef.current < 400 && !selection) return
    const native = e.nativeEvent
    if (native instanceof MouseEvent && native.button !== 2) return
    e.preventDefault()
    const liveSelection = window.getSelection()
    selectedContentRef.current = captureMessageSelection(e.currentTarget, liveSelection)
    const ranges = []
    if (liveSelection?.rangeCount) {
      for (let index = 0; index < liveSelection.rangeCount; index += 1) {
        ranges.push(liveSelection.getRangeAt(index).cloneRange())
      }
    }
    savedSelectionRangesRef.current = ranges
    setMenuPos({ x: e.clientX, y: e.clientY })
    setShowMenu(true)
  }

  const handleDoubleClick = (e) => {
    if (!e.target?.closest?.('.message-text-selectable')) return
    lastDblClickRef.current = Date.now()
    setShowMenu(false)
  }

  useEffect(() => {
    if (!showMenu) return
    const close = (ev) => {
      if (ev.target?.closest?.('[data-message-context-menu]')) return
      setShowMenu(false)
    }
    const listenFrame = requestAnimationFrame(() => {
      window.addEventListener('mousedown', close, true)
    })
    return () => {
      cancelAnimationFrame(listenFrame)
      window.removeEventListener('mousedown', close, true)
    }
  }, [showMenu])

  const handleCopy = (format) => {
    const content = messageCopyContent(message, messageRef.current, selectedContentRef.current)
    selectedContentRef.current = null
    setShowMenu(false)
    navigator.clipboard.writeText(content[format])
    // 复制后恢复选中高亮：点击菜单按钮及菜单卸载会让浏览器清掉选区。
    const selection = window.getSelection()
    const saved = savedSelectionRangesRef.current
    if (selection && saved.length) {
      selection.removeAllRanges()
      for (const range of saved) {
        try { selection.addRange(range) } catch { /* 节点已卸载等异常时放弃恢复 */ }
      }
    }
  }

  const handleMultiSelect = () => {
    setShowMenu(false)
    onEnterSelectMode?.()
  }

  const handleDelete = () => {
    setShowMenu(false)
    onDelete?.()
  }

  const preciseTime = message.created_at
    ? new Date(message.created_at).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : ''

  const rowClassName = [
    'message-item',
    isUser ? 'message-item--user' : 'message-item--assistant',
    !isUser && compactAssistant ? 'message-item--assistant-compact' : '',
    isSelected ? 'is-selected' : '',
  ].filter(Boolean).join(' ')

  return (
    <div
      ref={messageRef}
      className={rowClassName}
      onContextMenu={handleContextMenu}
      onDoubleClick={handleDoubleClick}
      onClick={selectMode ? onToggleSelect : undefined}
      onMouseEnter={() => {
        hoverTimerRef.current = setTimeout(() => setShowTime(true), 3000)
      }}
      onMouseLeave={() => {
        clearTimeout(hoverTimerRef.current)
        setShowTime(false)
      }}
      style={{
        padding: !isUser && compactAssistant ? '0 24px 8px' : '8px 24px',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        cursor: selectMode ? 'pointer' : 'default',
        transition: 'background 0.1s',
        position: 'relative',
      }}
    >
      {showTime && !selectMode && preciseTime && (
        <div style={{
          position: 'absolute',
          top: 0,
          ...(isUser ? { right: 24 } : { left: 24 }),
          transform: 'translateY(-50%)',
          background: 'transparent',
          color: 'var(--text-muted)',
          fontSize: 10,
          padding: '2px 8px',
          borderRadius: 4,
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
          zIndex: 10,
          opacity: showTime ? 1 : 0,
          transition: 'opacity 0.2s ease',
        }}>
          {preciseTime}
        </div>
      )}
      {selectMode && (
        <div style={{
          width: 18, height: 18, borderRadius: 4, flexShrink: 0, marginTop: 20,
          border: isSelected ? '2px solid var(--accent)' : '2px solid var(--border)',
          background: isSelected ? 'var(--accent)' : 'transparent',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'all 0.1s',
        }}>
          {isSelected && (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
        </div>
      )}

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: isUser ? 'flex-end' : 'flex-start', gap: 4, minWidth: 0 }}>
        {showBubble && (
          <div className={isUser ? 'message-bubble message-bubble--user' : 'message-bubble message-bubble--assistant'} style={isUser ? BUBBLE_USER : BUBBLE_ASSISTANT}>
            {isEmpty && showStreaming && isLast ? (
              <WorkingIndicator />
            ) : (
              renderMessageContent(message.content ?? [], {
                isUser,
                onChoice,
                onShellCommand,
                livePlan: !isUser && plan ? plan : null,
                planSnapshot: !isUser ? planSnapshot : null,
                hideLivePlan: !isUser && hideLivePlan,
                streaming: !isUser && showStreaming,
                suppressPlanTools: !isUser && suppressPlanTools,
                planSentinelRef: !isUser ? planSentinelRef : null,
                hideEmbeddedPlan: !isUser && hideEmbeddedPlan,
                planExpanded: !isUser ? planExpanded : undefined,
                onPlanExpandedChange: !isUser ? onPlanExpandedChange : undefined,
                planStepDetails: !isUser ? planStepDetails : undefined,
                onPlanStepDetailsChange: !isUser ? onPlanStepDetailsChange : undefined,
              })
            )}
            {!isEmpty && showStreaming && isLast && !isUser && <WorkingIndicator />}
          </div>
        )}
      </div>

      {showMenu && createPortal((
        <div
          data-message-context-menu
          className="message-context-menu motion-popover-enter"
          onMouseDown={(e) => e.preventDefault()}
          style={{
          position: 'fixed', left: menuPos.x, top: menuPos.y, zIndex: 1000,
          background: 'var(--bg-secondary)', border: '1px solid var(--border)',
          borderRadius: 8, padding: 4, boxShadow: 'none',
          minWidth: 120, userSelect: 'none', WebkitUserSelect: 'none',
        }}>
          <MenuItem label="复制 Markdown" onClick={() => handleCopy('markdown')} />
          <MenuItem label="复制纯文本" onClick={() => handleCopy('plainText')} />
          <MenuItem label="多选" onClick={handleMultiSelect} />
          <MenuItem label="删除" onClick={handleDelete} danger />
        </div>
      ), document.body)}
    </div>
  )
}

function MenuItem({ label, onClick, danger }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', width: '100%',
        background: 'none', border: 'none', padding: '7px 12px', borderRadius: 6,
        cursor: 'pointer', color: danger ? 'var(--error)' : 'var(--text-primary)',
        fontSize: 13, fontFamily: 'inherit', textAlign: 'left',
        userSelect: 'none', WebkitUserSelect: 'none',
      }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-tertiary)'}
      onMouseLeave={e => e.currentTarget.style.background = 'none'}
    >
      {label}
    </button>
  )
}

function PlanEmbed({ plan, hidePanel, sentinelRef, planExpanded, onPlanExpandedChange, planStepDetails, onPlanStepDetailsChange, streaming = false, defaultExpanded = false }) {
  return (
    <>
      {!hidePanel && (
        <ComplexTaskPlanPanel
          plan={plan}
          embedded
          streaming={streaming}
          defaultExpanded={defaultExpanded}
          expanded={planExpanded}
          onExpandedChange={onPlanExpandedChange}
          expandedStepDetails={planStepDetails}
          onExpandedStepDetailsChange={onPlanStepDetailsChange}
        />
      )}
      {sentinelRef ? <div ref={sentinelRef} className="complex-task-plan__sentinel" aria-hidden="true" /> : null}
    </>
  )
}

function renderMessageContent(content, { isUser, onChoice, onShellCommand, livePlan, planSnapshot, hideLivePlan = false, streaming, suppressPlanTools, planSentinelRef, hideEmbeddedPlan, planExpanded, onPlanExpandedChange, planStepDetails, onPlanStepDetailsChange }) {
  if (isUser) {
    return content.map((block, index) => (
      <ContentBlock key={block.id ?? index} block={block} isUser={isUser} onChoice={onChoice} onShellCommand={onShellCommand} />
    ))
  }

  let snapshotShown = false
  let livePlanShown = false
  const nodes = []
  const partitioned = partitionContentBlocks(content)
  const showLivePlan = livePlan && !hideLivePlan && !planSnapshot

  const firstPlanToolItemIndex = partitioned.findIndex(
    (item) => item.kind === 'block'
      && item.block.type === 'tool_use'
      && isPlanManagementTool(item.block.name),
  )
  const firstExecutionItemIndex = partitioned.findIndex((item) => {
    if (item.kind === 'tool_exec_group') return true
    if (item.kind !== 'block' || item.block.type !== 'tool_use') return false
    if (suppressPlanTools && isPlanManagementTool(item.block.name)) return false
    return true
  })

  const shouldEmbedSnapshotAtPlanTool = (itemIndex) => (
    !!planSnapshot
    && !snapshotShown
    && itemIndex === firstPlanToolItemIndex
  )

  const renderSnapshotPlan = () => (
    <PlanEmbed
      key="plan-snapshot"
      plan={planSnapshot}
      defaultExpanded
      streaming={streaming}
      hidePanel={false}
    />
  )

  const renderLivePlan = () => (
    <PlanEmbed
      key="plan-live"
      plan={livePlan}
      hidePanel={hideEmbeddedPlan}
      sentinelRef={planSentinelRef}
      planExpanded={planExpanded}
      onPlanExpandedChange={onPlanExpandedChange}
      planStepDetails={planStepDetails}
      onPlanStepDetailsChange={onPlanStepDetailsChange}
      streaming={streaming}
    />
  )

  const insertLivePlanIfNeeded = () => {
    if (!showLivePlan || livePlanShown) return
    nodes.push(renderLivePlan())
    livePlanShown = true
  }

  for (let itemIndex = 0; itemIndex < partitioned.length; itemIndex += 1) {
    const item = partitioned[itemIndex]

    if (
      planSnapshot
      && !snapshotShown
      && itemIndex === firstExecutionItemIndex
      && firstPlanToolItemIndex < 0
    ) {
      nodes.push(renderSnapshotPlan())
      snapshotShown = true
    }

    if (item.kind === 'tool_exec_group') {
      insertLivePlanIfNeeded()
      nodes.push(
        <ToolExecutionGroup
          key={item.key || nodes.length}
          blocks={item.blocks}
          streaming={!!streaming}
        />,
      )
      continue
    }

    if (suppressPlanTools && item.block.type === 'tool_use' && isPlanManagementTool(item.block.name)) {
      if (shouldEmbedSnapshotAtPlanTool(itemIndex)) {
        nodes.push(renderSnapshotPlan())
        snapshotShown = true
      }
      continue
    }


    nodes.push(
      <ContentBlock
        key={item.key || nodes.length}
        block={item.block}
        isUser={false}
        onChoice={onChoice}
        onShellCommand={onShellCommand}
        suppressPlanTools={suppressPlanTools}
        hideEmbeddedPlan={hideEmbeddedPlan}
        planSentinelRef={null}
        planExpanded={planExpanded}
        onPlanExpandedChange={onPlanExpandedChange}
        planStepDetails={planStepDetails}
        onPlanStepDetailsChange={onPlanStepDetailsChange}
        streaming={streaming}
      />,
    )
  }

  if (showLivePlan && !livePlanShown) {
    nodes.push(renderLivePlan())
  }

  return nodes
}

function extractBangCommands(codeText) {
  return String(codeText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('!') && line.slice(1).trim())
    .map((line) => ({
      original: line,
      command: line.slice(1).trim(),
    }))
}

function ShellCommandCodeBlock({ code, className, commands, onShellCommand, ...props }) {
  const [copied, setCopied] = useState(false)
  const [running, setRunning] = useState(false)
  const copyText = commands.map((item) => item.original).join('\n')

  const handleCopy = async (event) => {
    event.preventDefault()
    event.stopPropagation()
    try {
      await navigator.clipboard?.writeText(copyText)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch (error) {
      console.warn('[chat] copy shell command failed:', error)
    }
  }

  const handleExecute = async (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (!onShellCommand || running) return
    setRunning(true)
    try {
      for (const item of commands) {
        // eslint-disable-next-line no-await-in-loop
        await onShellCommand(item.command, item.original)
      }
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="chat-shell-command-block" onClick={(event) => event.stopPropagation()}>
      <div className="chat-shell-command-header" data-chat-input-ignore-focus>
        <span className="chat-shell-command-kind">
          bash
        </span>
        <span className="chat-shell-command-actions">
          <button type="button" className="chat-shell-command-action" onClick={handleCopy}>
            {copied ? '已复制' : '复制'}
          </button>
          <button type="button" className="chat-shell-command-action chat-shell-command-action--primary" onClick={handleExecute} disabled={!onShellCommand || running}>
            {running ? '执行中' : '执行'}
          </button>
        </span>
      </div>
      <code className={`chat-shell-command-code ${className || ''}`} {...props}>{code}</code>
    </div>
  )
}

/**
 * Tab 分隔的表格型代码块内容：每个 Tab 包进 span.tab-sep，竖线由 CSS 伪元素绘制
 * （伪元素内容不进选区，选中/复制拿到的仍是真实 Tab，粘贴到表格仍按列拆分）。
 */
function TabTableCode({ text }) {
  const parts = String(text ?? '').split('\t')
  const nodes = []
  parts.forEach((part, index) => {
    if (index > 0) nodes.push(<span key={`sep-${index}`} className="tab-sep">{'\t'}</span>)
    if (part) nodes.push(part)
  })
  return <code>{nodes}</code>
}

function MarkdownBody({ text, onShellCommand }) {
  if (!text) return null
  return (
    <div className="markdown message-text-selectable" style={{ color: 'inherit' }}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkCodeFilenames]} components={{
        a: ({ href, title, children }) => (
          <a
            href={href}
            title={title}
            target={href?.startsWith('#') ? undefined : '_blank'}
            rel="noopener noreferrer"
            onClick={handleChatLinkClick}
            onAuxClick={handleChatLinkClick}
          >{children}</a>
        ),
        img: ({ src, alt }) => src?.startsWith('data:') ? null : <img src={src} alt={alt} style={{ maxWidth: '100%' }} />,
        table: ({ children, ...props }) => (
          <div className="markdown-table-scroll">
            <table {...props}>{children}</table>
          </div>
        ),
        pre: ({ children, node }) => {
          const codeText = preChildText(children)
          const properties = node?.children?.[0]?.properties
          const filename = properties?.['data-code-filename'] ?? 'code'
          const language = properties?.className?.find(value => value.startsWith('language-'))?.slice(9)
          const tabTable = isTabTableBlock(codeText)
          return (
            <ChatCodeBlock filename={filename} text={codeText} language={language}
              preserveInline={tabTable || extractBangCommands(codeText).length > 0}>
              <pre className={tabTable ? 'markdown-tab-table' : undefined}>
                {tabTable ? <TabTableCode text={codeText} /> : children}
              </pre>
            </ChatCodeBlock>
          )
        },
        code: ({ node, className, children, 'data-code-filename': filename, ...props }) => {
          const codeText = String(children ?? '').replace(/\n$/, '')
          if (filename) {
            const commands = extractBangCommands(codeText)
            if (commands.length > 0) {
              return (
                <ShellCommandCodeBlock
                  code={codeText}
                  className={className}
                  commands={commands}
                  onShellCommand={onShellCommand}
                  {...props}
                />
              )
            }
          }
          return <code className={className} {...props}>{children}</code>
        },
      }}>{text}</ReactMarkdown>
    </div>
  )
}

function ContentBlock({ block, isUser, onChoice, onShellCommand, suppressPlanTools, streaming = false }) {
  if (block.type === 'text') {
    if (isUser) {
      return (
        <div
          className="message-text-selectable"
          style={{ color: 'inherit', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 'inherit', lineHeight: 'inherit' }}
        >
          {block.text || ''}
        </div>
      )
    }

    const displayText = String(block.text || '').trim()
    if (!displayText) return null
    return <MarkdownBody text={displayText} onShellCommand={onShellCommand} />
  }
  if (block.type === 'file_attachment') return <FileAttachmentBlock block={block} />
  if (block.type === 'user_choice') {
    return <UserChoiceBlock block={block} onChoice={onChoice} />
  }
  if (block.type === 'tool_use') {
    if (suppressPlanTools && isPlanManagementTool(block.name)) return null
    if (block.image) return <div style={{ margin: '4px 0' }}><ZoomableImage src={`data:image/jpeg;base64,${block.image}`} /><div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{block.thinkMs != null && `模型思考 ${formatTimingDuration(block.thinkMs)}`}{block.thinkMs != null && block.execMs != null && ' · '}{block.execMs != null && `执行 ${formatTimingDuration(block.execMs)}`}</div></div>
    return <ToolCallBlock block={block} streaming={streaming} />
  }
  if (block.type === 'image') return <ZoomableImage src={`data:image/jpeg;base64,${block.data}`} />
  if (block.type === 'image_url') return <ZoomableImage src={block.image_url?.url} />
  if (block.type === 'timing') return <TurnTimingFooter block={block} />
  if (block.type === 'error') return <div style={{ color: 'var(--error)', fontSize: 13 }}>⚠ {block.text}</div>
  return null
}

function FileAttachmentBlock({ block }) {
  return (
    <button
      type="button"
      onClick={() => window.electronAPI?.openPath?.(block.path)}
      title={block.path}
      className="chat-attachment-card chat-attachment-card--message"
    >
      <MessageAttachmentPreview file={block} />
      <span className="chat-attachment-card__content">
        <span className="chat-attachment-card__name">{block.name}</span>
        <span className="chat-attachment-card__type">{getFileTypeLabel(block.name || block.path)}</span>
      </span>
    </button>
  )
}

function MessageAttachmentPreview({ file }) {
  const [failed, setFailed] = useState(false)
  const [thumbnailSrc, setThumbnailSrc] = useState('')
  const name = file.name || file.path
  const isImage = getFileTypeMeta(name).kind === 'image'

  useEffect(() => {
    let cancelled = false
    setFailed(false)
    setThumbnailSrc('')
    if (!isImage || !file.path) return undefined

    window.electronAPI?.readLocalImageThumbnail?.(file.path)
      .then((src) => {
        if (cancelled) return
        setThumbnailSrc(src || localFileUrl(file.path))
      })
      .catch(() => {
        if (!cancelled) setThumbnailSrc(localFileUrl(file.path))
      })

    return () => {
      cancelled = true
    }
  }, [file.path, isImage])

  const src = isImage ? (thumbnailSrc || localFileUrl(file.path)) : ''

  if (src && !failed) {
    return (
      <span className="chat-attachment-card__thumb">
        <img src={src} alt="" onError={() => setFailed(true)} />
      </span>
    )
  }

  return (
    <span className="chat-attachment-card__icon" aria-hidden="true">
      <FileGlyph name={name} size={22} />
    </span>
  )
}

function UserChoiceBlock({ block, onChoice }) {
  const choice = normalizeUserChoiceBlock(block)
  const isPending = choice.status === 'pending'

  return (
    <div className="user-choice-block">
      <div className="user-choice-block__question">
        {choice.question}
      </div>
      {choice.status === 'answered' ? (
        <div className="user-choice-block__answered">
          {choice.answer}
        </div>
      ) : (
        <div className="user-choice-block__options">
          {(choice.options ?? []).map((opt, i) => (
            <button
              key={i}
              type="button"
              className="user-choice-block__option"
              onClick={() => isPending && onChoice?.(choice.id, opt.label)}
              disabled={!isPending}
            >
              <span className="user-choice-block__option-label">{opt.label}</span>
              {opt.description ? (
                <span className="user-choice-block__option-desc">{opt.description}</span>
              ) : null}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ZoomableImage({ src }) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <img src={src} alt="screenshot" onClick={() => setOpen(true)} title="鐐瑰嚮鏀惧ぇ"
        style={{ maxWidth: '100%', borderRadius: 8, marginTop: 4, border: '1px solid var(--border)', cursor: 'zoom-in' }} />
      {open && <ImageLightbox src={src} onClose={() => setOpen(false)} />}
    </>
  )
}

function TurnTimingFooter({ block }) {
  const segs = [
    `⏱ 本轮 ${formatTimingTotal(block.llmMs, block.execMs)}`,
    `模型思考 ${formatTimingDuration(block.llmMs)}`,
    `执行 ${formatTimingDuration(block.execMs)}`,
    `${block.steps ?? 0} 步`,
  ]
  return (
    <div style={{
      marginTop: 8, paddingTop: 6, borderTop: '1px dashed var(--border)',
      fontSize: 11, color: 'var(--text-muted)', display: 'flex', gap: 12, flexWrap: 'wrap',
    }}>
      {segs.map((s, i) => <span key={i}>{s}</span>)}
    </div>
  )
}
