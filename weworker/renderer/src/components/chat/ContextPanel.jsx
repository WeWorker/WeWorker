import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  CONTEXT_CATEGORY_META,
  CONTEXT_SCOPE_LABELS,
  contextUsagePercent,
  createEmptyContextSnapshot,
  formatContextTokens,
  normalizeContextSnapshot,
} from '../../utils/context-snapshot.js'

export default function ContextPanel({ snapshot, contextLimit, usageOnly = false }) {
  const normalized = useMemo(
    () => normalizeContextSnapshot(snapshot || createEmptyContextSnapshot(contextLimit), contextLimit),
    [snapshot, contextLimit],
  )
  const [open, setOpen] = useState(false)
  const [hoveredCategoryId, setHoveredCategoryId] = useState(null)
  const buttonRef = useRef(null)
  const [placement, setPlacement] = useState(null)

  useEffect(() => {
    if (!open) return undefined
    const update = () => {
      const rect = buttonRef.current?.getBoundingClientRect()
      if (!rect) return
      const panelWidth = Math.min(520, window.innerWidth - 24)
      const preferredLeft = rect.left - panelWidth - 10
      setPlacement({
        left: Math.max(12, Math.min(preferredLeft, window.innerWidth - panelWidth - 12)),
        bottom: Math.max(12, window.innerHeight - rect.top + 10),
      })
    }
    const closeOnOutside = (event) => {
      if (!buttonRef.current?.contains(event.target) && !event.target.closest?.('[data-context-panel]')) setOpen(false)
    }
    update()
    document.addEventListener('mousedown', closeOnOutside)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      document.removeEventListener('mousedown', closeOnOutside)
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  if (!normalized) return null
  const percent = contextUsagePercent(normalized)
  const categories = usageOnly ? [] : normalized.categories
  const grouped = ['runtime', 'work', 'long_term'].map((scope) => ({
    scope,
    items: categories.filter((item) => item.scope === scope),
  })).filter((group) => group.items.length > 0)

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="context-usage-trigger"
        aria-label="查看上下文"
        aria-expanded={open}
        title={usageOnly ? '查看探索上下文用量' : '查看上下文组成'}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="context-usage-ring" style={{ '--context-percent': `${percent}%` }} aria-hidden="true" />
        <span>{Math.round(percent)}%</span>
      </button>
      {open && placement && createPortal(
        <div
          data-context-panel
          className="context-panel motion-popover-enter"
          style={{ left: placement.left, bottom: placement.bottom }}
          role="dialog"
          aria-label="上下文组成"
        >
          <div className="context-panel__header">
            <div>
              <div className="context-panel__title">上下文</div>
            </div>
            <button type="button" className="context-panel__close" onClick={() => setOpen(false)} aria-label="关闭上下文面板" title="关闭">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
          <div className="context-panel__summary">
            <span>{Math.round(percent)}% 已使用</span>
            <span>
              {normalized.token_source === 'provider_calibrated' ? '' : '~'}
              {formatContextTokens(normalized.displayed_total_tokens)} / {formatContextTokens(normalized.context_limit)} tokens
            </span>
          </div>
          <div className="context-panel__bar" aria-hidden="true">
            {usageOnly && <span style={{ width: `${percent}%`, background: 'var(--accent)' }} />}
            {categories.map((item) => {
              const displayedTokens = item.calibrated_tokens ?? item.estimated_tokens
              const width = normalized.context_limit > 0
                ? (displayedTokens / normalized.context_limit) * 100
                : 0
              const isDimmed = hoveredCategoryId !== null && hoveredCategoryId !== item.id
              return (
                <span
                  key={item.id}
                  className={isDimmed ? 'is-dimmed' : undefined}
                  style={{ width: `${width}%`, background: CONTEXT_CATEGORY_META[item.id].color }}
                />
              )
            })}
          </div>
          {usageOnly ? <p className="context-panel__source">{snapshot ? '供应商最近一次请求返回的输入 token 用量。' : '尚未收到供应商返回的上下文用量。'}</p> : <div className="context-panel__groups">
            {grouped.map((group) => (
              <section key={group.scope} className="context-panel__group">
                <div className="context-panel__group-label">{CONTEXT_SCOPE_LABELS[group.scope]}</div>
                {group.items.map((item) => {
                  const meta = CONTEXT_CATEGORY_META[item.id]
                  return (
                    <div
                      className="context-panel__row"
                      key={item.id}
                      onMouseEnter={() => setHoveredCategoryId(item.id)}
                      onMouseLeave={() => setHoveredCategoryId(null)}
                    >
                      <span className="context-panel__swatch" style={{ background: meta.color }} aria-hidden="true" />
                      <span className="context-panel__name">{meta.label}</span>
                      <span className="context-panel__tokens">{formatContextTokens(item.calibrated_tokens ?? item.estimated_tokens)}</span>
                    </div>
                  )
                })}
              </section>
            ))}
          </div>}
        </div>,
        document.body,
      )}
    </>
  )
}
