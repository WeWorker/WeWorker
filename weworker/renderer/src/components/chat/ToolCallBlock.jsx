import React, { useState } from 'react'
import ImageLightbox from './ImageLightbox.jsx'
import SkillToolCallBlock from './SkillToolCallBlock.jsx'
import TodoWriteToolBlock from './TodoWriteToolBlock.jsx'
import ToolRunningIndicator from './ToolRunningIndicator.jsx'
import { ToolGenericIcon } from './ToolRowIcons.jsx'
import { displayToolName } from '../../utils/tool-name.js'
import { formatTimingDuration } from '../../utils/format-timing-duration.js'
import { formatToolResultText, getToolCallSummary } from '../../utils/tool-display.js'
import { isTodoWriteTool } from '../../utils/todowrite-state.js'

function GenericToolCallBlock({ block, streaming = false }) {
  const [open, setOpen] = useState(false)
  const [lightbox, setLightbox] = useState(false)
  const running = streaming && block.status === 'running'
  const rawName = block.name || ''
  const displayName = displayToolName(rawName)
  const summary = getToolCallSummary(block.args)
  const timingLabel = [
    block.thinkMs != null ? `非执行${formatTimingDuration(block.thinkMs)}` : '',
    block.execMs != null ? `执行份额${formatTimingDuration(block.execMs)}` : '',
  ].filter(Boolean).join(' · ')

  return (
    <div style={{
      margin: '6px 0',
      border: '1px solid var(--border)',
      borderRadius: 8,
      overflow: 'hidden',
      fontSize: 12,
    }}>
      <div
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%',
          background: 'rgba(255,255,255,0.04)',
          border: 'none',
          color: 'var(--text-secondary)',
          cursor: 'pointer',
          padding: '6px 10px',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          textAlign: 'left',
        }}
      >
        <span style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, color: 'var(--text-muted)' }}>
          {running ? <ToolRunningIndicator /> : <ToolGenericIcon />}
        </span>
        <span
          onClick={(e) => {
            const sel = window.getSelection()
            if (sel && sel.toString().length > 0) e.stopPropagation()
          }}
          style={{ flexShrink: 0, fontFamily: 'monospace', fontSize: 11, userSelect: 'text', cursor: 'text' }}
        >
          {displayName || '(tool)'}
        </span>
        {summary && !open && (
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontFamily: 'monospace',
              fontSize: 11,
              color: 'var(--text-muted)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              userSelect: 'text',
              cursor: 'text',
            }}
            onClick={(e) => {
              const sel = window.getSelection()
              if (sel && sel.toString().length > 0) e.stopPropagation()
            }}
          >
            {' — '}{summary}
          </span>
        )}
        {timingLabel && (
          <span
            style={{
              marginLeft: 'auto',
              flexShrink: 0,
              fontFamily: 'monospace',
              fontSize: 10,
              color: 'var(--text-muted)',
              background: 'rgba(255,255,255,0.05)',
              padding: '1px 6px',
              borderRadius: 8,
              userSelect: 'text',
              cursor: 'text',
            }}
            onClick={(e) => {
              const sel = window.getSelection()
              if (sel && sel.toString().length > 0) e.stopPropagation()
            }}
          >
            {timingLabel}
          </span>
        )}
        <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{open ? '▲' : '▼'}</span>
      </div>

      {open && (
        <div style={{ padding: '8px 10px', background: 'rgba(0,0,0,0.2)' }}>
          {block.args && Object.keys(block.args).length > 0 && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ color: 'var(--text-muted)', marginBottom: 3 }}>参数</div>
              <pre style={{ margin: 0, fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {JSON.stringify(block.args, null, 2)}
              </pre>
            </div>
          )}

          {block.image && (
            <div style={{ marginTop: 6 }}>
              <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>截图</div>
              <img
                src={`data:image/jpeg;base64,${block.image}`}
                alt="screenshot"
                onDoubleClick={() => setLightbox(true)}
                title="双击放大"
                style={{ maxWidth: '100%', borderRadius: 6, border: '1px solid var(--border)', cursor: 'zoom-in' }}
              />
              {lightbox && (
                <ImageLightbox
                  src={`data:image/jpeg;base64,${block.image}`}
                  onClose={() => setLightbox(false)}
                />
              )}
            </div>
          )}

          {block.result && !block.image && (
            <div style={{ marginTop: 6 }}>
              <div style={{ color: 'var(--text-muted)', marginBottom: 3 }}>结果</div>
              <pre style={{ margin: 0, fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 200, overflowY: 'auto' }}>
                {formatToolResultText(block)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function ToolCallBlock({ block, streaming = false }) {
  if (block.name === 'Skill') {
    return <SkillToolCallBlock block={block} streaming={streaming} />
  }
  if (isTodoWriteTool(block.name)) {
    return <TodoWriteToolBlock block={block} streaming={streaming} />
  }
  return <GenericToolCallBlock block={block} streaming={streaming} />
}
