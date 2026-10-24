import React from 'react'
import Tooltip from '../Tooltip.jsx'
import { useCapabilitiesPanelStore } from '../../store/capabilities-panel.js'
import { useUserFilesStore } from '../../store/user-files.js'
import { useTerminalStore } from '../../store/terminal.js'

/** Toggle 场景总览侧边面板（标题栏右侧） */
export default function CapabilitiesToggleButton({ variant = 'default' }) {
  const open = useCapabilitiesPanelStore((s) => s.open)
  const toggle = useCapabilitiesPanelStore((s) => s.toggle)
  const isTitlebar = variant === 'titlebar'

  const handleToggle = () => {
    useUserFilesStore.getState().closePanel()
    useTerminalStore.getState().closePanel()
    toggle()
  }

  return (
    <Tooltip text={open ? '收起场景总览' : '查看支持的应用场景'}>
      <button
        type="button"
        onClick={handleToggle}
        aria-label={open ? '收起场景总览' : '打开场景总览'}
        aria-pressed={open}
        className={isTitlebar ? `workspace-toolbar__button${open ? ' is-active' : ''}` : undefined}
        style={isTitlebar ? undefined : {
          width: isTitlebar ? 28 : 28,
          height: isTitlebar ? 28 : 28,
          borderRadius: isTitlebar ? 4 : 8,
          border: isTitlebar ? 'none' : `1px solid ${open ? 'var(--accent)' : 'var(--border)'}`,
          background: open
            ? (isTitlebar ? 'var(--bg-hover)' : 'rgba(99, 102, 241, 0.14)')
            : (isTitlebar ? 'none' : 'var(--bg-secondary)'),
          color: open ? 'var(--accent)' : 'var(--text-secondary)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
          flexShrink: 0,
          transition: 'background 0.15s, border-color 0.15s, color 0.15s',
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
        </svg>
      </button>
    </Tooltip>
  )
}
