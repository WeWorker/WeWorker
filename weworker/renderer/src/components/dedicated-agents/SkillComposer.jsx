import React, { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Checkbox, Input, Radio, Space, Tag } from 'antd'
import { LoadingOutlined, UploadOutlined } from '@ant-design/icons'
import SiteIcon from '../icons/SiteIcon.jsx'
import AppDropdownSelect from '../common/AppDropdownSelect.jsx'
import {
  fetchAgentSkill,
  fetchAgentSkills,
  generateSkill,
  importSkillFile,
  reviseSkill,
  saveSkill,
  suggestSkillName,
} from '../../api/dedicated-agents-api.js'
import {
  compactSiteCapabilities,
  genericSkillGoalPlaceholder,
  GENERIC_KNOWLEDGE_PLACEHOLDER,
  SKILL_MODES,
  SKILL_SCOPE_LABELS,
  sitePurpose,
  skillImportLabel,
  supportedSkillImportPath,
} from '../../utils/dedicated-agents.js'
import { fieldStyle, hintStyle, labelStyle, markdownEditorStyle } from './styles.js'

const requiredMark = <span aria-hidden="true" style={{ color: 'var(--error, #ef4444)', marginRight: 4 }}>*</span>

function shortToolName(name) {
  const parts = String(name || '').split('.')
  return parts[parts.length - 1] || name
}

