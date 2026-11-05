import React, { useState } from 'react'
import { Tooltip } from 'antd'
import { formatToolResultText, getToolExecLineText, getToolExecTooltipText, getToolExecGroupLabel, getToolExecStatusText } from '../../utils/tool-display.js'
import ToolRunningIndicator from './ToolRunningIndicator.jsx'
import ToolTimingBadge from './ToolTimingBadge.jsx'
import { ToolExecIcon, ToolRowChevron } from './ToolRowIcons.jsx'

function getBlockKey(block, index) {
  return block.id ?? `bash-${index}`
}

export default function ToolExecutionGroup({ blocks, streaming = false }) {
  const [open, setOpen] = useState(() => blocks.some((block) => block.chatBang))
  const [expandedKeys, setExpandedKeys] = useState(() => new Set(
    blocks
      .map((block, index) => block.chatBang ? getBlockKey(block, index) : null)
      .filter(Boolean),
  ))

  if (!blocks?.length) return null

  const label = getToolExecGroupLabel(blocks)
  const showRunning = streaming && blocks.some((block) => block.status === 'running')
  // Credited execution shares are disjoint, so this subtotal matches the turn ledger.
  const groupThinkMs = blocks.reduce((sum, block) => sum + (block.thinkMs || 0), 0)
  const groupExecMs = blocks.reduce((sum, block) => sum + (block.execMs || 0), 0)

  const toggleDetail = (key) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div className="tool-exec-group">
      <button
        type="button"
        className="tool-row-header tool-exec-group__header"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="tool-row-header__icon" aria-hidden="true">
          {showRunning ? <ToolRunningIndicator /> : <ToolExecIcon />}
        </span>
        <span className="tool-row-header__body">
          <span className="tool-exec-group__header-label">{label}</span>
          <ToolTimingBadge thinkMs={groupThinkMs} execMs={groupExecMs} showTotal />
          <span className="tool-row-header__chevron tool-exec-group__header-chevron" aria-hidden="true">
            <ToolRowChevron expanded={open} />
          </span>
        </span>
      </button>

      {open && (
        <div className="tool-exec-group__code">
          {blocks.map((block, index) => {
            const command = getToolExecLineText(block)
            const running = streaming && block.status === 'running'
            const blockKey = getBlockKey(block, index)
            const detailOpen = expandedKeys.has(blockKey)
            const resultText = formatToolResultText(block, '')
            const hasResult = resultText.length > 0

            return (
              <div key={blockKey} className="tool-exec-group__entry">
                <Tooltip
                  trigger={['hover', 'focus']}
                  color="#fff"
                  styles={{ body: { color: '#333', border: '1px solid #e5e7eb', boxShadow: '0 8px 18px rgba(0, 0, 0, 0.12)' } }}
                  overlayStyle={{ maxWidth: 'min(720px, calc(100vw - 32px))' }}
                  title={<pre style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '50vh', overflowY: 'auto', font: 'inherit', userSelect: 'text' }}>{getToolExecTooltipText(block)}</pre>}
                >

                <button
                  type="button"
                  data-custom-tooltip-zone="true"
                  className={`tool-exec-group__line${detailOpen ? ' tool-exec-group__line--open' : ''}`}
                  onClick={() => toggleDetail(blockKey)}
                  aria-expanded={detailOpen}
                >
                  <span className="tool-exec-group__status">{getToolExecStatusText(block, streaming)}</span>
                  <span className="tool-exec-group__line-body">
                    <span className="tool-exec-group__command">{command}</span>
                    <ToolTimingBadge thinkMs={block.thinkMs} execMs={block.execMs} />
                    {!running && (
                      <span className="tool-row-header__chevron tool-exec-group__line-chevron" aria-hidden="true">
                        <ToolRowChevron expanded={detailOpen} />
                      </span>
                    )}
                  </span>
                </button>
                </Tooltip>

                {detailOpen && (
                  <div className="tool-exec-group__detail">
                    <div className="tool-exec-group__detail-scroll">
                      {hasResult ? (
                        <pre className="tool-exec-group__detail-pre">{resultText}</pre>
                      ) : running ? (
                        <span className="tool-exec-group__detail-placeholder">等待命令输出…</span>
                      ) : (
                        <span className="tool-exec-group__detail-placeholder">(无输出)</span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
