import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { PlusOutlined, UploadOutlined, FolderOutlined } from '@ant-design/icons'
import { DropdownMenuPortal, useDropdownDismiss } from '../common/DropdownMenuPortal.jsx'
import { DROPDOWN_MENU_ITEM_CLASS } from '../common/dropdown-menu-styles.js'

export default function SkillAddMenu({ busy, onUpload, onCreate }) {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const anchorRef = useRef(null)
  const menuRef = useRef(null)
  useDropdownDismiss(open, () => setOpen(false), anchorRef, menuRef)
  return <>
    <button ref={anchorRef} type="button" aria-label="添加 Skill" title="添加 Skill" aria-haspopup="menu" aria-expanded={open} disabled={busy} onClick={() => setOpen(value => !value)}><PlusOutlined /></button>
    <DropdownMenuPortal ref={menuRef} open={open} anchorRef={anchorRef} align="end" minWidth={180}>
      <div role="menu" aria-label="添加 Skill">
        <button type="button" role="menuitem" className={DROPDOWN_MENU_ITEM_CLASS} onClick={() => { setOpen(false); onUpload() }}><UploadOutlined aria-hidden="true" />上传 Skill ZIP</button>
        <button type="button" role="menuitem" className={DROPDOWN_MENU_ITEM_CLASS} onClick={() => { setOpen(false); setCreating(true) }}><FolderOutlined aria-hidden="true" />新增 Skill</button>
      </div>
    </DropdownMenuPortal>
    {creating && <NewSkillDialog onCreate={onCreate} onClose={() => { setCreating(false); anchorRef.current?.focus() }} />}
  </>
}

function NewSkillDialog({ onCreate, onClose }) {
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const formRef = useRef(null)
  useEffect(() => {
    const dismiss = event => {
      if (event.key === 'Escape' && !saving) { event.stopPropagation(); onClose() }
    }
    document.addEventListener('keydown', dismiss, true)
    return () => document.removeEventListener('keydown', dismiss, true)
  }, [saving, onClose])
  useEffect(() => {
    if (error && !saving) formRef.current?.querySelector('input')?.focus()
  }, [error, saving])
  const submit = async event => {
    event.preventDefault()
    if (saving || !name.trim()) return
    setSaving(true)
    setError('')
    try { await onCreate(name.trim()); onClose() }
    catch (failure) { setError(failure instanceof Error ? failure.message : '新增 Skill 失败'); setSaving(false) }
  }
  return createPortal(<div className="skill-create-backdrop" onClick={event => { if (event.target === event.currentTarget && !saving) onClose() }}>
    <form ref={formRef} role="dialog" aria-modal="true" aria-labelledby="skill-create-title" className="skill-create-dialog" onSubmit={submit} onKeyDown={event => {
      if (event.key === 'Tab') {
        const focusable = [...formRef.current.querySelectorAll('input:not(:disabled), button:not(:disabled)')]
        const first = focusable[0], last = focusable.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }}>
      <h3 id="skill-create-title">新增 Skill</h3>
      <p>创建一个新 Skill，编辑器会提供默认模板，可填写内容或添加资源文件。</p>
      <label>文件夹名称<input autoFocus aria-label="Skill 文件夹名称" value={name} disabled={saving} maxLength={100} onChange={event => setName(event.target.value)} placeholder="例如 my-skill" /></label>
      {error && <p role="alert">{error}</p>}
      <div className="skill-create-actions"><button data-app-button="action" type="button" onClick={onClose} disabled={saving}>取消</button><button data-app-button="action" type="submit" disabled={saving || !name.trim()}>{saving ? '创建中…' : '创建'}</button></div>
    </form>
  </div>, document.body)
}
