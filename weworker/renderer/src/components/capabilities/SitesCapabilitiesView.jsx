import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSitesStore } from '../../store/sites.js'
import { normalizeSiteScenarios, getScenarioPromptText } from '../../utils/site-scenarios.js'
import { useChatInputFillStore } from '../../store/chat-input-fill.js'
import SiteIcon from '../icons/SiteIcon.jsx'
import EditablePromptTemplate from '../prompt/EditablePromptTemplate.jsx'
import { setSiteDragData } from '../../utils/site-drag.js'
import { buildPromptFromTemplate } from '../../utils/prompt-template.js'
import AnimatedCollapse from '../common/AnimatedCollapse.jsx'

const GRID_TILE_MIN_WIDTH = 86
const GRID_TILE_GAP = 6
const VIEW_SWITCH_TRANSITION_MS = 190
const GRID_LAYOUT_TRANSITION_MS = 220

/**
 * Primary UX: capability map — users see what each site can do without expanding technical tools.
 */
export default function SitesCapabilitiesView({
  searchQuery = '',
  onSearchQueryChange,
  hideToolbarSearch = false,
  viewMode = 'list',
}) {
  const { sites, loading } = useSitesStore()
  const [focusedId, setFocusedId] = useState(null)
  const [gridColumnCount, setGridColumnCount] = useState(3)
  const [displayedViewMode, setDisplayedViewMode] = useState(viewMode === 'grid' ? 'grid' : 'list')
  const [leavingViewMode, setLeavingViewMode] = useState(null)
  const [viewEntering, setViewEntering] = useState(true)
  const [viewDirection, setViewDirection] = useState(1)
  const displayedViewModeRef = useRef(displayedViewMode)
  const gridRef = useRef(null)
  const layoutNodeRefs = useRef(new Map())
  const previousLayoutRects = useRef(new Map())
  const requestFill = useChatInputFillStore((s) => s.requestFill)

  const handleScenarioClick = (site, scenario, editedPrompt) => {
    const text = editedPrompt || getScenarioPromptText(site, scenario)
    if (text) requestFill(text)
  }

  const siteDragProps = (site) => ({
    draggable: true,
    onDragStart: (event) => setSiteDragData(event.dataTransfer, site.id),
  })

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return sites
    return sites.filter((site) => {
      const scenarios = normalizeSiteScenarios(site)
      if (site.name.toLowerCase().includes(q)) return true
      if (site.description?.toLowerCase().includes(q)) return true
      return scenarios.some(
        (sc) => sc.title.toLowerCase().includes(q) || sc.summary.toLowerCase().includes(q),
      )
    })
  }, [sites, searchQuery])
  const activeViewMode = viewMode === 'grid' ? 'grid' : 'list'
  const gridRows = useMemo(() => chunkIntoRows(filtered, gridColumnCount), [filtered, gridColumnCount])
  const gridLayoutSignature = useMemo(
    () => `${displayedViewMode}:${focusedId || ''}:${gridColumnCount}:${filtered.map((site) => site.id).join('|')}`,
    [displayedViewMode, filtered, focusedId, gridColumnCount],
  )

  const bindLayoutNode = (siteId) => (node) => {
    if (node) layoutNodeRefs.current.set(siteId, node)
    else layoutNodeRefs.current.delete(siteId)
  }

  useLayoutEffect(() => {
    if (displayedViewMode !== 'grid') {
      previousLayoutRects.current = new Map()
      return undefined
    }

    const nextRects = new Map()
    for (const [siteId, node] of layoutNodeRefs.current.entries()) {
      if (!node?.isConnected) continue
      const nextRect = node.getBoundingClientRect()
      const previousRect = previousLayoutRects.current.get(siteId)
      nextRects.set(siteId, nextRect)

      if (!previousRect) continue
      const deltaX = previousRect.left - nextRect.left
      const deltaY = previousRect.top - nextRect.top
      const scaleX = previousRect.width > 0 && nextRect.width > 0 ? previousRect.width / nextRect.width : 1
      const scaleY = previousRect.height > 0 && nextRect.height > 0 ? previousRect.height / nextRect.height : 1
      const moved = Math.abs(deltaX) > 1 || Math.abs(deltaY) > 1
      const resized = Math.abs(scaleX - 1) > 0.02 || Math.abs(scaleY - 1) > 0.02
      if (!moved && !resized) continue

      node.animate(
        [
          { transform: `translate(${deltaX}px, ${deltaY}px) scale(${scaleX}, ${scaleY})` },
          { transform: 'translate(0, 0) scale(1, 1)' },
        ],
        { duration: GRID_LAYOUT_TRANSITION_MS, easing: 'ease' },
      )
    }
    previousLayoutRects.current = nextRects
    return undefined
  }, [displayedViewMode, gridLayoutSignature])

  useEffect(() => {
    if (activeViewMode === displayedViewModeRef.current) return undefined
    const previousViewMode = displayedViewModeRef.current
    const nextDirection = activeViewMode === 'grid' ? 1 : -1
    let enterFrame = 0
    let settleFrame = 0
    let cleanupTimer = 0

    setViewDirection(nextDirection)
    setLeavingViewMode(previousViewMode)
    setDisplayedViewMode(activeViewMode)
    displayedViewModeRef.current = activeViewMode
    setViewEntering(false)

    enterFrame = window.requestAnimationFrame(() => {
      settleFrame = window.requestAnimationFrame(() => {
        setViewEntering(true)
      })
    })
    cleanupTimer = window.setTimeout(() => {
      setLeavingViewMode(null)
    }, VIEW_SWITCH_TRANSITION_MS)

    return () => {
      window.cancelAnimationFrame(enterFrame)
      window.cancelAnimationFrame(settleFrame)
      window.clearTimeout(cleanupTimer)
    }
  }, [activeViewMode])

  useEffect(() => {
    if (displayedViewMode !== 'grid') return undefined
    const node = gridRef.current
    if (!node) return undefined

    const updateColumnCount = () => {
      const width = node.clientWidth || 0
      const next = Math.max(1, Math.floor((width + GRID_TILE_GAP) / (GRID_TILE_MIN_WIDTH + GRID_TILE_GAP)))
      setGridColumnCount((current) => (current === next ? current : next))
    }

    updateColumnCount()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateColumnCount) : null
    observer?.observe(node)
    window.addEventListener('resize', updateColumnCount)

    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', updateColumnCount)
    }
  }, [displayedViewMode])

  const renderViewContent = (mode, options = {}) => {
    if (mode === 'list') {
      return (
        <div className="cap-site-list">
          {filtered.map((site) => {
            const scenarios = normalizeSiteScenarios(site)
            const expanded = focusedId === site.id
            return (
              <SiteListRow
                key={site.id}
                site={site}
                scenarios={scenarios}
                expanded={expanded}
                onToggle={() => setFocusedId(expanded ? null : site.id)}
                onScenarioClick={handleScenarioClick}
                dragProps={siteDragProps(site)}
                layoutRef={displayedViewMode === 'grid' ? bindLayoutNode(site.id) : undefined}
              />
            )
          })}
        </div>
      )
    }

    return (
      <div className="cap-site-mini-grid" ref={options.leaving ? null : gridRef}>
        {gridRows.map((row, rowIndex) => {
          const expandedIndex = row.findIndex((site) => site.id === focusedId)
          if (expandedIndex === -1) {
            return (
              <MiniTileRow
                key={`row-${rowIndex}`}
                sites={row}
                onToggleSite={setFocusedId}
                dragPropsForSite={siteDragProps}
                layoutRefForSite={bindLayoutNode}
              />
            )
          }

          const before = row.slice(0, expandedIndex)
          const site = row[expandedIndex]
          const after = row.slice(expandedIndex + 1)
          const scenarios = normalizeSiteScenarios(site)
          return (
            <React.Fragment key={`row-${rowIndex}`}>
              {before.length > 0 && (
                <MiniTileRow
                  sites={before}
                  onToggleSite={setFocusedId}
                  dragPropsForSite={siteDragProps}
                  layoutRefForSite={bindLayoutNode}
                />
              )}
              <SiteListRow
                site={site}
                scenarios={scenarios}
                expanded
                className="cap-site-grid-expanded"
                onToggle={() => setFocusedId(null)}
                onScenarioClick={handleScenarioClick}
                dragProps={siteDragProps(site)}
                layoutRef={bindLayoutNode(site.id)}
              />
              {after.length > 0 && (
                <MiniTileRow
                  sites={after}
                  onToggleSite={setFocusedId}
                  dragPropsForSite={siteDragProps}
                  layoutRefForSite={bindLayoutNode}
                />
              )}
            </React.Fragment>
          )
        })}
      </div>
    )
  }

  if (loading && sites.length === 0) {
    return <div className="cap-empty">加载中…</div>
  }

  return (
    <div className="cap-root cap-root--dock">
      {!hideToolbarSearch && onSearchQueryChange && (
        <div className="cap-toolbar">
          <input
            className="cap-search"
            type="search"
            placeholder="搜索网站或场景，如「团建」「发票」「京东」"
            value={searchQuery}
            onChange={(e) => onSearchQueryChange(e.target.value)}
          />
        </div>
      )}

      <div className="cap-view-shell">
        {leavingViewMode && (
          <div
            className="cap-view cap-view--leaving"
            style={{
              '--cap-view-offset': `${viewDirection * -18}px`,
              transitionDuration: `${VIEW_SWITCH_TRANSITION_MS}ms`,
              animationDuration: `${VIEW_SWITCH_TRANSITION_MS}ms`,
            }}
          >
            {renderViewContent(leavingViewMode, { leaving: true })}
          </div>
        )}
        <div
          key={displayedViewMode}
          className="cap-view"
          style={{
            opacity: viewEntering ? 1 : 0,
            transform: viewEntering ? 'translateX(0)' : `translateX(${viewDirection * 18}px)`,
            transitionDuration: `${VIEW_SWITCH_TRANSITION_MS}ms`,
          }}
        >
          {renderViewContent(displayedViewMode)}
        </div>
      </div>

      {filtered.length === 0 && (
        <div className="cap-empty">没有匹配的网站或场景</div>
      )}

      <style>{CAPABILITY_CSS}</style>
    </div>
  )
}

