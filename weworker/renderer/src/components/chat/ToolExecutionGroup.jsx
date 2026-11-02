import React, { useState } from 'react'
import { formatToolResultText, getToolExecLineText, getToolExecGroupLabel } from '../../utils/tool-display.js'
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
          <ToolTimingBadge thinkMs={groupThinkMs} execMs={groupExecMs} totalMs={groupThinkMs + groupExecMs} />
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
                <button
                  type="button"
                  className={`tool-exec-group__line${detailOpen ? ' tool-exec-group__line--open' : ''}`}
                  onClick={() => toggleDetail(blockKey)}
                  aria-expanded={detailOpen}
                >
                  <span className="tool-exec-group__status">{running ? '执行中' : '已执行'}</span>
                  <span className="tool-exec-group__line-body">
                    <span className="tool-exec-group__command" title={command}>{command}</span>
                    <ToolTimingBadge thinkMs={block.thinkMs} execMs={block.execMs} />
                    {!running && (
                      <span className="tool-row-header__chevron tool-exec-group__line-chevron" aria-hidden="true">
                        <ToolRowChevron expanded={detailOpen} />
                      </span>
                    )}
                  </span>
                </button>

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
