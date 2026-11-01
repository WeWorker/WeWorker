import AppSwitch from '../common/AppSwitch.jsx'
import AppDropdownSelect from '../common/AppDropdownSelect.jsx'
import React, { useState, useEffect, useMemo } from 'react'
import { useScheduledTasksStore } from '../../store/scheduled-tasks.js'
import { useWorksStore } from '../../store/works.js'
import { useSettingsStore } from '../../store/settings.js'
import { backendFetch } from '../../api/http.js'
import { showAlert, showConfirm } from '../../store/dialog.js'

// ---------------------------------------------------------------------------
// Schedule helpers — convert between user-friendly fields and cron expression
// ---------------------------------------------------------------------------

const FREQUENCY_OPTIONS = [
  { value: 'every_n_minutes', label: '每隔 N 分钟' },
  { value: 'hourly', label: '每小时' },
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
]

const WEEKDAY_OPTIONS = [
  { value: '1', label: '周一' },
  { value: '2', label: '周二' },
  { value: '3', label: '周三' },
  { value: '4', label: '周四' },
  { value: '5', label: '周五' },
  { value: '6', label: '周六' },
  { value: '0', label: '周日' },
]

const MINUTE_INTERVAL_OPTIONS = [5, 10, 15, 20, 30]

/** Build cron expression from user-friendly fields */
function buildCron({ frequency, hour, minute, weekday, minuteInterval }) {
  switch (frequency) {
    case 'every_n_minutes':
      return `*/${minuteInterval || 30} * * * *`
    case 'hourly':
      return `${minute || 0} * * * *`
    case 'daily':
      return `${minute ?? 0} ${hour ?? 9} * * *`
    case 'weekly':
      return `${minute ?? 0} ${hour ?? 9} * * ${weekday ?? 1}`
    default:
      return '0 * * * *'
  }
}

/** Parse cron expression into user-friendly fields */
function parseCron(expr) {
  if (!expr) return { frequency: 'daily', hour: 9, minute: 0, weekday: '1', minuteInterval: 30 }
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return { frequency: 'daily', hour: 9, minute: 0, weekday: '1', minuteInterval: 30 }

  const [min, hr, , , dow] = parts

  // */N * * * * → every N minutes
  const everyN = min.match(/^\*\/(\d+)$/)
  if (everyN && hr === '*' && dow === '*') {
    return { frequency: 'every_n_minutes', hour: 9, minute: 0, weekday: '1', minuteInterval: parseInt(everyN[1], 10) }
  }

  // M * * * * → hourly at :M
  if (/^\d+$/.test(min) && hr === '*' && dow === '*') {
    return { frequency: 'hourly', hour: 9, minute: parseInt(min, 10), weekday: '1', minuteInterval: 30 }
  }

  // M H * * D → weekly
  if (/^\d+$/.test(min) && /^\d+$/.test(hr) && /^\d$/.test(dow)) {
    return { frequency: 'weekly', hour: parseInt(hr, 10), minute: parseInt(min, 10), weekday: dow, minuteInterval: 30 }
  }

  // M H * * * → daily
  if (/^\d+$/.test(min) && /^\d+$/.test(hr) && dow === '*') {
    return { frequency: 'daily', hour: parseInt(hr, 10), minute: parseInt(min, 10), weekday: '1', minuteInterval: 30 }
  }

  return { frequency: 'daily', hour: 9, minute: 0, weekday: '1', minuteInterval: 30 }
}

/** Compute the next N execution times from schedule fields */
function getNextRuns({ frequency, hour, minute, weekday, minuteInterval }, count = 3) {
  const now = new Date()
  const runs = []

  if (frequency === 'every_n_minutes') {
    const interval = (minuteInterval || 30) * 60 * 1000
    // Next aligned interval from the top of the hour
    const msIntoHour = now.getMinutes() * 60000 + now.getSeconds() * 1000 + now.getMilliseconds()
    const nextAligned = new Date(now.getTime() - msIntoHour + Math.ceil(msIntoHour / interval) * interval)
    for (let i = 0; i < count; i++) {
      runs.push(new Date(nextAligned.getTime() + i * interval))
    }
  } else if (frequency === 'hourly') {
    const m = minute || 0
    const candidate = new Date(now)
    candidate.setMinutes(m, 0, 0)
    if (candidate <= now) candidate.setHours(candidate.getHours() + 1)
    for (let i = 0; i < count; i++) {
      runs.push(new Date(candidate))
      candidate.setHours(candidate.getHours() + 1)
    }
  } else if (frequency === 'daily') {
    const h = hour ?? 9, m = minute || 0
    const candidate = new Date(now)
    candidate.setHours(h, m, 0, 0)
    if (candidate <= now) candidate.setDate(candidate.getDate() + 1)
    for (let i = 0; i < count; i++) {
      runs.push(new Date(candidate))
      candidate.setDate(candidate.getDate() + 1)
    }
  } else if (frequency === 'weekly') {
    const h = hour ?? 9, m = minute ?? 0, dow = parseInt(weekday ?? '1', 10)
    const candidate = new Date(now)
    candidate.setHours(h, m, 0, 0)
    // Advance to next matching weekday
    let diff = (dow - candidate.getDay() + 7) % 7
    if (diff === 0 && candidate <= now) diff = 7
    candidate.setDate(candidate.getDate() + diff)
    for (let i = 0; i < count; i++) {
      runs.push(new Date(candidate))
      candidate.setDate(candidate.getDate() + 7)
    }
  }

  return runs
}

