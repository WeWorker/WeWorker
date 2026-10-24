import React, { useState, useEffect } from 'react'
import { backendFetch } from '../../api/http.js'

export default function SaveCodewordModal({ selectedMessages, onClose }) {
  const [name, setName] = useState('')
  const [steps, setSteps] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    // Extract steps directly from structured message data (no LLM needed)
    const steps = []
    for (const m of selectedMessages) {
      for (const block of (m.content ?? [])) {
        if (block.type === 'text' && m.role === 'user' && block.text?.trim()) {
          steps.push(`用户指令: ${block.text.trim().slice(0, 100)}`)
        }
        if (block.type === 'tool_use' && block.name) {
          const argsStr = block.args ? Object.entries(block.args).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ') : ''
          steps.push(`Call \`${block.name}\`${argsStr ? ` with ${argsStr}` : ''}`)
        }
      }
    }

    if (steps.length === 0) {
      setError('选中的消息中没有可提取的操作步骤')
      setLoading(false)
      return
    }

    const stepsText = steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
    setSteps(`### "[暗号名称]" — 从对话中提取\n\nSteps:\n${stepsText}\n`)
    setLoading(false)
  }, [selectedMessages])

  const handleSave = async () => {
    if (!name.trim()) { setError('请输入暗号名称'); return }
    if (!steps.trim()) { setError('步骤内容不能为空'); return }
    setSaving(true)
    setError('')

    // Ensure the steps have the name filled in
    let finalSteps = steps
    if (finalSteps.includes('[暗号名称]')) {
      finalSteps = finalSteps.replace('[暗号名称]', name.trim())
    } else if (finalSteps.startsWith('### ""')) {
      finalSteps = finalSteps.replace('### ""', `### "${name.trim()}"`)
    } else if (!finalSteps.startsWith('###')) {
      finalSteps = `### "${name.trim()}" — 从对话中提取\n\n${finalSteps}`
    }

    try {
      // Get current examples
      const skillRes = await backendFetch('/skills')
      const skills = await skillRes.json()
      const builtin = skills.find(s => s.name === 'personal-codewords')
      const marker = '## Examples\n'
      const existing = builtin?.content || ''
      const idx = existing.indexOf(marker)
      const currentExamples = idx >= 0 ? existing.slice(idx + marker.length).trim() : ''

      // Append new codeword
      const newExamples = currentExamples
        ? `${currentExamples}\n\n---\n\n${finalSteps.trim()}`
        : finalSteps.trim()

      const res = await backendFetch('/skills/personal-codewords', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ examples: newExamples }),
      })

      if (!res.ok) {
        const d = await res.json()
        setError(d.detail || '保存失败')
        setSaving(false)
        return
      }

      // Enable the skill if disabled
      if (!builtin?.enabled) {
        await backendFetch('/skills/personal-codewords/toggle', { method: 'POST' })
      }

      setSaved(true)
      setTimeout(onClose, 1200)
    } catch (e) {
      setError(e.message)
      setSaving(false)
    }
  }

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 14, padding: 28, width: 520, maxWidth: '92vw', maxHeight: '80vh', overflowY: 'auto' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>保存为暗号</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              已从 {selectedMessages.length} 条消息中提取操作步骤
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 18 }}>×</button>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 5, fontWeight: 600 }}>
            暗号名称 <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>（之后发送这个词即可触发）</span>
          </label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder='例如：续命、查订单、发周报...'
            autoFocus
            style={{ width: '100%', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--text-primary)', fontSize: 14, padding: '8px 12px', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box' }}
            onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleSave() }}
          />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 5, fontWeight: 600 }}>
            提取的步骤 <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>（可以编辑）</span>
          </label>
          {loading ? (
            <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              正在提取步骤...
            </div>
          ) : (
            <textarea
              value={steps}
              onChange={e => setSteps(e.target.value)}
              rows={10}
              style={{ width: '100%', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--text-primary)', fontSize: 12, padding: '8px 12px', outline: 'none', fontFamily: 'monospace', resize: 'vertical', boxSizing: 'border-box' }}
            />
          )}
        </div>

        {error && (
          <div style={{ fontSize: 12, color: 'var(--error)', padding: '6px 10px', background: 'rgba(248,113,113,0.1)', borderRadius: 6, marginBottom: 12 }}>{error}</div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button data-app-button="action" onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '8px 16px', fontSize: 13, fontWeight: 600 }}>取消</button>
          <button data-app-button="action"
            onClick={handleSave}
            disabled={loading || saving || saved}
            style={{ background: saved ? 'var(--success)' : 'var(--accent)', color: '#fff', border: 'none', borderRadius: 7, padding: '8px 20px', fontSize: 13, fontWeight: 600, cursor: loading || saving ? 'not-allowed' : 'pointer', opacity: loading ? 0.5 : 1 }}
          >
            {saved ? '已保存 ✓' : saving ? '保存中...' : '保存暗号'}
          </button>
        </div>
      </div>
    </div>
  )
}
