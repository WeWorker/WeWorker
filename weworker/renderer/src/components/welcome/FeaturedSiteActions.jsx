import React, { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ClosePanelIcon, EyeIcon, TrialChatIcon } from './WelcomeIcons.jsx'
import SiteSkillsScenariosAction from './SiteSkillsScenariosAction.jsx'
import {
  actionVisibilityStyle,
  canShowFeaturedColumnActions,
  computeAdaptiveHiddenActionKeys,
  FEATURED_COLUMN_ACTION_GAP,
  FEATURED_COLUMN_ACTION_INSET,
  FEATURED_COLUMN_COMPACT_BUTTON_SIZE,
  setsEqual,
} from '../../utils/featured-site-actions-utils.js'

function useAdaptiveFeaturedActions(enabled, layout, gridLayoutEpoch, forceVisibleKeys) {
  const stackRef = useRef(null)
  const [hiddenActionKeys, setHiddenActionKeys] = useState(() => new Set())
  const [allActionsFit, setAllActionsFit] = useState(true)

  useLayoutEffect(() => {
    if (!enabled) {
      setHiddenActionKeys((current) => (current.size === 0 ? current : new Set()))
      setAllActionsFit(true)
      return undefined
    }

    const stack = stackRef.current
    const card = stack?.closest('[data-featured-site-item]') || stack?.parentElement
    if (!stack || !card) return undefined

    const measure = () => {
      if (layout === 'column') {
        const fits = canShowFeaturedColumnActions(card)
        setHiddenActionKeys((current) => (current.size === 0 ? current : new Set()))
        setAllActionsFit((current) => (current === fits ? current : fits))
        return
      }

      const nextHidden = computeAdaptiveHiddenActionKeys(card, stack, layout, forceVisibleKeys)
      setHiddenActionKeys((current) => (setsEqual(current, nextHidden) ? current : nextHidden))
      setAllActionsFit(true)
    }

    measure()
    const raf = window.requestAnimationFrame(measure)
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    observer?.observe(card)

    return () => {
      window.cancelAnimationFrame(raf)
      observer?.disconnect()
    }
  }, [enabled, layout, forceVisibleKeys, gridLayoutEpoch])

  return { stackRef, hiddenActionKeys, allActionsFit }
}

