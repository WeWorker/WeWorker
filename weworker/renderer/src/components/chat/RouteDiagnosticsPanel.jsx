import React, { useEffect, useState } from 'react'
import { backendFetch } from '../../api/http.js'
import RouteTurnDetails from './RouteTurnDetails.jsx'

/** Work-level panel: message rows do not carry durable turn IDs, so never guess their association. */
export default function RouteDiagnosticsPanel({ workId, streaming }) {
  const [projection, setProjection] = useState(null)
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    setProjection(null)
    setExpanded(false)
  }, [workId])
  useEffect(() => {
    if (!workId || streaming) return undefined
    let active = true
    backendFetch(`/works/${encodeURIComponent(workId)}/route-diagnostics`)
      .then(response => response.ok ? response.json() : null)
      .then(data => { if (active) setProjection(data) })
      .catch(() => { if (active) setProjection(null) })
    return () => { active = false }
  }, [workId, streaming])
  const turns = Array.isArray(projection?.turns) ? projection.turns : []
  if (!turns.length) return null
  const latest = turns.at(-1)
  return <section aria-label="快速路由诊断" style={{ margin: '4px 24px 12px', padding: '8px 12px', background: 'var(--bg-secondary)', borderRadius: 8, border: '1px solid var(--border)' }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)' }}>
      <span>最近路由记录 · {turns.length} 轮{projection.incomplete ? ' · 记录可能不完整' : ''}</span>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)} style={{ border: 0, background: 'none', color: 'var(--text-secondary)', cursor: 'pointer', font: 'inherit' }}>
        {expanded ? '收起历史' : '查看历史'}
      </button>
    </div>
    {expanded ? turns.slice().reverse().map(turn => <div key={turn.turnId} style={{ borderTop: '1px solid var(--border)', paddingTop: 5, marginTop: 5 }}>
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>路由回合 {turn.turnId.slice(0, 8)} · {turn.startedAt}</span>
      <RouteTurnDetails turn={turn} incomplete={projection.incomplete} />
    </div>) : <RouteTurnDetails turn={latest} incomplete={projection.incomplete} />}
  </section>
}
