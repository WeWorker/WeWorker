import { useState, useEffect } from 'react'
import { useWorksStore } from '../../store/works.js'
import { displayToolName } from '../../utils/tool-name.js'
import { backendFetch } from '../../api/http.js'
const STATUS_ICON = { pass: '✅', fail: '❌', uncovered: '⚪' }

function formatTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default function HealthCheck({ onClose }) {
  const [testPrompts, setTestPrompts] = useState([])
  const [lastResult, setLastResult] = useState(null)
  const [expanded, setExpanded] = useState(false)
  const [expandedSite, setExpandedSite] = useState(null)

  const loadResults = () => {
    backendFetch('/health-check/test-prompts').then(r => r.json()).then(setTestPrompts).catch(() => {})
    backendFetch('/health-check/results').then(r => r.json()).then(d => { if (d) setLastResult(d) }).catch(() => {})
  }

  useEffect(() => { loadResults() }, [])

  // Reload results every time the section is expanded
  useEffect(() => {
    if (expanded) loadResults()
  }, [expanded])

  const runTest = async (tp) => {
    await useWorksStore.getState().startHealthCheck(tp.siteId, tp.siteName, tp.toolNames, tp.prompt)
    onClose?.()
  }

  // Compute summary from last results
  let lastSummary = null
  if (lastResult?.results) {
    let total = 0, passed = 0
    for (const site of Object.values(lastResult.results)) {
      for (const tool of Object.values(site.tools)) {
        total++
        if (tool.status === 'pass') passed++
      }
    }
    lastSummary = { total, passed }
  }

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button
          onClick={() => setExpanded(!expanded)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 12, padding: 0, fontFamily: 'inherit', textDecoration: 'underline', textUnderlineOffset: 2 }}
        >
          {expanded ? '收起' : '检查工具可用性'}
        </button>
      </div>

      {expanded && (
        <div style={{ marginTop: 10, background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
            点击"检查"会创建一个对话，AI 会自动执行测试任务并操作浏览器。
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {(() => {
              // Group test prompts by siteId
              const siteMap = new Map()
              for (const tp of testPrompts) {
                if (!siteMap.has(tp.siteId)) siteMap.set(tp.siteId, { ...tp, prompts: [] })
                siteMap.get(tp.siteId).prompts.push(tp.prompt)
              }
              return [...siteMap.values()].map(site => {
                const siteResult = lastResult?.results?.[site.siteId]
                const tools = siteResult?.tools || {}
                const toolEntries = Object.entries(tools)
                const passed = toolEntries.filter(([, t]) => t.status === 'pass').length
                const failed = toolEntries.filter(([, t]) => t.status === 'fail').length
                const uncovered = toolEntries.filter(([, t]) => t.status === 'uncovered').length
                const isOpen = expandedSite === site.siteId

                return (
                  <div key={site.siteId} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                    <div style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
                      {toolEntries.length > 0 && (
                        <span onClick={() => setExpandedSite(isOpen ? null : site.siteId)} style={{ fontSize: 9, color: 'var(--text-muted)', cursor: 'pointer', transform: isOpen ? 'rotate(90deg)' : 'rotate(0)', display: 'inline-block', transition: 'transform 0.15s' }}>▶</span>
                      )}
                      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', flex: 1 }}>{site.siteName}</span>
                      {toolEntries.length > 0 && (
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {passed > 0 && `${passed}✅ `}{failed > 0 && `${failed}❌ `}{uncovered > 0 && `${uncovered}⚪`}
                        </span>
                      )}
                      {siteResult?.workId && (
                        <span
                          onClick={() => {
                            useWorksStore.getState().selectWork(siteResult.workId)
                            onClose?.()
                          }}
                          title="查看检查对话"
                          style={{ fontSize: 10, color: 'var(--accent)', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2, flexShrink: 0 }}
                        >查看对话</span>
                      )}
                    </div>

                    {/* Individual test prompts with their own check buttons */}
                    <div style={{ borderTop: '1px solid var(--border)', padding: '4px 12px' }}>
                      {site.prompts.map((prompt, pi) => (
                        <div key={pi} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderTop: pi > 0 ? '1px solid var(--border)' : 'none' }}>
                          <span style={{ flex: 1, fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{prompt}</span>
                          <button data-app-button="action"
                            onClick={() => runTest({ siteId: site.siteId, siteName: site.siteName, toolNames: site.toolNames, prompt })}
                            style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 5, padding: '2px 8px', fontSize: 10, cursor: 'pointer', color: 'var(--text-muted)', fontFamily: 'inherit', flexShrink: 0 }}
                          >
                            检查
                          </button>
                        </div>
                      ))}
                    </div>

                  {isOpen && toolEntries.length > 0 && (
                    <div style={{ borderTop: '1px solid var(--border)', padding: '6px 12px' }}>
                      {toolEntries.map(([toolName, result]) => {
                        const short = displayToolName(toolName)
                        return (
                          <div key={toolName} style={{ padding: '3px 0', fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span>{STATUS_ICON[result.status]}</span>
                            <code style={{ fontFamily: 'monospace', color: 'var(--text-primary)' }}>{short}</code>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
              })
            })()}
          </div>
        </div>
      )}
    </div>
  )
}