export default function FeaturedSiteActions({
  site,
  scenarios,
  layout = 'row',
  compact = false,
  isHovered,
  isPicking,
  hoveredFeaturedAction,
  setHoveredFeaturedAction,
  skillsScenariosPickerSiteId,
  toggleSkillsScenariosPicker,
  handleOpenSiteSkillsOrScenarios,
  openSiteDetail,
  removeFeaturedSite,
  openScenarioPicker,
  showActions = true,
  gridLayoutEpoch = 0,
}) {
  const detailActionKey = `${site.id}:detail`
  const removeActionKey = `${site.id}:remove`
  const tryActionKey = `${site.id}:try`
  const toolPackageActionKey = `${site.id}:tool-package`
  const iconSize = compact ? 13 : 18
  const actionStyle = compact ? featuredCardActionStyle : featuredActionStyle
  const removeFontSize = compact ? 14 : 17
  const tooltipClassName = layout === 'column'
    ? 'weworker-action-tooltip weworker-action-tooltip--bottom-right'
    : 'weworker-action-tooltip weworker-action-tooltip--above'
  const forceVisibleKeys = useMemo(() => (
    skillsScenariosPickerSiteId === site.id
      ? new Set([toolPackageActionKey])
      : new Set()
  ), [skillsScenariosPickerSiteId, site.id, toolPackageActionKey])
  const adaptiveEnabled = showActions && (layout === 'row' || layout === 'column')
  const { stackRef, hiddenActionKeys, allActionsFit } = useAdaptiveFeaturedActions(
    adaptiveEnabled,
    layout,
    gridLayoutEpoch,
    forceVisibleKeys,
  )
  const effectiveShowActions = layout === 'column'
    ? showActions && allActionsFit
    : showActions

  // Compact website chips only need a remove affordance, independent of card height.
  if (layout === 'chip') {
    return <button
      type="button"
      className="featured-site-remove"
      aria-label={`从常用网站移除 ${site.name}`}
      title="从常用网站移除"
      data-remove-action
      data-featured-action
      onClick={(event) => {
        event.stopPropagation()
        removeFeaturedSite(site.id)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          event.stopPropagation()
          removeFeaturedSite(site.id)
        }
      }}
    ><ClosePanelIcon size={16} /></button>
  }

  const bindHover = (actionKey) => ({
    onMouseEnter: () => setHoveredFeaturedAction(actionKey),
    onMouseLeave: (e) => {
      if (layout === 'column') {
        setHoveredFeaturedAction((current) => (current === actionKey ? null : current))
        return
      }
      if (e.currentTarget.parentElement?.contains(e.relatedTarget)) return
      setHoveredFeaturedAction((current) => (current === actionKey ? null : current))
    },
    onFocus: () => setHoveredFeaturedAction(actionKey),
    onBlur: () => setHoveredFeaturedAction((current) => (current === actionKey ? null : current)),
  })

  const stackStyle = layout === 'column'
    ? {
      ...featuredCardActionsColumnStyle,
      opacity: effectiveShowActions ? 1 : 0,
      transform: effectiveShowActions ? 'translateX(0)' : 'translateX(6px)',
      transition: 'opacity 0.15s ease, transform 0.15s ease',
      pointerEvents: effectiveShowActions ? 'auto' : 'none',
    }
    : {
      ...featuredActionsRowStyle,
      opacity: effectiveShowActions ? 1 : 0,
      transform: effectiveShowActions ? 'translateX(0)' : 'translateX(8px)',
      transition: 'opacity 0.15s ease, transform 0.15s ease',
      pointerEvents: effectiveShowActions ? 'auto' : 'none',
      ...(effectiveShowActions ? null : { width: 0, minWidth: 0, overflow: 'hidden', gap: 0 }),
    }

  return (
    <div ref={stackRef} style={stackStyle} data-featured-action>
      <button
        type="button"
        aria-label={`从常用场景移除 ${site.name}`}
        data-featured-action-key={removeActionKey}
        {...bindHover(removeActionKey)}
        onClick={(e) => {
          e.stopPropagation()
          removeFeaturedSite(site.id)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            e.stopPropagation()
            removeFeaturedSite(site.id)
          }
        }}
        style={{
          ...actionStyle,
          color: isHovered || isPicking ? 'var(--text-secondary)' : 'var(--text-muted)',
          fontSize: removeFontSize,
          ...actionVisibilityStyle(removeActionKey, hiddenActionKeys, forceVisibleKeys),
        }}
        data-remove-action
        data-featured-action
      >
        {hoveredFeaturedAction === removeActionKey && (
          <span className={tooltipClassName}>移除</span>
        )}
        <span aria-hidden style={removeGlyphStyle}>×</span>
      </button>
      <button
        type="button"
        aria-label={`查看 ${site.name} 详情`}
        data-featured-action-key={detailActionKey}
        {...bindHover(detailActionKey)}
        onClick={(e) => {
          e.stopPropagation()
          openSiteDetail(site, scenarios)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            e.stopPropagation()
            openSiteDetail(site, scenarios)
          }
        }}
        style={{
          ...actionStyle,
          color: isHovered || isPicking ? 'var(--text-secondary)' : 'var(--text-primary)',
          ...actionVisibilityStyle(detailActionKey, hiddenActionKeys, forceVisibleKeys),
        }}
        data-featured-action
      >
        {hoveredFeaturedAction === detailActionKey && (
          <span className={tooltipClassName}>查看详情</span>
        )}
        <EyeIcon size={iconSize} />
      </button>
      <SiteSkillsScenariosAction
        site={site}
        dataFeaturedAction
        featuredActionKey={toolPackageActionKey}
        menuOpen={skillsScenariosPickerSiteId === site.id}
        onToggleMenu={() => toggleSkillsScenariosPicker(site.id)}
        onSelect={handleOpenSiteSkillsOrScenarios}
        showTooltip={hoveredFeaturedAction === toolPackageActionKey}
        tooltipClassName={tooltipClassName}
        {...bindHover(toolPackageActionKey)}
        buttonStyle={{
          ...actionStyle,
          color: isHovered || isPicking ? 'var(--text-secondary)' : 'var(--text-primary)',
          opacity: layout === 'column' || isHovered || hoveredFeaturedAction === toolPackageActionKey || skillsScenariosPickerSiteId === site.id ? 1 : undefined,
        }}
        wrapperStyle={actionVisibilityStyle(toolPackageActionKey, hiddenActionKeys, forceVisibleKeys)}
        iconSize={iconSize}
      />
      <button
        data-welcome-picker
        data-featured-action
        data-featured-action-key={tryActionKey}
        type="button"
        {...bindHover(tryActionKey)}
        aria-label={`在对话中试用 ${site.name}`}
        onClick={(e) => {
          e.stopPropagation()
          openScenarioPicker(site.id)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            e.stopPropagation()
            openScenarioPicker(site.id)
          }
        }}
        style={{
          ...actionStyle,
          color: isHovered || isPicking ? 'var(--text-secondary)' : 'var(--text-primary)',
          ...actionVisibilityStyle(tryActionKey, hiddenActionKeys, forceVisibleKeys),
        }}
      >
        {hoveredFeaturedAction === tryActionKey && (
          <span className={tooltipClassName}>在对话中试用</span>
        )}
        <TrialChatIcon size={iconSize} />
      </button>
    </div>
  )
}

const featuredActionsRowStyle = {
  display: 'flex',
  alignItems: 'center',
  flexShrink: 0,
  marginLeft: 'auto',
  gap: 8,
}

const featuredCardActionsColumnStyle = {
  position: 'absolute',
  top: FEATURED_COLUMN_ACTION_INSET,
  right: FEATURED_COLUMN_ACTION_INSET,
  zIndex: 3,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: FEATURED_COLUMN_ACTION_GAP,
  overflow: 'visible',
}

const featuredActionStyle = {
  position: 'relative',
  width: 28,
  height: 28,
  borderRadius: 9,
  border: 'none',
  background: 'var(--bg-primary)',
  color: 'var(--text-primary)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 22,
  fontFamily: 'inherit',
  lineHeight: 1,
  padding: 0,
  cursor: 'pointer',
  flexShrink: 0,
}

const featuredCardActionStyle = {
  position: 'relative',
  width: FEATURED_COLUMN_COMPACT_BUTTON_SIZE,
  height: FEATURED_COLUMN_COMPACT_BUTTON_SIZE,
  borderRadius: 6,
  border: 'none',
  background: 'var(--bg-secondary)',
  color: 'var(--text-primary)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'inherit',
  lineHeight: 1,
  padding: 0,
  cursor: 'pointer',
  flexShrink: 0,
  boxShadow: 'none',
}

const removeGlyphStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '100%',
  height: '100%',
  lineHeight: 1,
}
