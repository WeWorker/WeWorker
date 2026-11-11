import AppSwitch from '../common/AppSwitch.jsx'
import AppDropdownSelect from '../common/AppDropdownSelect.jsx'
import { EditOutlined } from '@ant-design/icons'
import './scheduled-task-title.css'
import React, { useState, useEffect, useMemo, useRef } from 'react'
import { useScheduledTasksStore } from '../../store/scheduled-tasks.js'
import { useWorksStore } from '../../store/works.js'
import { useSettingsStore } from '../../store/settings.js'
import { backendFetch } from '../../api/http.js'
import { showAlert, showConfirm } from '../../store/dialog.js'
import { getExecutionPage } from '../../utils/scheduled-task-executions.js'
import {
  ALL_WEEKDAYS,
  FREQUENCY_OPTIONS,
  MINUTE_INTERVAL_OPTIONS,
  WEEKDAY_FILTER_OPTIONS,
  WEEKDAY_OPTIONS,
  WEEKDAY_PRESETS,
  buildCron,
  getNextRuns,
  nextRunsSummary,
  parseCron,
  selectWeekdayPreset,
  toggleWeekday,
} from '../../utils/scheduled-task-schedule.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_COLORS = {
  pending: '#9ca3af',
  running: '#339CFF',
  completed: '#22c55e',
  failed: '#ef4444',
}

const STATUS_LABELS = {
  pending: '等待中',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
}

function formatTime(isoStr) {
  if (!isoStr) return '-'
  try { return new Date(isoStr).toLocaleString('zh-CN') } catch { return isoStr }
}

function getEnabledChannels(channels) {
  const result = []
  if (channels?.qq?.enabled) result.push({ id: 'qq', label: 'QQ' })
  if (channels?.weixin?.enabled) result.push({ id: 'weixin', label: '微信' })
  if (channels?.wecom?.enabled) result.push({ id: 'wecom', label: '企业微信' })
  if (channels?.feishu?.enabled) result.push({ id: 'feishu', label: '飞书' })
  return result
}

// ---------------------------------------------------------------------------
// Hour / Minute selector helpers
// ---------------------------------------------------------------------------

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, value) => ({ value, label: String(value).padStart(2, '0') + ' 时' }))
const MINUTE_OPTIONS = Array.from({ length: 12 }, (_, i) => ({ value: i * 5, label: String(i * 5).padStart(2, '0') + ' 分' }))

// ---------------------------------------------------------------------------
// TaskConfigView
// ---------------------------------------------------------------------------