/** Format next runs as a hint string */
function nextRunsSummary(schedule) {
  const runs = getNextRuns(schedule, 3)
  if (runs.length === 0) return ''
  const fmt = (d) => d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  return `接下来执行: ${runs.map(fmt).join('、')}`
}

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
  const selectWork = useWorksStore((s) => s.selectWork)
  const channels = useSettingsStore((s) => s.channels)

  const task = tasks.find((t) => t.id === taskId)

  // Form state
  const [title, setTitle] = useState('')
  const [schedule, setSchedule] = useState({ frequency: 'daily', hour: 9, minute: 0, weekday: '1', minuteInterval: 30 })
  const [promptTemplate, setPromptTemplate] = useState('')
  const [notifyChannels, setNotifyChannels] = useState([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  // Sync form state when task changes
  useEffect(() => {
    if (!task) return
    setSchedule(parseCron(task.cron_expression))
    setPromptTemplate(task.prompt_template || '')
    setNotifyChannels(task.notify_channels || [])
  }, [task?.id])

  // A sidebar rename must update the title without resetting other unsaved fields.
  useEffect(() => { setTitle(task?.title || '') }, [task?.id, task?.title])

  const cronExpression = useMemo(() => buildCron(schedule), [schedule])
  const nextRunsHint = useMemo(() => nextRunsSummary(schedule), [schedule])
  const enabledChannels = useMemo(() => getEnabledChannels(channels), [channels])
  const canSave = title.trim() && promptTemplate.trim()

  if (!task) {
    return <div style={{ padding: 40, color: 'var(--text-muted)', textAlign: 'center' }}>任务不存在</div>
  }

  const updateSchedule = (patch) => setSchedule((s) => ({ ...s, ...patch }))

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

  const handleToggleEnabled = async () => {
    try { await updateTask(taskId, { enabled: !task.enabled }) }
    catch (error) { showAlert(error.message || '更新定时任务失败，请重试') }
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
          <h2 style={titleStyle}>任务配置</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label style={toggleLabelStyle}>
              <AppSwitch checked={task.enabled} onChange={handleToggleEnabled} />
              {task.enabled ? '已启用' : '已禁用'}
            </label>
            <button data-app-button="action" data-variant="danger" onClick={handleDelete} style={deleteBtnStyle}>删除</button>
          </div>
        </div>

        <div style={sectionStyle}>
          {/* Title */}
          <div style={fieldStyle}>
            <label style={labelStyle}>任务标题</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="输入任务标题" style={inputStyle} />
          </div>

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
                  <AppDropdownSelect ariaLabel="执行星期" value={schedule.weekday} options={WEEKDAY_OPTIONS} onChange={value => updateSchedule({ weekday: value })} />
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
                    <input type="checkbox" checked={notifyChannels.includes(ch.id)} onChange={() => handleChannelToggle(ch.id)} style={checkboxStyle} />
                    {ch.label}
                  </label>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
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
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{nextRunsHint}</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {executions.map((exec) => (
                <ExecutionRow key={exec.id} execution={exec} onClick={() => handleExecutionClick(exec)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
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
        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 6,
        cursor: execution.work_id ? 'pointer' : 'default',
        background: hovered ? 'var(--bg-hover, rgba(255,255,255,0.05))' : 'transparent',
        transition: 'background 0.1s',
      }}
    >
      <span style={{ fontSize: 11, fontWeight: 600, color: statusColor, background: `${statusColor}18`, padding: '2px 8px', borderRadius: 4, flexShrink: 0 }}>
        {STATUS_LABELS[execution.status] || execution.status}
      </span>
      <span style={{ fontSize: 12, color: 'var(--text-secondary)', flex: 1 }}>{formatTime(execution.started_at)}</span>
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{execution.completed_at ? formatTime(execution.completed_at) : ''}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const containerStyle = { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }
const scrollAreaStyle = { flex: 1, overflowY: 'auto', padding: '24px 32px' }
const headerStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }
const titleStyle = { margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' }
const sectionStyle = { background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 10, padding: 16 }
const sectionTitleStyle = { margin: '0 0 12px 0', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }
const fieldStyle = { marginBottom: 14 }
const labelStyle = { display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 5, fontWeight: 600 }
const inputStyle = { width: '100%', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--text-primary)', fontSize: 13, padding: '7px 10px', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box' }
const textareaStyle = { ...inputStyle, resize: 'vertical', minHeight: 80, lineHeight: 1.5 }
const presetBtnStyle = { border: '1px solid var(--border)', borderRadius: 6, padding: '4px 12px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.15s' }
const inlineLabel = { display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text-secondary)' }
const toggleLabelStyle = { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12, color: 'var(--text-secondary)' }
const checkboxStyle = { accentColor: 'var(--accent)', width: 14, height: 14 }
const channelLabelStyle = { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12, color: 'var(--text-secondary)' }
const saveBtnStyle = { border: 'none', borderRadius: 7, color: '#fff', padding: '8px 20px', fontSize: 13, fontWeight: 600, background: 'var(--accent)', fontFamily: 'inherit' }
const deleteBtnStyle = { border: '1px solid var(--error, #ef4444)', borderRadius: 7, color: 'var(--error, #ef4444)', background: 'transparent', padding: '5px 14px', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' }
const hintStyle = { fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }
const emptyStateStyle = { padding: '20px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }
