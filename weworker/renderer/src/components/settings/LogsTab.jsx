import React, { useState, useEffect, useRef } from 'react'
import { backendFetch } from '../../api/http.js'

// Parse a log line into structured fields
// New format: "2026-04-03 15:50:48.564 [source] [LEVEL] message"
// Electron format: "2026-04-03 00:13:32.482 [source] [tag] message" or "2026-04-03 00:13:32.482 [source] message"
// Legacy ISO format: "2026-04-03T15:50:48.564Z [source] message"
const KNOWN_LEVELS = new Set(['info', 'warn', 'error', 'debug'])

function parseLine(line) {
  // Match: "YYYY-MM-DD HH:MM:SS.mmm [source] ..."
  const m = line.match(/^(\d{4}-\d{2}-\d{2} [\d:.]+)\s+\[(\w[\w-]*)\]\s*(.*)$/)
  if (m) {
    const time = m[1]
    const source = m[2]
    let rest = m[3]
    let level = 'info'
    let tag = ''
    // Check if next bracket is a level or a tag
    const bracketMatch = rest.match(/^\[(\w+)\]\s*(.*)$/)
    if (bracketMatch) {
      if (KNOWN_LEVELS.has(bracketMatch[1].toLowerCase())) {
        level = bracketMatch[1].toLowerCase()
        rest = bracketMatch[2]
        // Check for another tag bracket
        const tagMatch = rest.match(/^\[([^\]]+)\]\s*(.*)$/)
        if (tagMatch) { tag = tagMatch[1]; rest = tagMatch[2] }
      } else {
        tag = bracketMatch[1]
        rest = bracketMatch[2]
      }
    }
    // Auto-detect level from content if not explicitly set
    if (level === 'info') {
      const lower = rest.toLowerCase()
      if (lower.includes('error') || lower.includes('failed') || lower.includes('exception')) level = 'error'
      else if (lower.includes('warn')) level = 'warn'
    }
    return { time, source, level, tag, message: rest }
  }
  // Legacy ISO format: "2026-04-03T15:50:48.564Z [source] ..."
  const legacy = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+\[(\w+)\]\s*(.*)$/)
  if (legacy) {
    const time = legacy[1].replace('T', ' ').replace('Z', '')
    const source = legacy[2]
    let rest = legacy[3]
    let tag = ''
    const tagMatch = rest.match(/^\[([^\]]+)\]\s*(.*)$/)
    if (tagMatch) { tag = tagMatch[1]; rest = tagMatch[2] }
    const lower = rest.toLowerCase()
    let level = 'info'
    if (lower.includes('error') || lower.includes('failed') || lower.includes('exception')) level = 'error'
    else if (lower.includes('warn')) level = 'warn'
    return { time, source, tag, message: rest, level }
  }
  return { raw: line }
}

// Color palette — desaturated tones, subtle color hints for each role
// Uses CSS variables for theme-adaptive base colors, fixed colors only for level accents
const TIME_COLOR = 'var(--text-muted)'
const SOURCE_COLOR = 'var(--text-secondary)'
const TAG_COLOR = 'var(--text-muted)'
const MSG_COLOR = 'var(--text-primary)'
const ERROR_COLOR = '#ef4444'
const WARN_COLOR = '#d97706'

const LEVEL_COLORS = {
  error: '#ef4444',
  warn: '#d97706',
  info: '#339CFF',
  debug: '#8b5cf6',
}

function LogLine({ parsed, index }) {
  if (parsed.raw !== undefined) {
    return <div style={{ color: 'var(--text-muted)', padding: '2px 0', borderBottom: '1px solid rgba(128,128,128,0.06)' }}>{parsed.raw}</div>
  }
  const { time, source, tag, message, level } = parsed
  const levelColor = LEVEL_COLORS[level] || LEVEL_COLORS.info
  const msgColor = level === 'error' ? ERROR_COLOR : level === 'warn' ? WARN_COLOR : MSG_COLOR
  const displayTime = time ? time.slice(0, 19) : ''
  return (
    <div style={{ padding: '2px 0', borderBottom: '1px solid rgba(128,128,128,0.06)' }}>
      <span style={{ color: TIME_COLOR, fontSize: 10 }}>{displayTime} </span>
      <span style={{ color: SOURCE_COLOR, fontSize: 10 }}>[{source}] </span>
      <span style={{ color: levelColor, fontSize: 10 }}>{level.toUpperCase()} </span>
      {tag && <span style={{ color: TAG_COLOR, fontSize: 10 }}>[{tag}] </span>}
      <span style={{ color: msgColor }}>{message}</span>
    </div>
  )
}