function chunkIntoRows(items, size) {
  const rows = []
  const rowSize = Math.max(1, size)
  for (let i = 0; i < items.length; i += rowSize) {
    rows.push(items.slice(i, i + rowSize))
  }
  return rows
}

function MiniTileRow({
  sites,
  onToggleSite,
  dragPropsForSite,
  layoutRefForSite,
}) {
  return (
    <div className="cap-site-mini-row" style={{ '--cap-row-columns': sites.length }}>
      {sites.map((site) => (
        <SiteMiniTile
          key={site.id}
          site={site}
          expanded={false}
          onToggle={() => onToggleSite(site.id)}
          dragProps={dragPropsForSite(site)}
          layoutRef={layoutRefForSite?.(site.id)}
        />
      ))}
    </div>
  )
}

function SiteListRow({
  site,
  scenarios,
  expanded,
  className = '',
  onToggle,
  onScenarioClick,
  dragProps,
  layoutRef,
}) {
  const visibleScenarios = scenarios
  const tooltip = useCapabilityTooltip('点击展开场景 · 可拖拽到欢迎界面')
  return (
    <article
      ref={layoutRef}
      className={`cap-site-row-card ${site.enabled ? '' : 'cap-site-row-card--off'} ${expanded ? 'cap-site-row-card--open' : ''} ${className}`}
    >
      <div
        className="cap-site-row"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onMouseEnter={tooltip.show}
        onMouseLeave={tooltip.hide}
        onClick={() => {
          tooltip.hide()
          onToggle?.()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            tooltip.hide()
            onToggle?.()
          }
        }}
        {...withTooltipHiddenOnDragStart(dragProps, tooltip.hide)}
      >
        <div className="cap-site-row-icon" aria-hidden>
          <SiteIcon site={site} size={22} />
        </div>
        <div className="cap-site-row-copy">
          <div className="cap-site-row-title">
            <h3>{site.name}</h3>
            {site.routable ? (
              <span
                className="cap-site-row-badge"
                title={`已配置 ${site.routeEntryCount} 条直达规则：这类请求不用逐工具试探，命中即直接调用`}
              >
                路由直达
              </span>
            ) : null}
          </div>
          <p>{site.description}</p>
        </div>
      </div>

      <AnimatedCollapse open={expanded} unmountOnExit>
        <div className="cap-site-row-detail">
          <div className="cap-scenario-list cap-scenario-list--row-detail">
            {visibleScenarios.map((scenario, index) => (
              <ScenarioTile
                key={scenario.id || scenario.title}
                site={site}
                scenario={scenario}
                index={index}
                compact={false}
                onUse={(promptText) => onScenarioClick?.(site, scenario, promptText)}
              />
            ))}
          </div>
        </div>
      </AnimatedCollapse>
      {tooltip.node}
    </article>
  )
}

