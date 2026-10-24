import React, { useEffect, useState } from 'react'
import { DeleteOutlined, LoadingOutlined } from '@ant-design/icons'
import AppDropdownSelect from '../common/AppDropdownSelect.jsx'
import { useMemoryStore } from '../../store/memory.js'
import { showConfirm } from '../../store/dialog.js'
import {
  MEMORY_BUDGET_MAX,
  MEMORY_BUDGET_MIN,
  MEMORY_TYPES,
  MEMORY_FILTER_ALL,
  buildMemoryBudgetDrafts,
  buildMemoryBudgetPayload,
  formatMemoryConfidence,
  formatMemoryUpdatedAt,
  formatMemoryUsageLine,
  memoryTypeLabel,
  memoryTypeOptions,
  validateMemoryBudgetInput,
} from '../../utils/memory-settings.js'

// 记忆面板：每个类型的最大上下文预算 + 已存记忆列表。
// 契约见 src/utils/memory-settings.js 顶部注释。
export default function MemoryTab() {
  const settings = useMemoryStore((s) => s.settings)
  const records = useMemoryStore((s) => s.records)
  const loadingSettings = useMemoryStore((s) => s.loadingSettings)
  const savingBudgets = useMemoryStore((s) => s.savingBudgets)
  const loadingRecords = useMemoryStore((s) => s.loadingRecords)
  const deletingId = useMemoryStore((s) => s.deletingId)
  const loadSettings = useMemoryStore((s) => s.loadSettings)
  const saveBudgets = useMemoryStore((s) => s.saveBudgets)
  const loadRecords = useMemoryStore((s) => s.loadRecords)
  const deleteRecord = useMemoryStore((s) => s.deleteRecord)

  const [drafts, setDrafts] = useState(() => buildMemoryBudgetDrafts(null))
  const [budgetMessage, setBudgetMessage] = useState(null)
  const [invalidTypes, setInvalidTypes] = useState([])
  const [type, setType] = useState(MEMORY_FILTER_ALL)
  const [listMessage, setListMessage] = useState(null)

  useEffect(() => {
    let cancelled = false
    loadSettings().catch((error) => {
      if (!cancelled) setBudgetMessage({ ok: false, text: error.message || '记忆设置加载失败' })
    })
    return () => { cancelled = true }
  }, [loadSettings])

  // 后端返回（含保存成功后）都用返回结构刷新整个面板的输入值。
  useEffect(() => {
    if (settings) setDrafts(buildMemoryBudgetDrafts(settings))
  }, [settings])

  useEffect(() => {
    let cancelled = false
    setListMessage(null)
    loadRecords(type).catch((error) => {
      if (!cancelled) setListMessage({ ok: false, text: error.message || '记忆列表加载失败' })
    })
    return () => { cancelled = true }
  }, [type, loadRecords])

  const updateDraft = (key, value) => {
    setDrafts((current) => ({ ...current, [key]: value }))
    setBudgetMessage(null)
    setInvalidTypes((current) => current.filter((item) => item !== key))
  }

  const handleSave = async () => {
    const { memory_budgets, errors } = buildMemoryBudgetPayload(drafts)
    if (errors.length > 0) {
      setInvalidTypes(errors.map((item) => item.type))
      setBudgetMessage({ ok: false, text: `${errors[0].label}：${errors[0].error}，未提交` })
      return
    }
    setInvalidTypes([])
    setBudgetMessage(null)
    try {
      await saveBudgets(memory_budgets)
      setBudgetMessage({ ok: true, text: '已保存' })
    } catch (error) {
      setBudgetMessage({ ok: false, text: error.message || '保存失败' })
    }
  }

  const handleRestoreDefaults = () => {
    setDrafts(buildMemoryBudgetDrafts(settings, { useDefaults: true }))
    setInvalidTypes([])
    setBudgetMessage({ ok: true, text: '已填回默认值，点击「保存」后生效' })
  }

  const handleDelete = async (record) => {
    if (!record?.id || deletingId) return
    const confirmed = await showConfirm(`确定删除这条「${memoryTypeLabel(record.type)}」记忆吗？删除后无法恢复。`, '删除记忆', { danger: true })
    if (!confirmed) return
    setListMessage(null)
    try {
      await deleteRecord(record.id)
    } catch (error) {
      setListMessage({ ok: false, text: error.message || '删除失败' })
    }
  }

  const emptyText = type === MEMORY_FILTER_ALL
    ? '暂无记忆'
    : `暂无「${memoryTypeLabel(type)}」记忆`

  return (
    <div className="settings-stack">
      <div className="settings-group">
        <div className="settings-row settings-row--stacked">
          <div className="settings-row-main">
            <div className="settings-row-text">
              <div className="settings-row-title">记忆上下文预算</div>
              <div className="settings-row-desc">
                每个类型长期记忆可占用的最大上下文（{MEMORY_BUDGET_MIN}-{MEMORY_BUDGET_MAX} 估算 token），超出后按更新时间淘汰
              </div>
            </div>
          </div>
          <div className="settings-row-control">
            <div className="settings-memory-grid">
              {MEMORY_TYPES.map((key) => {
                const validation = drafts[key] === undefined || drafts[key] === ''
                  ? null
                  : validateMemoryBudgetInput(drafts[key])
                const invalid = invalidTypes.includes(key) || (validation && !validation.ok)
                const usage = settings?.usage?.[key]
                return (
                  <div key={key} className="settings-memory-field">
                    <label className="settings-memory-field__label" htmlFor={`memory-budget-${key}`}>
                      {memoryTypeLabel(key)}
                    </label>
                    <div className={`settings-pill settings-pill--wide settings-memory-pill${invalid ? ' is-invalid' : ''}`}>
                      <input
                        id={`memory-budget-${key}`}
                        type="number"
                        min={MEMORY_BUDGET_MIN}
                        max={MEMORY_BUDGET_MAX}
                        step="1"
                        className="settings-pill-input"
                        value={drafts[key] ?? ''}
                        aria-invalid={invalid || undefined}
                        onChange={(event) => updateDraft(key, event.target.value)}
                      />
                      <span className="settings-pill-chevron">token</span>
                    </div>
                    <div className={`settings-action-hint${invalid ? ' is-error' : ''}`}>
                      {formatMemoryUsageLine(usage, drafts[key])}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
          <div className="settings-row-footer">
            <span className={`settings-action-hint${budgetMessage ? (budgetMessage.ok ? ' is-success' : ' is-error') : ''}`}>
              {budgetMessage?.text || (loadingSettings ? '正在加载记忆设置…' : `范围 ${MEMORY_BUDGET_MIN}-${MEMORY_BUDGET_MAX}，留空或非整数不会被提交`)}
            </span>
            <div className="settings-btn-group">
              <button data-app-button="action"
                type="button"
                className="settings-btn settings-btn-secondary"
                onClick={handleRestoreDefaults}
                disabled={savingBudgets || !settings}
              >
                恢复默认
              </button>
              <button data-app-button="action"
                type="button"
                className="settings-btn settings-btn-primary"
                onClick={handleSave}
                disabled={savingBudgets || loadingSettings}
              >
                {savingBudgets ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-row settings-row--stacked">
          <div className="settings-row-main">
            <div className="settings-row-text">
              <div className="settings-row-title">已存记忆</div>
              <div className="settings-row-desc">按更新时间倒序，最多显示 200 条</div>
            </div>
          </div>
          <div className="settings-row-control">
            <div className="settings-memory-toolbar">
              <AppDropdownSelect
                value={type}
                options={memoryTypeOptions({ includeAll: true })}
                onChange={(value) => setType(value)}
                ariaLabel="记忆类型筛选"
                className="settings-memory-filter"
                minMenuWidth={156}
                matchAnchorWidth
              />
              {loadingRecords && (
                <span className="settings-action-hint">
                  <LoadingOutlined spin aria-hidden="true" /> 正在加载…
                </span>
              )}
            </div>

            {records.length === 0 && !loadingRecords ? (
              <div className="settings-action-hint settings-memory-empty">{listMessage?.text || emptyText}</div>
            ) : (
              <div className="settings-memory-records">
                {records.map((record) => {
                  const confidence = formatMemoryConfidence(record?.confidence)
                  const updatedAt = formatMemoryUpdatedAt(record?.updatedAt)
                  const content = String(record?.content ?? '')
                  return (
                    <div key={record?.id} className="settings-memory-record">
                      <div className="settings-memory-record__head">
                        <span className="settings-memory-record__type">{memoryTypeLabel(record?.type)}</span>
                        <span className="settings-memory-record__meta">
                          {record?.key ? <span className="settings-memory-record__key" title={record.key}>{record.key}</span> : null}
                          {confidence ? <span>置信度 {confidence}</span> : null}
                          {updatedAt ? <span>{updatedAt}</span> : null}
                        </span>
                        <button
                          type="button"
                          className="settings-memory-record__delete"
                          aria-label="删除这条记忆"
                          title="删除"
                          disabled={deletingId === record?.id}
                          onClick={() => handleDelete(record)}
                        >
                          {deletingId === record?.id ? <LoadingOutlined spin /> : <DeleteOutlined />}
                        </button>
                      </div>
                      <div className="settings-memory-record__content" title={content}>{content}</div>
                    </div>
                  )
                })}
              </div>
            )}

            {listMessage?.ok === false && records.length > 0 ? (
              <div className="settings-action-hint is-error">{listMessage.text}</div>
            ) : null}
            {records.length > 0 ? (
              <div className="settings-action-hint settings-memory-count">共 {records.length} 条</div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
