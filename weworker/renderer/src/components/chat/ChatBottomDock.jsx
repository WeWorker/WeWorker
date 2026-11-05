import React, { useLayoutEffect, useRef } from 'react'
import InputBar from './InputBar.jsx'

export default function ChatBottomDock({ showInput = true, ...inputProps }) {
  const dockRef = useRef(null)
  useLayoutEffect(() => {
    const dock = dockRef.current
    const view = dock?.closest('.chat-view')
    if (!dock || !view) return
    const measure = () => view.style.setProperty('--chat-dock-height', (dock.getBoundingClientRect().height + 16) + 'px')
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(dock)
    return () => { observer.disconnect(); view.style.removeProperty('--chat-dock-height') }
  }, [showInput])
  if (!showInput) return null

  return (
    <div
      data-chat-bottom-dock
      ref={dockRef}
      style={{
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 30,
      borderTop: 'none',
      background: 'linear-gradient(to bottom, transparent 0, var(--bg-secondary) 42px, var(--bg-secondary) 100%)',
      pointerEvents: 'none',
    }}>
      <InputBar key={inputProps.attachmentTarget || 'welcome'} {...inputProps} />
    </div>
  )
}
