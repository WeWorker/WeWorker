import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useCapabilitiesPanelStore } from '../../store/capabilities-panel.js'
import CapabilitiesSidePanel from '../capabilities/CapabilitiesSidePanel.jsx'
import UserFilesSidePanel from '../files/UserFilesSidePanel.jsx'
import { useUserFilesStore } from '../../store/user-files.js'
import { useTerminalStore } from '../../store/terminal.js'
import WeWorkerPowerShellPanel from '../terminal/WeWorkerPowerShellPanel.jsx'

const RIGHT_PANEL_MIN = 300
const RIGHT_PANEL_MAX = 720
const RIGHT_PANEL_DEFAULT = 420
const WORKSPACE_CANVAS_MIN_WIDTH = 420
const RIGHT_PANEL_TRANSITION_MS = 220
const RIGHT_PANEL_CONTENT_SWAP_MS = 160
const RIGHT_PANEL_CONTENT_ENTER_DELAY_MS = 70

const clampRightPanelWidth = (width) => (
  Math.min(RIGHT_PANEL_MAX, Math.max(RIGHT_PANEL_MIN, Number(width) || RIGHT_PANEL_DEFAULT))
)

export default function MainWorkspaceShell({ children }) {
  const capabilitiesOpen = useCapabilitiesPanelStore((s) => s.open)
  const userFilesOpen = useUserFilesStore((s) => s.open)
  const terminalOpen = useTerminalStore((s) => s.open)
  const terminalMaximized = useTerminalStore((s) => s.maximized)
  const [rightPanelWidth, setRightPanelWidth] = useState(() => {
    const saved = Number(localStorage.getItem('right_panel_width'))
    return Number.isFinite(saved) && saved > 0 ? clampRightPanelWidth(saved) : RIGHT_PANEL_DEFAULT
  })
  const [rightPanelResizing, setRightPanelResizing] = useState(false)
  const resizingRef = useRef(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)
  const activePanel = terminalOpen ? 'terminal' : userFilesOpen ? 'files' : (capabilitiesOpen ? 'capabilities' : null)
  const [mountedPanel, setMountedPanel] = useState(activePanel)
  const mountedPanelRef = useRef(activePanel)
  const [shellVisible, setShellVisible] = useState(Boolean(activePanel))
  const [contentVisible, setContentVisible] = useState(Boolean(activePanel))
  const panelMounted = Boolean(mountedPanel)
  const frameRef = useRef(null)
  const [workspaceWidth, setWorkspaceWidth] = useState(() => window.innerWidth)
  const compactPanel = workspaceWidth < RIGHT_PANEL_MIN + 5 + WORKSPACE_CANVAS_MIN_WIDTH
  const fullWidthPanel = compactPanel || (terminalMaximized && mountedPanel === 'terminal')
  const canResizePanel = shellVisible && !fullWidthPanel
  const visibleRightPanelWidth = Math.min(
    rightPanelWidth,
    Math.max(RIGHT_PANEL_MIN, workspaceWidth - 5 - WORKSPACE_CANVAS_MIN_WIDTH),
  )

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return undefined
    const update = () => setWorkspaceWidth(frame.clientWidth)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(frame)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let enterFrame = 0
    let settleFrame = 0
    let contentTimer = 0
    let unmountTimer = 0
    const setMounted = (next) => {
      mountedPanelRef.current = next
      setMountedPanel(next)
    }
    const showContentAfterShellStarts = () => {
      contentTimer = window.setTimeout(() => setContentVisible(true), RIGHT_PANEL_CONTENT_ENTER_DELAY_MS)
    }
    const startShellEnter = () => {
      enterFrame = window.requestAnimationFrame(() => {
        settleFrame = window.requestAnimationFrame(() => {
          setShellVisible(true)
          showContentAfterShellStarts()
        })
      })
    }

    if (activePanel) {
      const currentMountedPanel = mountedPanelRef.current
      if (!currentMountedPanel) {
        setMounted(activePanel)
        setShellVisible(false)
        setContentVisible(false)
        startShellEnter()
        return () => {
          window.cancelAnimationFrame(enterFrame)
          window.cancelAnimationFrame(settleFrame)
          window.clearTimeout(contentTimer)
        }
      }
      if (currentMountedPanel !== activePanel) {
        setContentVisible(false)
        setShellVisible(true)
        contentTimer = window.setTimeout(() => {
          setMounted(activePanel)
          showContentAfterShellStarts()
        }, RIGHT_PANEL_CONTENT_SWAP_MS)
        return () => {
          window.clearTimeout(contentTimer)
        }
      }
      setShellVisible(true)
      showContentAfterShellStarts()
      return () => {
        window.clearTimeout(contentTimer)
      }
    }

    if (!mountedPanelRef.current) return undefined
    setContentVisible(false)
    setShellVisible(false)
    unmountTimer = window.setTimeout(() => setMounted(null), RIGHT_PANEL_TRANSITION_MS)
    return () => window.clearTimeout(unmountTimer)
  }, [activePanel])

  const onResizeStart = useCallback((e) => {
    e.preventDefault()
    resizingRef.current = true
    setRightPanelResizing(true)
    startXRef.current = e.clientX
    startWidthRef.current = rightPanelWidth
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const onMove = (ev) => {
      if (!resizingRef.current) return
      const delta = startXRef.current - ev.clientX
      setRightPanelWidth(clampRightPanelWidth(startWidthRef.current + delta))
    }

    const onUp = () => {
      resizingRef.current = false
      setRightPanelResizing(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      setRightPanelWidth((width) => {
        localStorage.setItem('right_panel_width', String(width))
        return width
      })
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [rightPanelWidth])

  return (
    <div ref={frameRef} className="workspace-frame" style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'row',
      overflow: 'hidden',
      minWidth: 0,
      minHeight: 0,
    }}>
      <div className="workspace-canvas" style={{
        flex: terminalMaximized && mountedPanel === 'terminal' ? '0 0 0' : 1,
        display: fullWidthPanel && panelMounted ? 'none' : 'flex',
        flexDirection: 'column',
        position: 'relative',
        overflow: 'hidden',
        minWidth: 0,
        minHeight: 0,
        opacity: terminalMaximized && mountedPanel === 'terminal' ? 0 : 1,
        pointerEvents: terminalMaximized && mountedPanel === 'terminal' ? 'none' : 'auto',
      }}>
        {terminalMaximized && mountedPanel === 'terminal' ? null : children}
      </div>
      {panelMounted && (
        <div
          className="workspace-side-panel"
          data-full-width={fullWidthPanel ? 'true' : 'false'}
          style={{
            width: fullWidthPanel ? '100%' : (shellVisible ? visibleRightPanelWidth + 5 : 0),
            flexBasis: fullWidthPanel ? '100%' : (shellVisible ? visibleRightPanelWidth + 5 : 0),
            flexShrink: 0,
            flexGrow: fullWidthPanel ? 1 : 0,
            overflow: 'hidden',
            display: 'flex',
            minHeight: 0,
            transition: rightPanelResizing || fullWidthPanel
              ? 'none'
              : `width ${RIGHT_PANEL_TRANSITION_MS}ms ease, flex-basis ${RIGHT_PANEL_TRANSITION_MS}ms ease`,
            willChange: 'width, flex-basis',
          }}
        >
          <div
            onMouseDown={canResizePanel ? onResizeStart : undefined}
            style={{
              width: canResizePanel ? 5 : 0,
              cursor: canResizePanel ? 'col-resize' : 'default',
              flexShrink: 0,
              background: 'transparent',
              position: 'relative',
              zIndex: 1400,
              marginLeft: canResizePanel ? -2 : 0,
              marginRight: canResizePanel ? -3 : 0,
              opacity: canResizePanel ? 1 : 0,
              transition: `opacity ${RIGHT_PANEL_TRANSITION_MS}ms ease`,
            }}
            onMouseEnter={(e) => { if (canResizePanel) e.currentTarget.style.background = 'var(--accent)' }}
            onMouseLeave={(e) => { if (!resizingRef.current) e.currentTarget.style.background = 'transparent' }}
          />
          <div
            style={{
              width: fullWidthPanel ? '100%' : visibleRightPanelWidth,
              flex: fullWidthPanel ? '1 1 auto' : '0 0 auto',
              flexShrink: 0,
              minHeight: 0,
              transform: contentVisible ? 'translateX(0)' : 'translateX(18px)',
              opacity: contentVisible ? 1 : 0,
              transition: `transform ${RIGHT_PANEL_TRANSITION_MS}ms ease, opacity ${RIGHT_PANEL_TRANSITION_MS}ms ease`,
            }}
          >
            {mountedPanel === 'files' && <UserFilesSidePanel width={fullWidthPanel ? '100%' : visibleRightPanelWidth} />}
            {mountedPanel === 'capabilities' && <CapabilitiesSidePanel width={fullWidthPanel ? '100%' : visibleRightPanelWidth} />}
            {mountedPanel === 'terminal' && <WeWorkerPowerShellPanel width={fullWidthPanel ? '100%' : visibleRightPanelWidth} />}
          </div>
        </div>
      )}
    </div>
  )
}