/** What this selected website is for and what its Adapter can actually do. */
export function SiteCapabilitySummary({ site }) {
  const capabilities = compactSiteCapabilities(site)
  const toolCount = Number(site?.toolCount ?? site?.tools?.length ?? 0)
  return (
    <div style={{ border: '1px solid var(--border)', background: 'var(--bg-secondary)', borderRadius: 10, padding: 14, marginBottom: 16 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <SiteIcon site={site} size={30} />
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 14, color: 'var(--text-primary)' }}>{site?.name || site?.id}</strong>
            <Tag bordered={false} style={{ fontSize: 10, marginInlineEnd: 0 }}>{toolCount} 项工具</Tag>
          </div>
          <div style={{ ...hintStyle, marginTop: 4, color: 'var(--text-secondary)' }}>{sitePurpose(site)}</div>
        </div>
      </div>
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>Adapter 的核心能力</div>
        {capabilities.length ? (
          <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
            {capabilities.map((tool) => (
              <li key={tool.name} style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                <code style={{ fontSize: 11, color: 'var(--text-primary)' }}>{shortToolName(tool.name)}</code>
                <span>：{tool.description}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div style={hintStyle}>该 Adapter 暂未提供可展示的工具说明；生成 Skill 时仍会使用实际工具清单。</div>
        )}
        {toolCount > capabilities.length && capabilities.length > 0 && (
          <div style={{ ...hintStyle, marginTop: 6 }}>另有 {toolCount - capabilities.length} 项能力会在 AI 生成 Skill 时一并参考。</div>
        )}
      </div>
    </div>
  )
}

/** AI revise box shared by the wizard and the detail editor. */
function ReviseBox({ siteId, skillName, markdown, onRevised }) {
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async () => {
    setBusy(true)
    setError('')
    try {
      const result = await reviseSkill({ site_id: siteId, skill_name: skillName, markdown, instruction })
      onRevised(result.markdown)
      setInstruction('')
    } catch (err) {
      setError(err.message || '修改失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div style={{ marginTop: 10 }}>
      <Space.Compact style={{ width: '100%' }}>
        <Input
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          onPressEnter={() => instruction.trim() && !busy && run()}
          placeholder="让 AI 帮你改，例如：补充审批前必须核对的字段和例外情况"
          disabled={busy}
          aria-label="让 AI 修改 Skill"
        />
        <Button data-app-button="action" onClick={run} disabled={!instruction.trim() || busy} icon={busy ? <LoadingOutlined /> : null}>
          {busy ? '修改中' : 'AI 修改'}
        </Button>
      </Space.Compact>
      {error && <div style={{ ...hintStyle, color: 'var(--error, #ef4444)', marginTop: 6 }}>{error}</div>}
    </div>
  )
}

/** Wizard step: decide where the agent's private knowledge comes from. */
export default function SkillComposer({ draft, onChange, site }) {
  const [skills, setSkills] = useState([])
  const [preview, setPreview] = useState('')
  const [generating, setGenerating] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')
  const [importMessage, setImportMessage] = useState('')

  const reloadSkills = useCallback(async () => {
    try {
      const result = await fetchAgentSkills()
      setSkills(result)
      return result
    } catch {
      setSkills([])
      return []
    }
  }, [])

  useEffect(() => { void reloadSkills() }, [reloadSkills])

  useEffect(() => {
    if (draft.skillName || !site?.id) return
    suggestSkillName(site.id).then((result) => onChange({ skillName: result.skill_name })).catch(() => {})
    // Only when the site changes or no name has been chosen yet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site?.id])

  useEffect(() => {
    if (draft.skillMode !== SKILL_MODES.existing || !draft.existingSkill) {
      setPreview('')
      return
    }
    fetchAgentSkill(draft.existingSkill).then((result) => setPreview(result.markdown)).catch(() => setPreview(''))
  }, [draft.skillMode, draft.existingSkill])

  const generate = async () => {
    setGenerating(true)
    setError('')
    try {
      const result = await generateSkill({
        site_id: site.id,
        agent_name: draft.name,
        goal: draft.goal,
        knowledge: draft.knowledge,
        skill_name: draft.skillName,
      })
      onChange({
        skillName: result.skill_name,
        skillMarkdown: result.markdown,
        examplesText: draft.examplesText?.trim() ? draft.examplesText : (result.examples || []).join('\n'),
      })
    } catch (err) {
      setError(err.message || '生成失败')
    } finally {
      setGenerating(false)
    }
  }

  const importExistingSkill = async () => {
    setError('')
    setImportMessage('')
    const selectFiles = window.electronAPI?.selectFiles
    if (!selectFiles) {
      setError('当前环境不支持从本机导入 Skill 文件')
      return
    }
    let paths
    try {
      paths = await selectFiles({ filters: [{ name: 'Skill 文件或包', extensions: ['md', 'zip'] }] })
    } catch (err) {
      setError(err.message || '打开文件选择器失败')
      return
    }
    if (!Array.isArray(paths) || paths.length === 0) return
    if (paths.length !== 1) {
      setError('一次只能导入一个 .md 或 .zip 文件')
      return
    }
    const sourcePath = paths[0]
    if (!supportedSkillImportPath(sourcePath)) {
      setError('只支持导入 .md 或 .zip 文件')
      return
    }
    setImporting(true)
    try {
      const imported = await importSkillFile(sourcePath, 'private')
      await reloadSkills()
      onChange({ existingSkill: imported.name, skillMode: SKILL_MODES.existing })
      setPreview(imported.markdown)
      setImportMessage(`已从「${skillImportLabel(sourcePath)}」导入「${imported.name}」${imported.resource_count ? `，包含 ${imported.resource_count} 个资料文件` : ''}。默认仅专属 Agent 使用。`)
    } catch (err) {
      setError(err.message || '导入失败')
    } finally {
      setImporting(false)
    }
  }

  return (
    <div>
      <SiteCapabilitySummary site={site} />
      <Radio.Group
        value={draft.skillMode}
        onChange={(event) => onChange({ skillMode: event.target.value })}
        style={{ marginBottom: 16 }}
        optionType="button"
        buttonStyle="solid"
      >
        <Radio.Button value={SKILL_MODES.generate}>AI 帮我写（推荐）</Radio.Button>
        <Radio.Button value={SKILL_MODES.existing}>使用已有 Skill</Radio.Button>
        <Radio.Button value={SKILL_MODES.none}>暂不需要</Radio.Button>
      </Radio.Group>

      {draft.skillMode === SKILL_MODES.generate && (
        <div>
          <div style={{ ...hintStyle, marginBottom: 12 }}>
            Skill 是 Agent 的“专属知识手册”。AI 会结合上方展示的「{site?.name}」实际能力，把你的目标和业务规则整理成可执行步骤。不要填写密码、Token、Cookie 或个人账号。
          </div>
          <div style={fieldStyle}>
            <label style={labelStyle} htmlFor="agent-goal">{requiredMark}这个 Agent 要帮你做什么</label>
            <Input.TextArea id="agent-goal" value={draft.goal} onChange={(event) => onChange({ goal: event.target.value })} placeholder={genericSkillGoalPlaceholder(site)} autoSize={{ minRows: 2, maxRows: 5 }} />
          </div>
          <div style={fieldStyle}>
            <label style={labelStyle} htmlFor="agent-knowledge">你掌握的专属知识（可选，但越具体越好用）</label>
            <Input.TextArea id="agent-knowledge" value={draft.knowledge} onChange={(event) => onChange({ knowledge: event.target.value })} placeholder={GENERIC_KNOWLEDGE_PLACEHOLDER} autoSize={{ minRows: 5, maxRows: 14 }} />
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12 }}>
            <div style={{ width: 240 }}>
              <label style={labelStyle} htmlFor="agent-skill-name">{requiredMark}Skill 名称</label>
              <Input id="agent-skill-name" value={draft.skillName} onChange={(event) => onChange({ skillName: event.target.value.trim() })} placeholder="例如 invoice-review-helper" />
            </div>
            <Button data-app-button="action" type="primary" onClick={generate} disabled={generating || (!draft.goal?.trim() && !draft.knowledge?.trim())} icon={generating ? <LoadingOutlined /> : null}>
              {generating ? 'AI 正在整理（约 30–90 秒）' : draft.skillMarkdown ? '重新生成' : '生成 Skill'}
            </Button>
          </div>
          {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
          {draft.skillMarkdown && (
            <div>
              <label style={labelStyle} htmlFor="agent-skill-markdown">生成结果（可直接修改）</label>
              <Input.TextArea id="agent-skill-markdown" value={draft.skillMarkdown} onChange={(event) => onChange({ skillMarkdown: event.target.value })} style={markdownEditorStyle} />
              <ReviseBox siteId={site.id} skillName={draft.skillName} markdown={draft.skillMarkdown} onRevised={(markdown) => onChange({ skillMarkdown: markdown })} />
              <Checkbox
                style={{ marginTop: 12 }}
                checked={draft.skillScope === 'public'}
                onChange={(event) => onChange({ skillScope: event.target.checked ? 'public' : 'private' })}
              >
                也用于 WeWorker 主对话（会出现在「SKILLS与场景」中）
              </Checkbox>
              <div style={{ ...hintStyle, marginLeft: 24 }}>默认不勾选：这份知识只给专属 Agent 用，不影响主对话。之后也可以在 Agent 设置里切换。</div>
            </div>
          )}
        </div>
      )}

      {draft.skillMode === SKILL_MODES.existing && (
        <div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
            <div style={{ ...fieldStyle, marginBottom: 0, minWidth: 280, flex: 1 }}>
              <span style={labelStyle} id="agent-existing-skill-label">{requiredMark}选择 Skill</span>
              <div style={{ maxWidth: 520 }}>
                <AppDropdownSelect
                  value={draft.existingSkill || ''}
                  onChange={(value) => onChange({ existingSkill: value })}
                  ariaLabel="选择 Skill"
                  matchAnchorWidth
                  fallbackOption={{ value: '', label: skills.length ? '选择一个已有 Skill' : '还没有可用的 Skill' }}
                  options={skills.map((skill) => ({ value: skill.name, label: skill.name, description: skill.description || undefined, scope: skill.scope }))}
                  renderOptionSuffix={(option) => (option?.scope ? (
                    <Tag bordered={false} color={option.scope === 'public' ? 'blue' : 'default'} style={{ fontSize: 10, lineHeight: '16px', padding: '0 5px', marginInlineEnd: 0 }}>
                      {SKILL_SCOPE_LABELS[option.scope]}
                    </Tag>
                  ) : null)}
                />
              </div>
            </div>
            <Button data-app-button="action" onClick={importExistingSkill} loading={importing} icon={<UploadOutlined />}>导入 .md / .zip</Button>
          </div>
          <div style={hintStyle}>可以从本机导入单个 Markdown，或导入含有 `SKILL.md` 的 ZIP 包。导入的 Skill 默认仅专属 Agent 使用，不影响主对话。</div>
          {importMessage && <Alert type="success" showIcon style={{ marginTop: 10 }} message={importMessage} />}
          {error && <Alert type="error" showIcon style={{ marginTop: 10 }} message={error} />}
          {preview && (
            <Input.TextArea value={preview} readOnly style={{ ...markdownEditorStyle, minHeight: 220, marginTop: 12 }} aria-label="Skill 预览" />
          )}
        </div>
      )}

      {draft.skillMode === SKILL_MODES.none && (
        <Alert
          type="info"
          showIcon
          message={`Agent 只会使用「${site?.name || '该网站'}」自带的能力。之后可以随时在 Agent 设置里补充专属知识。`}
        />
      )}

      <div style={{ ...fieldStyle, marginTop: 20 }}>
        <label style={labelStyle} htmlFor="agent-examples">示例问题（每行一个，会在聊天里提示给你）</label>
        <Input.TextArea id="agent-examples" value={draft.examplesText} onChange={(event) => onChange({ examplesText: event.target.value })} placeholder={`例如：请帮我处理「${site?.name || '这个网站'}」上的一项工作`} autoSize={{ minRows: 2, maxRows: 6 }} />
      </div>
    </div>
  )
}

/** Detail page: edit an agent's existing private skill. */
export function SkillEditorCard({ skillName, siteId }) {
  const [markdown, setMarkdown] = useState('')
  const [original, setOriginal] = useState('')
  const [state, setState] = useState('loading') // loading | ready | missing | saving
  const [message, setMessage] = useState(null)

  useEffect(() => {
    let cancelled = false
    setState('loading')
    setMessage(null)
    fetchAgentSkill(skillName)
      .then((result) => {
        if (cancelled) return
        setMarkdown(result.markdown)
        setOriginal(result.markdown)
        setState('ready')
      })
      .catch(() => !cancelled && setState('missing'))
    return () => { cancelled = true }
  }, [skillName])

  if (state === 'loading') return <div style={hintStyle}><LoadingOutlined /> 加载中…</div>
  if (state === 'missing') {
    return <Alert type="warning" showIcon message={`Skill「${skillName}」不存在或已停用，Agent 目前只使用网站自带能力。`} />
  }

  const dirty = markdown !== original
  const save = async () => {
    setState('saving')
    setMessage(null)
    try {
      const result = await saveSkill(skillName, markdown)
      setMarkdown(result.markdown)
      setOriginal(result.markdown)
      setMessage({ ok: true, text: '已保存，下一条消息起生效' })
    } catch (err) {
      setMessage({ ok: false, text: err.message || '保存失败' })
    } finally {
      setState('ready')
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Tag>{skillName}</Tag>
      </div>
      <Input.TextArea value={markdown} onChange={(event) => setMarkdown(event.target.value)} style={markdownEditorStyle} aria-label="专属 Skill 内容" />
      <ReviseBox siteId={siteId} skillName={skillName} markdown={markdown} onRevised={setMarkdown} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
        <Button data-app-button="action" type="primary" onClick={save} disabled={!dirty || state === 'saving'}>{state === 'saving' ? '保存中…' : '保存 Skill'}</Button>
        {dirty && <Button data-app-button="action" onClick={() => setMarkdown(original)}>撤销修改</Button>}
        {message && <span style={{ ...hintStyle, color: message.ok ? 'var(--success, #22c55e)' : 'var(--error, #ef4444)' }}>{message.text}</span>}
      </div>
    </div>
  )
}
