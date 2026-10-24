import AppSwitch from '../common/AppSwitch.jsx'
import { useState, useEffect } from 'react'
import { backendFetch } from '../../api/http.js'
import { showConfirm } from '../../store/dialog.js'
const BUILTIN = 'personal-codewords'

// Count ### headings in examples section = number of codewords
// Strip HTML comments first to avoid counting commented-out examples
function countExamples(content) {
  const marker = '## Examples\n'
  const idx = content.indexOf(marker)
  if (idx < 0) return 0
  const examples = content.slice(idx + marker.length).replace(/<!--[\s\S]*?-->/g, '')
  return (examples.match(/^### /gm) || []).length
}

export default function SkillsTab() {
  const [skills, setSkills] = useState([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState('list') // 'list' | 'edit-builtin' | 'edit-custom' | 'new'
  const [form, setForm] = useState({ name: '', content: '' })
  const [editingSkill, setEditingSkill] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const res = await backendFetch('/skills')
      if (res.ok) setSkills(await res.json())
    } catch {}
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const builtinSkill = skills.find(s => s.name === BUILTIN)
  const userSkills = skills.filter(s => s.name !== BUILTIN)

  const openBuiltin = () => {
    const content = builtinSkill?.content ?? ''
    const marker = '## Examples\n'
    const idx = content.indexOf(marker)
    setForm({ examples: idx >= 0 ? content.slice(idx + marker.length).trim() : '' })
    setView('edit-builtin')
    setError('')
  }

  const toggleBuiltin = async () => {
    try {
      await backendFetch('/skills/personal-codewords/toggle', { method: 'POST' })
      await load()
    } catch {}
  }

  const openNew = () => {
    setForm({ name: '', content: newSkillTemplate() })
    setView('new')
    setError('')
  }

  const openEdit = (skill) => {
    setEditingSkill(skill)
    setForm({ content: skill.content })
    setView('edit-custom')
    setError('')
  }

  const saveBuiltin = async () => {
    setSaving(true)
    setError('')
    try {
      const res = await backendFetch('/skills/personal-codewords', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ examples: form.examples }),
      })
      if (res.ok) { await load(); setView('list') }
      else { const d = await res.json(); setError(d.detail || '保存失败') }
    } catch (e) { setError(e.message) }
    setSaving(false)
  }

  const saveCustom = async () => {
    if (view === 'new' && !form.name?.trim()) { setError('请输入技能名称'); return }
    if (!form.content?.trim()) { setError('请输入技能内容'); return }
    setSaving(true)
    setError('')
    try {
      const name = view === 'new' ? form.name.trim() : editingSkill.name
      const res = await backendFetch('/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, content: form.content }),
      })
      if (res.ok) { await load(); setView('list') }
      else { const d = await res.json(); setError(d.detail || '保存失败') }
    } catch (e) { setError(e.message) }
    setSaving(false)
  }

  const deleteSkill = async (name) => {
    if (!await showConfirm(`删除技能 "${name}"？`, '删除技能', { danger: true })) return
    try {
      await backendFetch(`/skills/${encodeURIComponent(name)}`, { method: 'DELETE' })
      await load()
    } catch {}
  }

  // ── Edit builtin ──────────────────────────────────────────────────────────
  if (view === 'edit-builtin') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <BackHeader title="个人暗号" onBack={() => setView('list')} />
        <div style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', fontSize: 12, color: 'var(--text-muted)' }}>
          为 AI 注册你的私人快捷指令。当你发送一个简短的暗号时，AI 会自动识别并执行对应的操作，无需重复解释。
        </div>
        <div>
          <label style={labelStyle}>参照示例格式，添加你的暗号</label>
          <textarea
            value={form.examples}
            onChange={e => setForm(f => ({ ...f, examples: e.target.value }))}
            rows={10}
            placeholder={`### "续命" — 购买一周所需的牛奶\n\nSteps:\n1. Call \`open_browser\` with URL \`https://www.jd.com\`\n2. Search for \`光明 鲜牛奶 500ml\`\n3. ...\n\n---\n\n### "另一个暗号" — 描述\n\nSteps:\n1. ...`}
            style={{ ...inputStyle, resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }}
          />
        </div>
        <ErrorMsg msg={error} />
        <SaveRow onCancel={() => setView('list')} onSave={saveBuiltin} saving={saving} />
      </div>
    )
  }

  // ── Edit / New custom skill ───────────────────────────────────────────────
  if (view === 'edit-custom' || view === 'new') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <BackHeader title={view === 'new' ? '新建技能' : `编辑：${editingSkill?.name}`} onBack={() => setView('list')} />
        {view === 'new' && (
          <div>
            <label style={labelStyle}>技能名称</label>
            <input
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="my-skill"
              style={inputStyle}
            />
          </div>
        )}
        <div>
          <label style={labelStyle}>SKILL.md 内容</label>
          <textarea
            value={form.content}
            onChange={e => setForm(f => ({ ...f, content: e.target.value }))}
            rows={12}
            style={{ ...inputStyle, resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }}
          />
        </div>
        <ErrorMsg msg={error} />
        <SaveRow onCancel={() => setView('list')} onSave={saveCustom} saving={saving} />
      </div>
    )
  }

  // ── List ──────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Builtin */}
      <div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>内置技能</div>
        {loading ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>加载中...</div>
        ) : (
          <div style={{ ...cardStyle, borderColor: builtinSkill?.enabled ? 'var(--accent)' : 'var(--border)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>个人暗号</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                {builtinSkill
                  ? `${countExamples(builtinSkill.content)} 个暗号 · ${builtinSkill.enabled ? '已启用' : '已关闭'}`
                  : '未初始化'}
              </div>
            </div>
            <button onClick={openBuiltin} style={iconBtnStyle} title="编辑暗号">✎</button>
            <AppSwitch checked={!!builtinSkill?.enabled} onChange={toggleBuiltin} aria-label="启用个人暗号" />
          </div>
        )}
      </div>

      {/* User skills */}
      <div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>自定义技能</div>
        {!loading && userSkills.length === 0 && (
          <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: '8px 0' }}>暂无自定义技能</div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {userSkills.map(s => (
            <div key={s.name} style={cardStyle}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{s.name}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.content.split('\n').find(l => l.trim() && !l.startsWith('#') && !l.startsWith('---')) || ''}
                </div>
              </div>
              <button onClick={() => openEdit(s)} style={iconBtnStyle} title="编辑">✎</button>
              <button onClick={() => deleteSkill(s.name)} style={{ ...iconBtnStyle, color: 'var(--error)' }} title="删除">✕</button>
            </div>
          ))}
        </div>
      </div>

      <button data-app-button="action" onClick={openNew} style={{ ...btnStyle, background: 'var(--accent)', alignSelf: 'flex-start' }}>
        + 新建技能
      </button>
    </div>
  )
}

