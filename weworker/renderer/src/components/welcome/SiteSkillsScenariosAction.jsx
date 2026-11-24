import React, { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ToolPackageIcon } from './WelcomeIcons.jsx'
import { installedAdapterVersion } from '../../api/adapter-updates-api.js'
import {
  WORKSPACE_TAB_SKILLS,
  WORKSPACE_TAB_SCENARIOS,
} from '../../store/tool-package-page.js'

export const SITE_SKILLS_SCENARIOS_TOOLTIP = '打开站点 Skills 与场景'

const MENU_MIN_WIDTH = 148
const MENU_GAP = 8

export default function SiteSkillsScenariosAction({
  site,
  onSelect,
  buttonStyle,
  iconSize = 18,
  tooltipClassName,
  showTooltip = false,
  menuOpen = false,
  onToggleMenu,
  onMouseEnter,
  onMouseLeave,
  onFocus,
  onBlur,
  dataFeaturedAction = false,
  featuredActionKey = '',
  wrapperStyle = null,
  buttonClassName = '',
}) {
  const anchorRef = useRef(null)
  const menuRef = useRef(null)
  const [menuPosition, setMenuPosition] = useState(null)

  useLayoutEffect(() => {
    if (!menuOpen || !anchorRef.current) {
      setMenuPosition(null)
      return undefined
    }

    const syncPosition = () => {
      const anchor = anchorRef.current?.getBoundingClientRect()
      const menu = menuRef.current?.getBoundingClientRect()
      if (!anchor) return
      const menuWidth = Math.max(menu?.width || MENU_MIN_WIDTH, MENU_MIN_WIDTH)
      const menuHeight = menu?.height || 0
      const viewportPadding = 8
      let top = anchor.top - menuHeight - MENU_GAP
      let left = anchor.right - menuWidth

      if (top < viewportPadding) {
        top = anchor.bottom + MENU_GAP
      }
      if (left < viewportPadding) {
        left = viewportPadding
      }
      if (left + menuWidth > window.innerWidth - viewportPadding) {
        left = window.innerWidth - viewportPadding - menuWidth
      }

      setMenuPosition({ top, left, width: menuWidth })
    }

    syncPosition()
    const frame = window.requestAnimationFrame(syncPosition)
    window.addEventListener('resize', syncPosition)
    window.addEventListener('scroll', syncPosition, true)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', syncPosition)
      window.removeEventListener('scroll', syncPosition, true)
    }
  }, [menuOpen])

  return (
    <div
      ref={anchorRef}
      data-welcome-picker
      {...(featuredActionKey ? { 'data-featured-action-key': featuredActionKey } : {})}
      style={{ position: 'relative', flexShrink: 0, ...wrapperStyle }}
    >
      <button
        type="button"
        aria-label={`打开 ${site.name} 站点 Skills 与场景`}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        className={buttonClassName || undefined}
        {...(dataFeaturedAction ? { 'data-featured-action': true } : {})}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onFocus={onFocus}
        onBlur={onBlur}
        onPointerDown={(e) => {
          e.stopPropagation()
        }}
        onClick={(e) => {
          e.stopPropagation()
          onToggleMenu?.()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            e.stopPropagation()
            onToggleMenu?.()
          }
        }}
        style={buttonStyle}
      >
        {showTooltip && !menuOpen && (
          <span className={tooltipClassName}>{SITE_SKILLS_SCENARIOS_TOOLTIP}</span>
        )}
        <ToolPackageIcon size={iconSize} />
      </button>
      {menuOpen && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          data-welcome-picker
          role="menu"
          style={{
            position: 'fixed',
            top: menuPosition?.top ?? -9999,
            left: menuPosition?.left ?? -9999,
            width: menuPosition?.width ?? MENU_MIN_WIDTH,
            minWidth: MENU_MIN_WIDTH,
            zIndex: 1200,
            border: '1px solid var(--border)',
            borderRadius: 10,
            background: 'var(--bg-secondary)',
            boxShadow: 'none',
            padding: '4px 0',
            overflow: 'hidden',
            visibility: menuPosition ? 'visible' : 'hidden',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div role="presentation" style={{ padding: '6px 14px', color: 'var(--text-secondary)', fontSize: 12 }}>
            Adapter 版本 {installedAdapterVersion(site)}
          </div>
          <MenuItem
            label="站点 Skills"
            onClick={() => onSelect(site.id, WORKSPACE_TAB_SKILLS)}
          />
          <MenuItem
            label="站点场景"
            onClick={() => onSelect(site.id, WORKSPACE_TAB_SCENARIOS)}
          />
        </div>,
        document.body,
      )}
    </div>
  )
}

function MenuItem({ label, onClick }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      style={menuItemStyle}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    >
      {label}
    </button>
  )
}

const menuItemStyle = {
  display: 'block',
  width: '100%',
  border: 'none',
  background: 'transparent',
  color: 'var(--text-primary)',
  padding: '9px 14px',
  fontSize: 12,
  fontWeight: 560,
  lineHeight: 1.2,
  textAlign: 'left',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
  fontFamily: 'inherit',
}