function SiteMiniTile({
  site,
  expanded,
  onToggle,
  dragProps,
  layoutRef,
}) {
  const tooltip = useCapabilityTooltip('点击展开场景 · 可拖拽到欢迎界面')
  return (
    <>
      <article
        ref={layoutRef}
        className={`cap-site-mini ${site.enabled ? '' : 'cap-site-mini--off'} ${expanded ? 'cap-site-mini--open' : ''}`}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onMouseEnter={tooltip.show}
        onMouseLeave={tooltip.hide}
        onClick={() => {
          tooltip.hide()
          onToggle?.()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            tooltip.hide()
            onToggle?.()
          }
        }}
        {...withTooltipHiddenOnDragStart(dragProps, tooltip.hide)}
      >
        <SiteIcon site={site} size={20} />
        <span>{site.name}</span>
        {site.routable ? (
          <span
            className="cap-site-mini-badge"
            aria-hidden="true"
            title={`已配置 ${site.routeEntryCount} 条直达规则`}
          />
        ) : null}
      </article>
      {tooltip.node}
    </>
  )
}

function withTooltipHiddenOnDragStart(dragProps = {}, hideTooltip) {
  if (!dragProps.onDragStart) return dragProps
  return {
    ...dragProps,
    onDragStart: (event) => {
      hideTooltip?.()
      dragProps.onDragStart(event)
    },
  }
}

