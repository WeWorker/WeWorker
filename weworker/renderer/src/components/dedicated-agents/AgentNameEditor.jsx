import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { EditOutlined } from '@ant-design/icons'
import { updateAgent } from '../../api/dedicated-agents-api.js'
import { normalizeAgentName } from '../../utils/dedicated-agents.js'

/**
 * Inline-editable dedicated Agent name.
 *
 * Renders the name plus a small pencil affordance. Clicking the pencil swaps the
 * name for an input; Enter or blur saves through `onSave` for local drafts,
 * or `PATCH /dedicated-agents/:id` for persisted agents.
 * Escape cancels. The pencil and the input stop click propagation so the
 * surrounding list row keeps its own select behaviour while renaming.
 */
const AgentNameEditor = forwardRef(function AgentNameEditor({
  agentId,
  name,
  onSave,
  onSaved,
  disabled = false,
  maxLength = 40,
  iconSize = 12,
  textStyle,
  inputStyle,
  hideEditButton = false,
}, ref) {
  const [draft, setDraft] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const committing = useRef(false)
  const cancelled = useRef(false)

  const beginEdit = () => {
    cancelled.current = false
    setError('')
    setDraft(name)
  }

  useImperativeHandle(ref, () => ({ edit: beginEdit }), [name])

  const save = async () => {
    if (draft === null || committing.current || cancelled.current) return
    const validation = normalizeAgentName(draft, { currentName: name, maxLength })
    if (!validation.ok) { setError(validation.error); return }
    if (!validation.changed) { setDraft(null); setError(''); return }
    committing.current = true
    setSaving(true)
    setError('')
    try {
      const agent = onSave
        ? await onSave(validation.value)
        : (await updateAgent(agentId, { name: validation.value })).agent
      setDraft(null)
      onSaved?.(agent)
    } catch (err) {
      setError(err.message || '重命名失败，请重试')
    } finally {
      committing.current = false
      setSaving(false)
    }
  }

  if (draft !== null) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, maxWidth: '100%' }}>
        <input
          autoFocus
          aria-label="编辑 Agent 名称"
          aria-invalid={error ? 'true' : undefined}
          maxLength={maxLength}
          value={draft}
          disabled={saving}
          onFocus={(event) => event.target.select()}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => { setDraft(event.target.value); setError('') }}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); void save() }
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelled.current = true; setDraft(null); setError('') }
          }}
          style={inputStyle}
        />
        {error && <span role="alert" style={{ fontSize: 11, color: 'var(--error, #ef4444)', whiteSpace: 'nowrap' }}>{error}</span>}
      </span>
    )
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, maxWidth: '100%' }}>
      <span title={name} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...textStyle }}>{name}</span>
      {!hideEditButton && <button
        type="button"
        title="修改名称"
        aria-label={`修改名称 ${name}`}
        disabled={disabled || saving}
        onClick={(event) => { event.stopPropagation(); beginEdit() }}
        onKeyDown={(event) => event.stopPropagation()}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 2,
          border: 'none',
          background: 'none',
          cursor: disabled ? 'default' : 'pointer',
          color: 'var(--text-muted)',
          lineHeight: 1,
          flexShrink: 0,
        }}
      >
        <EditOutlined style={{ fontSize: iconSize }} aria-hidden="true" />
      </button>}
    </span>
  )
})

export default AgentNameEditor
