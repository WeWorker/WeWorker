import React, { useEffect, useState } from 'react'
import { DeleteOutlined, LoadingOutlined, RollbackOutlined } from '@ant-design/icons'
import AppDropdownSelect from '../common/AppDropdownSelect.jsx'
import { useMemoryStore } from '../../store/memory.js'
import { useWorksStore } from '../../store/works.js'
import { showConfirm } from '../../store/dialog.js'
import {
  MEMORY_BUDGET_MAX,
  MEMORY_BUDGET_MIN,
  MEMORY_TYPES,
  MEMORY_FILTER_ALL,
  SCHEDULED_TASK_HISTORY_LIMIT_DEFAULT,
  SCHEDULED_TASK_HISTORY_LIMIT_MAX,
  SCHEDULED_TASK_HISTORY_LIMIT_MIN,
  buildMemoryBudgetDrafts,
  buildMemoryBudgetPayload,
  formatMemoryConfidence,
  formatMemoryUpdatedAt,
  formatMemoryUsageLine,
  memoryTypeLabel,
  memoryTypeOptions,
  validateMemoryBudgetInput,
  validateScheduledTaskHistoryLimit,
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
  const archivedWorks = useMemoryStore((s) => s.archivedWorks)
  const loadingArchivedWorks = useMemoryStore((s) => s.loadingArchivedWorks)
  const restoringWorkId = useMemoryStore((s) => s.restoringWorkId)
  const loadSettings = useMemoryStore((s) => s.loadSettings)
  const saveBudgets = useMemoryStore((s) => s.saveBudgets)
  const loadRecords = useMemoryStore((s) => s.loadRecords)
  const deleteRecord = useMemoryStore((s) => s.deleteRecord)
  const loadArchivedWorks = useMemoryStore((s) => s.loadArchivedWorks)
  const restoreArchivedWork = useMemoryStore((s) => s.restoreArchivedWork)
  const loadWorks = useWorksStore((s) => s.loadWorks)

  const [drafts, setDrafts] = useState(() => buildMemoryBudgetDrafts(null))
  const [budgetMessage, setBudgetMessage] = useState(null)
  const [invalidTypes, setInvalidTypes] = useState([])
  const [historyLimitDraft, setHistoryLimitDraft] = useState(String(SCHEDULED_TASK_HISTORY_LIMIT_DEFAULT))
  const [historyLimitInvalid, setHistoryLimitInvalid] = useState(false)
  const [type, setType] = useState(MEMORY_FILTER_ALL)
  const [listMessage, setListMessage] = useState(null)
  const [archiveMessage, setArchiveMessage] = useState(null)

  useEffect(() => {
    let cancelled = false
    loadSettings().catch((error) => {
      if (!cancelled) setBudgetMessage({ ok: false, text: error.message || '记忆设置加载失败' })
    })
    return () => { cancelled = true }
  }, [loadSettings])

  // 后端返回（含保存成功后）都用返回结构刷新整个面板的输入值。
  useEffect(() => {
    if (settings) {
      setDrafts(buildMemoryBudgetDrafts(settings))
      setHistoryLimitDraft(String(settings.scheduled_task_history_limit ?? SCHEDULED_TASK_HISTORY_LIMIT_DEFAULT))
    }
  }, [settings])

  useEffect(() => {
    let cancelled = false
    setListMessage(null)
    loadRecords(type).catch((error) => {
      if (!cancelled) setListMessage({ ok: false, text: error.message || '记忆列表加载失败' })
    })
    return () => { cancelled = true }
  }, [type, loadRecords])

  useEffect(() => {
    let cancelled = false
    setArchiveMessage(null)
    loadArchivedWorks().catch((error) => {
      if (!cancelled) setArchiveMessage(error.message || '归档对话加载失败')
    })
    return () => { cancelled = true }
  }, [loadArchivedWorks])

  const updateDraft = (key, value) => {
    setDrafts((current) => ({ ...current, [key]: value }))
    setBudgetMessage(null)
    setInvalidTypes((current) => current.filter((item) => item !== key))
  }

  const handleSave = async () => {
    const historyValidation = validateScheduledTaskHistoryLimit(historyLimitDraft)
    if (!historyValidation.ok) {
      setHistoryLimitInvalid(true)
      setBudgetMessage({ ok: false, text: historyValidation.error })
      return
    }
    setHistoryLimitInvalid(false)
    const { memory_budgets, errors } = buildMemoryBudgetPayload(drafts)
    if (errors.length > 0) {
      setInvalidTypes(errors.map((item) => item.type))
      setBudgetMessage({ ok: false, text: `${errors[0].label}：${errors[0].error}，未提交` })
      return
    }
    setInvalidTypes([])
    setBudgetMessage(null)
    try {
      await saveBudgets(memory_budgets, historyValidation.value)
      setBudgetMessage({ ok: true, text: '已保存' })
    } catch (error) {
      setBudgetMessage({ ok: false, text: error.message || '保存失败' })
    }
  }

  const handleRestoreDefaults = () => {
    setDrafts(buildMemoryBudgetDrafts(settings, { useDefaults: true }))
    setHistoryLimitDraft(String(SCHEDULED_TASK_HISTORY_LIMIT_DEFAULT))
    setHistoryLimitInvalid(false)
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

  const handleRestore = async (work) => {
    if (!work?.id || restoringWorkId) return
    setArchiveMessage(null)
    try {
      await restoreArchivedWork(work.id)
      await loadWorks()
    } catch (error) {
      setArchiveMessage(error.message || '恢复对话失败')
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
            <div className="settings-memory-retention">
              <label className="settings-memory-field__label" htmlFor="scheduled-task-history-limit">定时任务对话上限</label>
              <div className={`settings-pill settings-pill--wide settings-memory-pill settings-memory-retention__input${historyLimitInvalid ? ' is-invalid' : ''}`}>
                <input
                  id="scheduled-task-history-limit"
                  type="number"
                  min={SCHEDULED_TASK_HISTORY_LIMIT_MIN}
                  max={SCHEDULED_TASK_HISTORY_LIMIT_MAX}
                  step="1"
                  className="settings-pill-input"
                  value={historyLimitDraft}
                  aria-invalid={historyLimitInvalid || undefined}
                  onChange={(event) => {
                    setHistoryLimitDraft(event.target.value)
                    setHistoryLimitInvalid(false)
                    setBudgetMessage(null)
                  }}
                />
                <span className="settings-pill-chevron">条</span>
              </div>
              <div className="settings-action-hint">默认 50 条；超出时自动删除最早创建的定时任务对话，专属 Agent 的上下文对话不受此上限影响</div>
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

      <div className="settings-group">
        <div className="settings-row settings-row--stacked">
          <div className="settings-row-main">
            <div className="settings-row-text">
              <div className="settings-row-title">已归档对话</div>
              <div className="settings-row-desc">归档的对话会从侧栏隐藏，可在这里恢复</div>
            </div>
          </div>
          <div className="settings-row-control">
            {loadingArchivedWorks ? (
              <div className="settings-action-hint"><LoadingOutlined spin aria-hidden="true" /> 正在加载…</div>
            ) : archivedWorks.length === 0 ? (
              <div className={`settings-action-hint${archiveMessage ? ' is-error' : ''}`}>{archiveMessage || '暂无归档对话'}</div>
            ) : (
              <div className="settings-memory-records">
                {archivedWorks.map((work) => (
                  <div key={work.id} className="settings-memory-record">
                    <div className="settings-memory-record__head">
                      <span className="settings-archive-work-title" title={work.title || '新任务'}>{work.title || '新任务'}</span>
                      <span className="settings-memory-record__meta">
                        {work.updated_at ? <span>{formatMemoryUpdatedAt(work.updated_at)}</span> : null}
                      </span>
                      <button
                        type="button"
                        className="settings-memory-record__restore"
                        aria-label={`恢复对话 ${work.title || '新任务'}`}
                        title="恢复到对话列表"
                        disabled={Boolean(restoringWorkId)}
                        onClick={() => handleRestore(work)}
                      >
                        {restoringWorkId === work.id ? <LoadingOutlined spin /> : <><RollbackOutlined /> 恢复</>}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {archiveMessage && archivedWorks.length > 0 ? <div className="settings-action-hint is-error">{archiveMessage}</div> : null}
            {archivedWorks.length > 0 ? <div className="settings-action-hint settings-memory-count">共 {archivedWorks.length} 条</div> : null}
          </div>
        </div>
      </div>
    </div>
  )
}