export default function TaskConfigView({ taskId }) {
  const tasks = useScheduledTasksStore((s) => s.tasks)
  const executions = useScheduledTasksStore((s) => s.executions[taskId] ?? [])
  const updateTask = useScheduledTasksStore((s) => s.updateTask)
  const deleteTask = useScheduledTasksStore((s) => s.deleteTask)
  const runTask = useScheduledTasksStore((s) => s.runTask)
  const loadExecutions = useScheduledTasksStore((s) => s.loadExecutions)
  const running = useScheduledTasksStore((s) => Boolean(s.runningTasks[taskId] || s.startingTasks[taskId]))
  const selectWork = useWorksStore((s) => s.selectWork)
  const channels = useSettingsStore((s) => s.channels)

  const task = tasks.find((t) => t.id === taskId)

  // Form state
  const [title, setTitle] = useState('')
  const [isTitleEditing, setIsTitleEditing] = useState(false)
  const [titleError, setTitleError] = useState('')
  const titleCommitInProgress = useRef(false)
  const titleEditCancelled = useRef(false)
  const [schedule, setSchedule] = useState({ frequency: 'daily', hour: 9, minute: 0, weekday: '1', weekdays: ALL_WEEKDAYS, weekdayPreset: 'every_day', minuteInterval: 30 })
  const [promptTemplate, setPromptTemplate] = useState('')
  const [notifyChannels, setNotifyChannels] = useState([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let stopped = false
    let timer
    const refresh = async () => {
      try { await loadExecutions(taskId) } catch { /* Retry on the next poll. */ }
      if (!stopped) timer = setTimeout(refresh, 3000)
    }
    void refresh()
    return () => { stopped = true; clearTimeout(timer) }
  }, [taskId, loadExecutions])

  // Sync form state when task changes
  useEffect(() => {
    if (!task) return
    setSchedule(parseCron(task.cron_expression))
    setPromptTemplate(task.prompt_template || '')
    setNotifyChannels(task.notify_channels || [])
  }, [task?.id])

  // A sidebar rename must update the title without resetting other unsaved fields.
  useEffect(() => {
    setTitle(task?.title || '')
    setIsTitleEditing(false)
    setTitleError('')
  }, [task?.id, task?.title])

  const cronExpression = useMemo(() => buildCron(schedule), [schedule])
  const nextRunsHint = useMemo(() => nextRunsSummary(schedule), [schedule])
  const enabledChannels = useMemo(() => getEnabledChannels(channels), [channels])
  const hasUpcomingRuns = useMemo(() => Boolean(cronExpression && getNextRuns(schedule, 1).length), [cronExpression, schedule])
  const canSave = Boolean(title.trim() && promptTemplate.trim() && hasUpcomingRuns)
  const weeklyDays = schedule.weekdayPreset === null ? schedule.weekdays : [Number(schedule.weekday)]
  const weeklyValue = weeklyDays.join(',')
  const weeklyLabel = weeklyDays.map((day) => WEEKDAY_OPTIONS.find((option) => option.value === String(day))?.label).join('、')

  if (!task) {
    return <div style={{ padding: 40, color: 'var(--text-muted)', textAlign: 'center' }}>任务不存在</div>
  }

  const updateSchedule = (patch) => setSchedule((s) => ({ ...s, ...patch }))

  const toggleWeekdayFilter = (day) => {
    setSchedule((current) => toggleWeekday(current, day))
  }

  const handleWeekdayPreset = (preset) => setSchedule((current) => selectWeekdayPreset(current, preset))

  const handleChannelToggle = (channelId) => {
    setNotifyChannels((prev) =>
      prev.includes(channelId) ? prev.filter((c) => c !== channelId) : [...prev, channelId]
    )
  }

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)
    try {
      await updateTask(taskId, {
        title: title.trim(),
        cron_expression: cronExpression,
        prompt_template: promptTemplate,
        notify_channels: notifyChannels,
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      console.error('Failed to save task:', e)
    } finally {
      setSaving(false)
    }
  }

  const saveTitle = async () => {
    if (titleCommitInProgress.current || titleEditCancelled.current) return
    const nextTitle = title.trim()
    if (!nextTitle) {
      setTitleError('任务标题不能为空')
      return
    }
    if (nextTitle === (task.title || '')) {
      setIsTitleEditing(false)
      setTitleError('')
      return
    }
    titleCommitInProgress.current = true
    setTitleError('')
    try {
      await updateTask(taskId, { title: nextTitle })
      setIsTitleEditing(false)
    } catch (error) {
      setTitleError(error.message || '重命名失败，请重试')
    } finally {
      titleCommitInProgress.current = false
    }
  }

  const handleToggleEnabled = async () => {
    try { await updateTask(taskId, { enabled: !task.enabled }) }
    catch (error) { showAlert(error.message || '更新定时任务失败，请重试') }
  }

  const handleRunNow = async () => {
    const changed = title.trim() !== task.title || cronExpression !== buildCron(parseCron(task.cron_expression))
      || promptTemplate !== task.prompt_template
      || JSON.stringify(notifyChannels) !== JSON.stringify(task.notify_channels || [])
    if (changed) {
      showAlert('请先保存修改，再立即执行')
      return
    }
    try { await runTask(taskId) }
    catch (error) { showAlert(error.message || '启动任务失败，请重试') }
  }

  const handleDelete = async () => {
    const confirmed = await showConfirm(
      `确定要删除任务「${task.title || '未命名任务'}」吗？\n\n这将同时删除该任务的所有执行记录，此操作不可撤销。`,
      '删除定时任务', { danger: true },
    )
    if (confirmed) {
      try { await deleteTask(taskId) }
      catch (error) { showAlert(error.message || '删除失败，请重试') }
    }
  }

  const handleExecutionClick = async (execution) => {
    if (execution.work_id) {
      const msgs = useWorksStore.getState().messages[execution.work_id]
      if (!msgs) {
        try {
          const res = await backendFetch(`/works/${execution.work_id}`)
          const data = await res.json()
          useWorksStore.setState((s) => ({
            messages: { ...s.messages, [execution.work_id]: data.messages },
          }))
        } catch (e) {
          console.error('[TaskConfigView] Failed to load work messages:', e)
        }
      }
      useWorksStore.getState().loadWorks()
      useWorksStore.setState({ activeWorkId: execution.work_id })
      useScheduledTasksStore.setState({ activeTaskId: null })
    }
  }

  return (
    <div style={containerStyle}>
      <div style={scrollAreaStyle}>
        {/* Header */}
        <div style={headerStyle}>
          <div style={titleGroupStyle}>
            {isTitleEditing ? (
              <>
                <input
                  aria-label="编辑任务标题"
                  aria-invalid={!!titleError}
                  autoFocus
                  value={title}
                  onChange={(e) => { setTitle(e.target.value); setTitleError('') }}
                  onBlur={() => { void saveTitle() }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                      event.preventDefault()
                      void saveTitle()
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      titleEditCancelled.current = true
                      setTitle(task.title || '')
                      setIsTitleEditing(false)
                      setTitleError('')
                    }
                  }}
                  placeholder="未命名任务"
                  className="scheduled-task-title-input"
                />
                {titleError && <span className="scheduled-task-title-error" role="alert">{titleError}</span>}
              </>
            ) : (
              <>
                <h2 style={titleTextStyle}>{title || '未命名任务'}</h2>
                <button
                  type="button"
                  aria-label="编辑任务标题"
                  title="编辑任务标题"
                  onClick={() => {
                    titleEditCancelled.current = false
                    setTitleError('')
                    setIsTitleEditing(true)
                  }}
                  style={editTitleButtonStyle}
                >
                  <EditOutlined aria-hidden="true" />
                </button>
              </>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label style={toggleLabelStyle}>
              <AppSwitch checked={task.enabled} onChange={handleToggleEnabled} />
              {task.enabled ? '已启用' : '已禁用'}
            </label>
            <button type="button" data-app-button="action" disabled={running || saving}
              onClick={handleRunNow} title="按已保存的配置执行一次，不改变定时计划">
              {running ? '执行中…' : '立即执行'}
            </button>
            <button data-app-button="action" data-variant="danger" onClick={handleDelete} style={deleteBtnStyle}>删除</button>
          </div>
        </div>

        <div style={sectionStyle}>
          {/* Schedule — user-friendly */}
          <div style={fieldStyle}>
            <label style={labelStyle}>执行频率</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              {FREQUENCY_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  data-app-button="action"
                  aria-pressed={schedule.frequency === opt.value}
                  onClick={() => updateSchedule({ frequency: opt.value })}
                  style={presetBtnStyle}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {/* Conditional detail selectors */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {schedule.frequency === 'every_n_minutes' && (
                <label style={inlineLabel}>
                  间隔
                  <AppDropdownSelect ariaLabel="间隔分钟" value={schedule.minuteInterval} options={MINUTE_INTERVAL_OPTIONS.map(value => ({ value, label: value + " 分钟" }))} onChange={value => updateSchedule({ minuteInterval: value })} />
                </label>
              )}

              {schedule.frequency === 'weekly' && (
                <label style={inlineLabel}>
                  <AppDropdownSelect
                    ariaLabel="执行星期"
                    value={weeklyValue}
                    options={WEEKDAY_OPTIONS}
                    fallbackOption={{ value: weeklyValue, label: weeklyLabel }}
                    onChange={value => updateSchedule({ weekday: value, weekdays: [Number(value)], weekdayPreset: null })}
                  />
                </label>
              )}

              {(schedule.frequency === 'daily' || schedule.frequency === 'weekly') && (
                <>
                  <label style={inlineLabel}>
                    <AppDropdownSelect ariaLabel="执行小时" value={schedule.hour} options={HOUR_OPTIONS} onChange={value => updateSchedule({ hour: value })} />
                  </label>
                  <label style={inlineLabel}>
                    <AppDropdownSelect ariaLabel="执行分钟" value={schedule.minute} options={MINUTE_OPTIONS} onChange={value => updateSchedule({ minute: value })} />
                  </label>
                </>
              )}

              {schedule.frequency === 'hourly' && (
                <label style={inlineLabel}>
                  每小时的第
                  <AppDropdownSelect ariaLabel="执行分钟" value={schedule.minute} options={MINUTE_OPTIONS} onChange={value => updateSchedule({ minute: value })} />
                  分钟
                </label>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginTop: 12 }}>
              <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-secondary)', fontWeight: 600 }}>过滤日期</span>
              <div role="group" aria-label="过滤日期" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                {WEEKDAY_PRESETS.map((preset) => {
                  const selected = schedule.weekdayPreset === preset.value
                  return (
                    <button
                      key={preset.value}
                      type="button"
                      data-app-button="action"
                      aria-pressed={selected}
                      onClick={() => handleWeekdayPreset(preset.value)}
                      style={{
                        height: 30,
                        padding: '0 10px',
                        border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
                        borderRadius: 15,
                        background: selected ? 'var(--accent)' : 'var(--bg-secondary)',
                        color: selected ? '#fff' : 'var(--text-secondary)',
                        fontSize: 'var(--font-size-label)',
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      {preset.label}
                    </button>
                  )
                })}
                {WEEKDAY_FILTER_OPTIONS.map((option) => {
                  const selected = !schedule.weekdayPreset && (schedule.weekdays || ALL_WEEKDAYS).includes(option.value)
                  return (
                    <button
                      key={option.value}
                      type="button"
                      data-app-button="action"
                      aria-label={`周${option.label}`}
                      aria-pressed={selected}
                      onClick={() => toggleWeekdayFilter(option.value)}
                      style={{
                        width: 30,
                        height: 30,
                        padding: 0,
                        border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
                        borderRadius: '50%',
                        background: selected ? 'var(--accent)' : 'var(--bg-secondary)',
                        color: selected ? '#fff' : 'var(--text-secondary)',
                        fontSize: 'var(--font-size-label)',
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      {option.label}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Next runs preview */}
            <div style={hintStyle}>{nextRunsHint}</div>
          </div>

          {/* Task Description (was "提示词模板") */}
          <div style={fieldStyle}>
            <label style={labelStyle}>任务描述</label>
            <textarea
              value={promptTemplate}
              onChange={(e) => setPromptTemplate(e.target.value)}
              placeholder="描述你希望 AI 定时执行的任务内容，例如：帮我查看京东这个月的消费记录"
              rows={5}
              style={textareaStyle}
            />
          </div>

          {/* Notification Channels */}
          <div style={fieldStyle}>
            <label style={labelStyle}>通知通道</label>
            {enabledChannels.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {enabledChannels.map((ch) => (
                  <label key={ch.id} style={channelLabelStyle}>
                    <AppSwitch
                      checked={notifyChannels.includes(ch.id)}
                      onChange={() => handleChannelToggle(ch.id)}
                      aria-label={`通过${ch.label}发送通知`}
                    />
                    {ch.label}
                  </label>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 'var(--font-size-caption)', color: 'var(--text-muted)' }}>
                暂无可用通道，请在设置 → 通道中启用微信、QQ、企业微信或飞书
              </div>
            )}
          </div>

          {/* Save */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button data-app-button="action" onClick={handleSave} disabled={!canSave || saving} style={{ ...saveBtnStyle, opacity: canSave && !saving ? 1 : 0.5, cursor: canSave && !saving ? 'pointer' : 'not-allowed' }}>
              {saving ? '保存中...' : saved ? '已保存 ✓' : '保存'}
            </button>
          </div>
        </div>

        {/* Execution Records */}
        <div style={{ ...sectionStyle, marginTop: 24 }}>
          <h3 style={sectionTitleStyle}>执行记录</h3>
          {executions.length === 0 ? (
            <div style={emptyStateStyle}>
              <div style={{ marginBottom: 4 }}>暂无执行记录</div>
              <div style={{ fontSize: 'var(--font-size-caption)', color: 'var(--text-muted)' }}>{nextRunsHint}</div>
            </div>
          ) : (
            <ExecutionHistory key={taskId} executions={executions} onExecutionClick={handleExecutionClick} />
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ExecutionHistory — pagination and scrolling stay within the records card.
// ---------------------------------------------------------------------------

function ExecutionHistory({ executions, onExecutionClick }) {
  const [requestedPage, setRequestedPage] = useState(1)
  const listRef = useRef(null)
  const { items, page, pageCount, total, start, end } = getExecutionPage(executions, requestedPage)

  useEffect(() => {
    setRequestedPage(page)
    if (listRef.current) listRef.current.scrollTop = 0
  }, [page])

  return (
    <>
      <div
        ref={listRef}
        role="region"
        aria-label="执行记录列表"
        tabIndex={0}
        style={executionListStyle}
      >
        {items.map((execution) => (
          <ExecutionRow key={execution.id} execution={execution} onClick={() => onExecutionClick(execution)} />
        ))}
      </div>
      <nav aria-label="执行记录分页" style={executionPaginationStyle}>
        <span style={{ color: 'var(--text-muted)', marginRight: 'auto' }}>
          共 {total} 条 · 每页 10 条 · 当前 {start}–{end} 条
        </span>
        <button type="button" data-app-button="action" disabled={page === 1} onClick={() => setRequestedPage(page - 1)}>
          上一页
        </button>
        <span aria-live="polite" style={{ color: 'var(--text-secondary)' }}>第 {page} / {pageCount} 页</span>
        <button type="button" data-app-button="action" disabled={page === pageCount} onClick={() => setRequestedPage(page + 1)}>
          下一页
        </button>
      </nav>
    </>
  )
}

// ---------------------------------------------------------------------------
// ExecutionRow
// ---------------------------------------------------------------------------

function ExecutionRow({ execution, onClick }) {
  const [hovered, setHovered] = useState(false)
  const statusColor = STATUS_COLORS[execution.status] || '#9ca3af'

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center', flexWrap: 'wrap', flexShrink: 0, gap: 10, padding: '8px 10px', borderRadius: 6,
        cursor: execution.work_id ? 'pointer' : 'default',
        background: hovered ? 'var(--bg-hover, rgba(255,255,255,0.05))' : 'transparent',
        transition: 'background 0.1s',
      }}
    >
      <span style={{ fontSize: 'var(--font-size-caption)', fontWeight: 600, color: statusColor, background: `${statusColor}18`, padding: '2px 8px', borderRadius: 4, flexShrink: 0 }}>
        {STATUS_LABELS[execution.status] || execution.status}
      </span>
      {execution.status === 'completed' && execution.error_message && (
        <span
          title={execution.error_message}
          style={{ fontSize: 'var(--font-size-caption)', fontWeight: 600, color: '#ef4444', flexShrink: 0 }}
        >
          通知失败
        </span>
      )}
      <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-secondary)', flex: 1 }}>{formatTime(execution.started_at)}</span>
      <span style={{ fontSize: 'var(--font-size-caption)', color: 'var(--text-muted)' }}>{execution.completed_at ? formatTime(execution.completed_at) : ''}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const containerStyle = { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }
const scrollAreaStyle = { flex: 1, overflowY: 'auto', padding: '24px 32px' }
const headerStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }
const titleGroupStyle = { display: 'flex', minWidth: 0, flex: 1, alignItems: 'center', gap: 5 }
const titleTextStyle = { minWidth: 0, overflow: 'hidden', margin: 0, color: 'var(--text-primary)', fontSize: 'var(--font-size-title)', fontWeight: 600, textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const editTitleButtonStyle = { display: 'inline-flex', width: 24, height: 28, flex: '0 0 24px', alignItems: 'center', justifyContent: 'center', padding: 0, border: 0, borderRadius: 4, background: 'transparent', color: 'var(--text-muted)', fontSize: 13, cursor: 'pointer' }
const sectionStyle = { background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 10, padding: 16 }
const sectionTitleStyle = { margin: '0 0 12px 0', fontSize: 'var(--font-size-subtitle)', fontWeight: 600, color: 'var(--text-primary)' }
const executionListStyle = { display: 'flex', flexDirection: 'column', gap: 2, height: 'min(360px, 45vh)', overflowY: 'auto', overscrollBehaviorY: 'contain', scrollbarGutter: 'stable' }
const executionPaginationStyle = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, paddingTop: 12, marginTop: 12, borderTop: '1px solid var(--border)', fontSize: 'var(--font-size-caption)' }
const fieldStyle = { marginBottom: 14 }
const labelStyle = { display: 'block', fontSize: 'var(--font-size-label)', color: 'var(--text-secondary)', marginBottom: 5, fontWeight: 600 }
const inputStyle = { width: '100%', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--text-primary)', fontSize: 'var(--font-size-body)', padding: '7px 10px', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box' }
const textareaStyle = { ...inputStyle, resize: 'vertical', minHeight: 80, lineHeight: 1.5 }
const presetBtnStyle = { border: '1px solid var(--border)', borderRadius: 6, padding: '4px 12px', fontSize: 'var(--font-size-label)', cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.15s' }
const inlineLabel = { display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-size-label)', color: 'var(--text-secondary)' }
const toggleLabelStyle = { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 'var(--font-size-label)', color: 'var(--text-secondary)' }
const channelLabelStyle = { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 'var(--font-size-label)', color: 'var(--text-secondary)' }
const saveBtnStyle = { border: 'none', borderRadius: 7, color: '#fff', padding: '8px 20px', fontSize: 'var(--font-size-body)', fontWeight: 600, background: 'var(--accent)', fontFamily: 'inherit' }
const deleteBtnStyle = { border: '1px solid var(--error, #ef4444)', borderRadius: 7, color: 'var(--error, #ef4444)', background: 'transparent', padding: '5px 14px', fontSize: 'var(--font-size-label)', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' }
const hintStyle = { fontSize: 'var(--font-size-caption)', color: 'var(--text-muted)', marginTop: 6 }
const emptyStateStyle = { padding: '20px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-caption)' }
