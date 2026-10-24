import AppSwitch from '../common/AppSwitch.jsx'
﻿import React, { useEffect, useState } from 'react'
import { useSitesStore } from '../../store/sites.js'
import { adapterPackageStatus } from '../../utils/adapter-status.js'
import { displayToolName } from '../../utils/tool-name.js'
import { useCapabilitiesPanelStore } from '../../store/capabilities-panel.js'
import SiteIcon from '../icons/SiteIcon.jsx'
import HealthCheck from './HealthCheck.jsx'
import AnimatedCollapse from '../common/AnimatedCollapse.jsx'

const rowActionsStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexShrink: 0,
  paddingLeft: 8,
  marginLeft: 4,
  borderLeft: '1px solid var(--border)',
}

const rowIconBoxStyle = {
  width: 32,
  height: 32,
  borderRadius: 8,
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border)',
  color: 'var(--text-secondary)',
}

export default function SitesTab({ onClose }) {
  const { sites, systemTools, loading, load, toggle, toggleVisibility, togglingIds, toggleError } = useSitesStore()
  const openPanel = useCapabilitiesPanelStore((s) => s.openPanel)
  const [expandedId, setExpandedId] = useState(null)
  const [devMode, setDevMode] = useState(false)

  useEffect(() => { load() }, [])

  useEffect(() => {
    if (!devMode) setExpandedId(null)
  }, [devMode])

  const openCapabilitiesInChat = () => {
    onClose?.()
    openPanel()
  }

  if (loading && sites.length === 0) {
    return <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: 20, textAlign: 'center' }}>加载中...</div>
  }

  if (sites.length === 0) {
    return <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: 20, textAlign: 'center' }}>未找到任何网站适配器</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{
        padding: '8px 10px', borderRadius: 8, background: 'var(--bg-tertiary)',
        border: '1px solid var(--border)', fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)',
      }}
      >
        <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>场景总览</span>
        {' '}在对话区点击标题栏四宫格按钮，右侧查看各网站场景。{' '}
        <button data-app-button="action"
          type="button"
          onClick={openCapabilitiesInChat}
          style={{
            fontSize: 11, fontWeight: 600, color: 'var(--accent)', background: 'none',
            border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline',
            textUnderlineOffset: 2,
          }}
        >
          去打开
        </button>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 4 }}>
        <div style={{ flex: 1, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          启用或禁用网站工具。<svg style={{ verticalAlign: 'middle', margin: '0 2px' }} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg> 控制是否在欢迎页展示。
          {devMode ? ' 点击展开可查看检查任务与底层工具。' : ' 切换「开发者」可展开查看检查任务与底层工具。'}
        </div>
        <button
          type="button"
          onClick={() => setDevMode((v) => !v)}
          style={{
            flexShrink: 0,
            fontSize: 11,
            padding: '4px 10px',
            borderRadius: 6,
            border: `1px solid ${devMode ? 'var(--accent)' : 'var(--border)'}`,
            background: devMode ? 'rgba(99, 102, 241, 0.12)' : 'var(--bg-secondary)',
            color: devMode ? 'var(--accent)' : 'var(--text-muted)',
            cursor: 'pointer',
            fontWeight: 600,
          }}
        >
          {devMode ? '开发者' : '用户'}
        </button>
      </div>
      {sites.map((site) => {
        const isExpanded = expandedId === site.id
        return (
          <div
            key={site.id}
            style={{
              background: 'var(--bg-tertiary)',
              border: `1.5px solid ${site.enabled ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 10,
              transition: 'all 0.15s',
              opacity: site.enabled ? 1 : 0.6,
              overflow: 'hidden',
            }}
          >
            {/* Header row: 左图标 · 中信息 · 右操作 */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 12px',
                userSelect: 'none',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  flexShrink: 0,
                  cursor: devMode ? 'pointer' : 'default',
                }}
                onClick={() => {
                  if (!devMode) return
                  setExpandedId(isExpanded ? null : site.id)
                }}
              >
                {devMode && (
                  <span style={{
                    fontSize: 10,
                    color: 'var(--text-muted)',
                    transition: 'transform 0.15s',
                    transform: isExpanded ? 'rotate(90deg)' : 'none',
                    width: 10,
                    textAlign: 'center',
                  }}
                  >
                    ▶
                  </span>
                )}
                <div style={rowIconBoxStyle} aria-hidden>
                  <SiteIcon site={site} size={18} />
                </div>
              </div>
              <div
                style={{ flex: 1, minWidth: 0, cursor: devMode ? 'pointer' : 'default' }}
                onClick={() => {
                  if (!devMode) return
                  setExpandedId(isExpanded ? null : site.id)
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                  {site.name}
                  <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>
                    {site.toolCount} 个工具
                  </span>
                </div>
                <div style={{
                  fontSize: 11,
                  color: 'var(--text-muted)',
                  marginTop: 2,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                >
                  {site.description}
                </div>
                {site.managed && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>{adapterPackageStatus(site)}</div>}
                {toggleError?.id === site.id && <div role="alert" style={{ fontSize: 11, marginTop: 3 }}>{toggleError.message}</div>}
              </div>
              <div style={rowActionsStyle}>
                <button
                  type="button"
                  onClick={() => toggleVisibility(site.id)}
                  title={site.visible ? '从欢迎页隐藏' : '在欢迎页展示'}
                  disabled={!site.enabled}
                  style={{
                    background: 'none', border: 'none', cursor: site.enabled ? 'pointer' : 'not-allowed',
                    padding: 4, lineHeight: 1, opacity: site.enabled ? 1 : 0.3,
                  }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={site.visible ? 'var(--accent)' : 'var(--text-muted)'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    {site.visible ? (
                      <>
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </>
                    ) : (
                      <>
                        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                        <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                        <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                        <line x1="1" y1="1" x2="23" y2="23" />
                      </>
                    )}
                  </svg>
                </button>
                <AppSwitch
                  onChange={() => toggle(site.id)}
                  disabled={togglingIds.includes(site.id) || (site.managed && !site.enabled && !site.managed.canEnable)}
                  checked={site.enabled}
                  aria-label={'启用 ' + site.name + ' 工具'}
                />
              </div>
            </div>

            {/* Expanded tool list + test prompts (developer only) */}
            <AnimatedCollapse open={devMode && isExpanded} unmountOnExit>
              <div style={{
                borderTop: '1px solid var(--border)',
                padding: '8px 14px 12px',
                display: 'flex', flexDirection: 'column', gap: 8,
              }}>
                {/* Test prompts section */}
                <TestPromptsSection siteId={site.id} testPrompts={site.testPrompts || []} />

                {/* Tools */}
                {site.tools && site.tools.map((t, i) => (
                  <ToolItem key={i} tool={t} siteId={site.id} />
                ))}
              </div>
            </AnimatedCollapse>
          </div>
        )
      })}
      {/* System / built-in tools */}
      {systemTools.length > 0 && (
        <div
          style={{
            background: 'var(--bg-tertiary)',
            border: '1.5px solid var(--border)',
            borderRadius: 10,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 12px',
              userSelect: 'none',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                flexShrink: 0,
                cursor: devMode ? 'pointer' : 'default',
              }}
              onClick={() => {
                if (!devMode) return
                setExpandedId(expandedId === '__system__' ? null : '__system__')
              }}
            >
              {devMode && (
                <span style={{
                  fontSize: 10,
                  color: 'var(--text-muted)',
                  transition: 'transform 0.15s',
                  transform: expandedId === '__system__' ? 'rotate(90deg)' : 'none',
                  width: 10,
                  textAlign: 'center',
                }}
                >
                  ▶
                </span>
              )}
              <div style={rowIconBoxStyle} aria-hidden>
                <SiteIcon site={{ icon: 'globe' }} size={18} />
              </div>
            </div>
            <div
              style={{ flex: 1, minWidth: 0, cursor: devMode ? 'pointer' : 'default' }}
              onClick={() => {
                if (!devMode) return
                setExpandedId(expandedId === '__system__' ? null : '__system__')
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                内置工具
                <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>
                  {systemTools.length} 个工具
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                浏览器控制、文件管理、定时任务等系统级工具
              </div>
            </div>
          </div>
          <AnimatedCollapse open={devMode && expandedId === '__system__'} unmountOnExit>
            <div style={{
              borderTop: '1px solid var(--border)',
              padding: '8px 14px 12px',
              display: 'flex', flexDirection: 'column', gap: 8,
            }}>
              {systemTools.map((t, i) => (
                <ToolItem key={i} tool={t} />
              ))}
            </div>
          </AnimatedCollapse>
        </div>
      )}

      <HealthCheck onClose={onClose} />
    </div>
  )
}


function TestPromptsSection({ siteId, testPrompts }) {
  const { addTestPrompt, updateTestPrompt, deleteTestPrompt, resetPrompts } = useSitesStore()
  const [adding, setAdding] = useState(false)
  const [newPrompt, setNewPrompt] = useState('')
  const [editingIdx, setEditingIdx] = useState(-1)
  const [editDraft, setEditDraft] = useState('')

  const handleAdd = async () => {
    if (!newPrompt.trim()) return
    await addTestPrompt(siteId, newPrompt.trim())
    setNewPrompt('')
    setAdding(false)
  }

  const handleSaveEdit = async (idx) => {
    if (!editDraft.trim()) return
    await updateTestPrompt(siteId, idx, editDraft.trim())
    setEditingIdx(-1)
  }

  return (
    <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', flex: 1 }}>检查任务</span>
        {!adding && (
          <span onClick={() => setAdding(true)} style={{ cursor: 'pointer', fontSize: 14, color: 'var(--text-muted)', lineHeight: 1 }}
            onMouseEnter={(e) => e.currentTarget.style.color = 'var(--text-primary)'}
            onMouseLeave={(e) => e.currentTarget.style.color = 'var(--text-muted)'}
          >+</span>
        )}
      </div>
      {testPrompts.length === 0 && !adding && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span>暂无检查任务</span>
          <span
            onClick={(e) => { e.stopPropagation(); resetPrompts(siteId, 'test') }}
            style={{ color: 'var(--accent)', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 }}
          >恢复默认</span>
        </div>
      )}
      {testPrompts.map((p, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', borderTop: i > 0 ? '1px solid var(--border)' : 'none' }}>
          {editingIdx === i ? (
            <>
              <input value={editDraft} onChange={(e) => setEditDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleSaveEdit(i); if (e.key === 'Escape') setEditingIdx(-1) }}
                autoFocus
                style={{ flex: 1, background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 4, padding: '3px 6px', fontSize: 11, color: 'var(--text-primary)', outline: 'none', fontFamily: 'inherit' }}
              />
              <span onClick={() => handleSaveEdit(i)} style={{ cursor: 'pointer', fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}>保存</span>
              <span onClick={() => setEditingIdx(-1)} style={{ cursor: 'pointer', fontSize: 11, color: 'var(--text-muted)' }}>取消</span>
            </>
          ) : (
            <>
              <span style={{ flex: 1, fontSize: 11, color: 'var(--text-primary)', lineHeight: 1.4, cursor: 'pointer' }}
                onClick={() => { setEditingIdx(i); setEditDraft(p) }}
                title="点击编辑"
              >{p}</span>
              <span onClick={() => deleteTestPrompt(siteId, i)} title="删除"
                style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-muted)', padding: '0 2px' }}
                onMouseEnter={(e) => e.currentTarget.style.color = 'var(--error, #ef4444)'}
                onMouseLeave={(e) => e.currentTarget.style.color = 'var(--text-muted)'}
              >×</span>
            </>
          )}
        </div>
      ))}
      {adding && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
          <input value={newPrompt} onChange={(e) => setNewPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleAdd(); if (e.key === 'Escape') { setAdding(false); setNewPrompt('') } }}
            placeholder="输入检查任务描述"
            autoFocus
            style={{ flex: 1, background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 4, padding: '3px 6px', fontSize: 11, color: 'var(--text-primary)', outline: 'none', fontFamily: 'inherit' }}
          />
          <span onClick={handleAdd} style={{ cursor: newPrompt.trim() ? 'pointer' : 'not-allowed', fontSize: 11, color: newPrompt.trim() ? 'var(--accent)' : 'var(--text-muted)', fontWeight: 600 }}>确定</span>
          <span onClick={() => { setAdding(false); setNewPrompt('') }} style={{ cursor: 'pointer', fontSize: 11, color: 'var(--text-muted)' }}>取消</span>
        </div>
      )}
    </div>
  )
}


function ToolItem({ tool, siteId }) {
  const [open, setOpen] = useState(false)
  const shortName = displayToolName(tool.name)

  return (
    <div style={{
      background: 'var(--bg-secondary)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      overflow: 'hidden',
    }}>
      <div
        onClick={() => setOpen(!open)}
        style={{
          padding: '6px 10px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          userSelect: 'none',
        }}
      >
        <span style={{
          fontSize: 9, color: 'var(--text-muted)',
          transition: 'transform 0.15s',
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          display: 'inline-block',
        }}>▶</span>
        <code style={{
          fontSize: 12, fontWeight: 600, color: 'var(--text-primary)',
          fontFamily: 'monospace',
        }}>{shortName}</code>
        {tool.parameters.length > 0 && (
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            ({tool.parameters.length} 参数)
          </span>
        )}
      </div>
      <AnimatedCollapse open={open} unmountOnExit>
        <div style={{ padding: '0 10px 8px', fontSize: 11 }}>
          {tool.description && (
            <div style={{ color: 'var(--text-secondary)', marginBottom: 6, lineHeight: 1.4 }}>
              {tool.description}
            </div>
          )}
          {tool.parameters.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                  <th style={{ padding: '2px 6px 2px 0', fontWeight: 600 }}>参数</th>
                  <th style={{ padding: '2px 6px', fontWeight: 600 }}>类型</th>
                  <th style={{ padding: '2px 6px', fontWeight: 600 }}>说明</th>
                </tr>
              </thead>
              <tbody>
                {tool.parameters.map((p, j) => (
                  <tr key={j} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '3px 6px 3px 0', whiteSpace: 'nowrap' }}>
                      <code style={{ fontFamily: 'monospace', color: 'var(--text-primary)' }}>{p.name}</code>
                      {p.required && <span style={{ color: 'var(--error)', marginLeft: 2 }}>*</span>}
                    </td>
                    <td style={{ padding: '3px 6px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{p.type}</td>
                    <td style={{ padding: '3px 6px', color: 'var(--text-secondary)', lineHeight: 1.3 }}>{p.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </AnimatedCollapse>
    </div>
  )
}