export default function LogsTab() {
  const [lines, setLines] = useState([])
  const [logPath, setLogPath] = useState('')
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState(false)
  const containerRef = useRef(null)

  const loadLogs = async () => {
    setLoading(true)
    try {
      const res = await backendFetch('/logs?lines=500')
      const data = await res.json()
      setLines(data.lines || [])
      setLogPath(data.path || '')
      setTotal(data.total || 0)
    } catch (e) {
      setLines([`Failed to load logs: ${e.message}`])
    }
    setLoading(false)
  }

  useEffect(() => { loadLogs() }, [])

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [lines])

  const filtered = filter
    ? lines.filter(l => l.toLowerCase().includes(filter.toLowerCase()))
    : lines

  const parsed = filtered.map(parseLine)

  const handleCopy = () => {
    navigator.clipboard.writeText(filtered.join('\n'))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const content = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: expanded ? '100%' : 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="过滤日志... (如 error, chat, bridge)"
          style={{
            flex: 1, background: 'var(--bg-primary)', border: '1px solid var(--border)',
            borderRadius: 6, padding: '5px 10px', fontSize: 12, color: 'var(--text-primary)',
            outline: 'none', fontFamily: 'inherit',
          }}
        />
        <button data-app-button="action" onClick={loadLogs} disabled={loading} style={{
          background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 6,
          padding: '5px 12px', fontSize: 12, cursor: 'pointer', color: 'var(--text-secondary)',
          fontFamily: 'inherit',
        }}>
          {loading ? '...' : '刷新'}
        </button>
        <button data-app-button="action" onClick={handleCopy} style={{
          background: copied ? 'rgba(34,197,94,0.15)' : 'var(--bg-tertiary)',
          border: `1px solid ${copied ? 'rgba(34,197,94,0.4)' : 'var(--border)'}`,
          borderRadius: 6, padding: '5px 12px', fontSize: 12, cursor: 'pointer',
          color: copied ? '#22c55e' : 'var(--text-secondary)', fontFamily: 'inherit',
        }}>
          {copied ? '✓ 已复制' : '复制全部'}
        </button>
        <button onClick={() => setExpanded(v => !v)} title={expanded ? '退出全屏' : '全屏查看'} style={{
          background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 6,
          padding: '5px 8px', fontSize: 12, cursor: 'pointer', color: 'var(--text-secondary)',
          fontFamily: 'inherit', display: 'flex', alignItems: 'center',
        }}>
          {expanded ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" />
              <line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          )}
        </button>
      </div>

      <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', gap: 12 }}>
        <span>共 {total} 行，显示 {filtered.length} 行</span>
        {logPath && <span style={{ opacity: 0.6 }}>{logPath}</span>}
      </div>

      <div
        ref={containerRef}
        style={{
          background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 8,
          padding: 10, maxHeight: expanded ? undefined : 360, flex: expanded ? 1 : undefined,
          overflowY: 'auto', fontFamily: 'monospace',
          fontSize: 11, lineHeight: 1.6,
          whiteSpace: 'pre-wrap', wordBreak: 'break-all',
        }}
      >
        {parsed.length === 0 ? (
          <span style={{ color: 'var(--text-muted)' }}>暂无日志</span>
        ) : (
          parsed.map((p, i) => <LogLine key={i} parsed={p} index={i} />)
        )}
      </div>
    </div>
  )

  if (expanded) {
    return (
      <div onClick={(e) => e.stopPropagation()} style={{
        position: 'fixed', inset: 0, zIndex: 2000,
        background: 'var(--bg-secondary)',
        paddingTop: 50, paddingLeft: 20, paddingRight: 20, paddingBottom: 20,
        display: 'flex', flexDirection: 'column',
        WebkitAppRegion: 'no-drag',
      }}>
        {content}
      </div>
    )
  }

  return content
}
