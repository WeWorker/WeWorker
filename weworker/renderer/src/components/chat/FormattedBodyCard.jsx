import React, { useState } from 'react'
import { FormattedBody } from '../../utils/formatted-body.js'
import { handleChatLinkClick } from '../../utils/chat-links.js'

export default function FormattedBodyCard({ file, disabled, onEdit, onSave, onCancel, onRestore }) {
  const [expanded, setExpanded] = useState(false)
  const [preview, setPreview] = useState(false)
  const body = file.formattedBody
  const editing = typeof body.draft === 'string'
  return <section className="formatted-body-card" aria-label="发布正文" data-chat-input-ignore-focus>
    <div className="formatted-body-card-header">
      <strong>发布正文</strong>
      <span>{editing ? '修改中，保存后才能发送' : '发送时保留正文排版'}</span>
      <button type="button" disabled={disabled} onClick={onRestore}>移回输入框</button>
    </div>
    {editing ? <>
      <div className="formatted-body-card-actions">
        <button type="button" disabled={disabled} onClick={() => setPreview(!preview)}>{preview ? '继续编辑正文' : '预览正文'}</button>
        <button type="button" disabled={disabled || !body.draft.trim()} onClick={onSave}>保存正文</button>
        <button type="button" disabled={disabled} onClick={onCancel}>取消修改</button>
      </div>
      {preview ? <div className="formatted-body formatted-card-content"><FormattedBody markdown={body.draft} onLinkClick={handleChatLinkClick} /></div>
        : <textarea aria-label="编辑发布正文" value={body.draft} disabled={disabled} onChange={event => onEdit(event.target.value)} />}
    </> : <>
      <div className={`formatted-body formatted-card-content${expanded ? '' : ' is-collapsed'}`}><FormattedBody markdown={body.markdown} onLinkClick={handleChatLinkClick} /></div>
      <div className="formatted-body-card-actions">
        <button type="button" disabled={disabled} onClick={() => { setPreview(false); onEdit(body.markdown) }}>编辑正文</button>
        <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>{expanded ? '收起正文' : '展开正文'}</button>
      </div>
    </>}
  </section>
}