function BackHeader({ title, onBack }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button onClick={onBack} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18, padding: 0 }}>←</button>
      <span style={{ fontSize: 13, fontWeight: 600 }}>{title}</span>
    </div>
  )
}

function ErrorMsg({ msg }) {
  if (!msg) return null
  return <div style={{ fontSize: 12, color: 'var(--error)', padding: '6px 10px', background: 'rgba(248,113,113,0.1)', borderRadius: 6 }}>{msg}</div>
}

function SaveRow({ onCancel, onSave, saving }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
      <button data-app-button="action" onClick={onCancel} style={{ ...btnStyle, background: 'transparent', color: 'var(--text-muted)' }}>取消</button>
      <button data-app-button="action" onClick={onSave} disabled={saving} style={{ ...btnStyle, background: 'var(--accent)' }}>
        {saving ? '保存中...' : '保存'}
      </button>
    </div>
  )
}

function newSkillTemplate() {
  return `---
name: my-skill
description: 描述这个技能的用途
origin: WeWorker
---

# /my-skill — 技能名称

技能的详细说明

## Trigger

Use this skill when:
- 触发条件

## Examples

### Example 1: "关键词"
\`\`\`
执行的操作
\`\`\`
`
}

const labelStyle = { display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 5, fontWeight: 600 }
const inputStyle = {
  width: '100%',
  background: 'var(--bg-primary)',
  border: '1px solid var(--border)',
  borderRadius: 7,
  color: 'var(--text-primary)',
  fontSize: 13,
  padding: '7px 10px',
  outline: 'none',
  fontFamily: 'inherit',
  boxSizing: 'border-box',
}
const btnStyle = {
  border: 'none', borderRadius: 7, color: '#fff',
  cursor: 'pointer', padding: '7px 16px', fontSize: 13, fontWeight: 600,
}
const iconBtnStyle = {
  background: 'none', border: 'none', cursor: 'pointer',
  color: 'var(--text-muted)', fontSize: 14, padding: '2px 6px',
  borderRadius: 4, flexShrink: 0,
}
const cardStyle = {
  background: 'var(--bg-tertiary)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '10px 12px',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
}