function useCapabilityTooltip(text) {
  const [style, setStyle] = useState(null)

  const show = (event) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const margin = 8
    const tooltipWidth = 220
    const centerX = rect.left + rect.width / 2
    const left = Math.min(Math.max(centerX, margin + tooltipWidth / 2), window.innerWidth - margin - tooltipWidth / 2)

    setStyle({
      position: 'fixed',
      left,
      top: Math.max(margin, rect.top - 6),
      transform: 'translate(-50%, -100%)',
      zIndex: 10000,
      pointerEvents: 'none',
    })
  }

  const hide = () => setStyle(null)

  return {
    show,
    hide,
    node: style
      ? createPortal(
          <div className="cap-floating-tooltip" style={style}>
            {text}
          </div>,
          document.body,
        )
      : null,
  }
}

function ScenarioTile({ site, scenario, index, compact, onUse }) {
  const hasSteps = scenario.steps?.length > 0
  const varDisplay = site.promptVarDisplay || {}
  const prompts = Array.isArray(scenario.prompts) ? scenario.prompts.filter((p) => p?.text?.trim()) : []
  const [promptValues, setPromptValues] = useState({})

  const updatePromptValue = (promptIndex, slotKey, value) => {
    setPromptValues((current) => ({
      ...current,
      [promptIndex]: {
        ...(current[promptIndex] || {}),
        [slotKey]: value,
      },
    }))
  }

  const buildEditedPrompt = () => {
    const prompt = prompts[0]
    if (prompt?.text?.trim()) {
      return buildPromptFromTemplate(prompt.text, promptValues[0] || {}, varDisplay).trim()
    }
    return getScenarioPromptText(site, scenario)
  }

  return (
    <div
      role={onUse ? 'button' : undefined}
      tabIndex={onUse ? 0 : undefined}
      className={`cap-scenario ${compact ? 'cap-scenario--compact' : ''} ${onUse ? 'cap-scenario--clickable' : ''}`}
      onClick={(e) => {
        e.stopPropagation()
        onUse?.(buildEditedPrompt())
      }}
      onKeyDown={(e) => {
        if (!onUse || (e.key !== 'Enter' && e.key !== ' ')) return
        e.preventDefault()
        e.stopPropagation()
        onUse(buildEditedPrompt())
      }}
      title={onUse ? '点击填入对话框' : undefined}
    >
      <div className="cap-scenario-num">{index + 1}</div>
      <div className="cap-scenario-body">
        <div className="cap-scenario-line">
          <span className="cap-scenario-title">{scenario.title}</span>
          <span className="cap-scenario-summary">{scenario.summary}</span>
        </div>

        {!compact && hasSteps && (
          <div className="cap-flow">
            {scenario.steps.map((step, i) => (
              <div key={i} className="cap-flow-step">
                {i > 0 && <span className="cap-flow-arrow">→</span>}
                <span className="cap-flow-label">{step}</span>
              </div>
            ))}
          </div>
        )}

        {!compact && prompts.length > 0 && (
          <div className="cap-prompt-stack">
            {prompts.map((prompt, promptIndex) => (
              <div key={`${scenario.id || scenario.title}-${promptIndex}`} className="cap-prompt-bubble">
                <span className="cap-prompt-label">💬 可以这样说 · 点击填入</span>
                <p>
                  <EditablePromptTemplate
                    text={prompt.text}
                    varDisplay={varDisplay}
                    values={promptValues[promptIndex] || {}}
                    onChange={(slotKey, value) => updatePromptValue(promptIndex, slotKey, value)}
                  />
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const CAPABILITY_CSS = `
.cap-root { display: flex; flex-direction: column; gap: 8px; }

.cap-toolbar { display: flex; gap: 8px; }
.cap-search {
  flex: 1; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--border);
  background: var(--bg-secondary); color: var(--text-primary); font-size: 12px; outline: none;
}
.cap-search:focus { border-color: var(--accent); }

.cap-view-shell {
  position: relative;
  min-width: 0;
  overflow: visible;
}
.cap-view {
  min-width: 0;
  transition-property: opacity, transform;
  transition-timing-function: ease;
  will-change: opacity, transform;
}
.cap-view--leaving {
  position: absolute;
  inset: 0;
  opacity: 1;
  transform: translateX(0);
  animation-name: cap-view-leave;
  animation-timing-function: ease;
  animation-fill-mode: forwards;
  pointer-events: none;
}
@keyframes cap-view-leave {
  to {
    opacity: 0;
    transform: translateX(var(--cap-view-offset));
  }
}

.cap-site-list {
  display: grid;
  gap: 0;
  background: var(--bg-primary);
}
.cap-site-row-card {
  border: 0;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 58%, transparent);
  border-radius: 0;
  background: transparent;
  overflow: visible;
  transform-origin: top left;
  will-change: transform;
}
.cap-site-row-card:last-child { border-bottom-color: transparent; }
.cap-site-row-card:hover { border-bottom-color: color-mix(in srgb, var(--border) 58%, transparent); }
.cap-site-row-card--open {
  border-bottom-color: color-mix(in srgb, var(--accent) 18%, var(--border));
  background: color-mix(in srgb, var(--accent) 4%, transparent);
}
.cap-site-row-card--off { opacity: 0.55; }
.cap-site-grid-expanded { grid-column: 1 / -1; }
.cap-site-row {
  position: relative;
  display: flex; align-items: center; gap: 9px;
  min-width: 0; padding: 9px 8px;
  border: none; border-radius: 0;
  background: transparent;
  cursor: default;
}
.cap-site-row:active { cursor: default; }
.cap-site-row:hover {
  border-radius: 6px;
  background: color-mix(in srgb, var(--bg-tertiary) 48%, transparent);
}
.cap-floating-tooltip {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  box-shadow: none;
  padding: 5px 8px;
  font-size: 12px;
  font-weight: 560;
  line-height: 1.2;
  white-space: nowrap;
}
.cap-site-row-icon {
  width: 34px; height: 34px; border-radius: 8px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--bg-tertiary) 56%, var(--bg-primary));
  border: 0;
}
.cap-site-row-copy { min-width: 0; flex: 1; display: grid; gap: 2px; }
.cap-site-row-title { display: flex; align-items: center; gap: 6px; min-width: 0; }
.cap-site-row-badge {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--accent) 34%, var(--border));
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  color: var(--text-secondary);
  font-size: 10px;
  font-weight: 650;
  line-height: 1.5;
  white-space: nowrap;
}
.cap-site-row-copy h3 {
  margin: 0; font-size: 13px; font-weight: 800; color: var(--text-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cap-site-row-copy p {
  margin: 0; font-size: 11px; line-height: 1.35; color: var(--text-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cap-site-row-detail {
  border-top: 1px solid var(--border);
  padding: 7px 8px 8px;
  background: var(--bg-primary);
}
.cap-scenario-list--row-detail {
  padding: 0;
  grid-template-columns: 1fr;
}

.cap-site-mini-grid {
  display: flex; flex-direction: column; gap: 6px;
}
.cap-site-mini-row {
  display: grid; grid-template-columns: repeat(var(--cap-row-columns), minmax(0, 1fr)); gap: 6px;
}
.cap-site-mini {
  position: relative;
  min-width: 0; min-height: 54px; padding: 6px 4px;
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg-secondary);
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
  cursor: default;
  transform-origin: top left;
  will-change: transform;
}
.cap-site-mini:active { cursor: default; }
.cap-site-mini:hover { border-color: var(--border); background: var(--bg-hover); }
.cap-site-mini--off { opacity: 0.55; }
.cap-site-mini span {
  width: 100%; min-width: 0;
  text-align: center; font-size: 10.5px; font-weight: 700; color: var(--text-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* 「路由直达」角标：网格视图放不下文字徽标，用一个小圆点保留同一信息。
   选择器要比上面那条 cap-site-mini span 更具体，否则会被它的 width:100% 撑满整格。 */
.cap-site-mini span.cap-site-mini-badge {
  position: absolute; top: 5px; right: 5px;
  width: 5px; height: 5px; min-width: 0;
  border-radius: 50%;
  background: var(--accent);
  opacity: 0.85;
}

.cap-scenario-list {
  position: relative; padding: 0 8px 6px; display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 4px;
}
.cap-scenario {
  display: flex; align-items: flex-start; gap: 6px; padding: 5px 6px; border-radius: 6px;
  background: var(--bg-primary); border: 1px solid transparent;
  width: 100%; text-align: left; font: inherit; color: inherit;
  min-height: 34px;
}
.cap-scenario--clickable { cursor: pointer; transition: background 0.15s, border-color 0.15s; }
.cap-scenario--clickable:hover {
  background: var(--bg-hover);
  border-color: transparent;
}
.cap-scenario--clickable:active { background: var(--bg-active); }
.cap-scenario--compact { padding: 5px 6px; }
.cap-scenario-num {
  width: 18px; height: 18px; border-radius: 5px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 10px; font-weight: 800; color: var(--accent);
  background: var(--bg-secondary); border: 1px solid var(--border);
  margin-top: 1px;
}
.cap-scenario-body { min-width: 0; flex: 1; }
.cap-scenario-line {
  min-width: 0; display: flex; align-items: baseline; gap: 6px;
}
.cap-scenario-title {
  flex-shrink: 0; max-width: 42%;
  font-size: 12px; font-weight: 700; color: var(--text-primary); line-height: 1.35;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cap-scenario-summary {
  min-width: 0; font-size: 10.5px; color: var(--text-secondary); line-height: 1.35;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.cap-flow {
  display: flex; flex-wrap: wrap; align-items: center; gap: 3px; margin-top: 6px;
}
.cap-flow-step { display: inline-flex; align-items: center; gap: 4px; }
.cap-flow-arrow { color: var(--text-muted); font-size: 10px; }
.cap-flow-label {
  font-size: 10px; padding: 2px 6px; border-radius: 999px;
  background: var(--bg-primary); border: 1px solid var(--border); color: var(--text-secondary);
}

.cap-prompt-stack {
  display: grid; gap: 6px; margin-top: 6px;
}
.cap-prompt-bubble {
  padding: 6px 8px; border-radius: 7px;
  background: var(--bg-secondary); border: 1px solid var(--border);
}
.cap-prompt-label { font-size: 10px; color: var(--text-muted); display: block; margin-bottom: 4px; }
.cap-prompt-bubble p { margin: 0; font-size: 11px; line-height: 1.5; color: var(--text-primary); white-space: pre-wrap; }

.cap-empty { text-align: center; padding: 24px; color: var(--text-muted); font-size: 13px; }

.cap-root--dock .cap-toolbar { flex-direction: column; }
`
