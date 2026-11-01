import React from 'react'
import { useScheduledTasksStore } from '../../store/scheduled-tasks.js'
import { useToolPackagePageStore } from '../../store/tool-package-page.js'
import { useExplorationPageStore } from '../../store/exploration-page.js'
import { leaveWebsiteExploration } from '../../store/website-exploration.js'
import AppSwitch from '../common/AppSwitch.jsx'
import { RenameIcon, TrashIcon } from '../icons/PanelIcons.jsx'
import Tooltip from '../Tooltip.jsx'
import { showConfirm } from '../../store/dialog.js'

/**
 * Simple frontend cron-to-summary conversion.
 * Covers common patterns; falls back to raw expression.
 */
function cronToSummary(expr) {
  if (!expr) return ''
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return expr

  const [minute, hour, dom, mon, dow] = parts

  // "0 * * * *" → 每小时
  if (minute === '0' && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return '每小时'
  }

  // "*/N * * * *" → 每 N 分钟
  const everyNMin = minute.match(/^\*\/(\d+)$/)
  if (everyNMin && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `每 ${everyNMin[1]} 分钟`
  }

  // "M H * * *" → 每天 HH:MM
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && dow === '*') {
    return `每天 ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
  }

  // "M H * * D" → 每周X HH:MM
  const weekdays = { '0': '日', '1': '一', '2': '二', '3': '三', '4': '四', '5': '五', '6': '六' }
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && /^\d$/.test(dow) && weekdays[dow]) {
    return `每周${weekdays[dow]} ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
  }

  return expr
}

export default function ScheduledTasksList() {
  const tasks = useScheduledTasksStore((s) => Array.isArray(s.tasks) ? s.tasks : [])
  const activeTaskId = useScheduledTasksStore((s) => s.activeTaskId)
  const selectTask = useScheduledTasksStore((s) => s.selectTask)
  const closeToolPackagePage = useToolPackagePageStore((s) => s.closePage)
  const closeExplorationPage = useExplorationPageStore((s) => s.closePage)

  if (!tasks.length) {
    return (
      <div style={{ padding: '12px', color: 'var(--text-muted)', fontSize: 12 }}>
        暂无定时任务
      </div>
    )
  }

  return (
    <div style={{ padding: '4px 0' }}>
      {tasks.map((t) => (
        <ScheduledTaskItem
          key={t.id}
          task={t}
          active={t.id === activeTaskId}
          onSelect={async () => {
            if (!await leaveWebsiteExploration()) return
            closeToolPackagePage()
            closeExplorationPage()
            selectTask(t.id)
          }}
        />
      ))}
    </div>
  )
}

function ScheduledTaskItem({ task, active, onSelect }) {
  const [draftTitle, setDraftTitle] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const pending = React.useRef(false)
  const cancelled = React.useRef(false)
  const updateTask = useScheduledTasksStore((s) => s.updateTask)
  const deleteTask = useScheduledTasksStore((s) => s.deleteTask)
  const title = task.title || '未命名任务'

  const saveTitle = async () => {
    if (draftTitle === null || pending.current || cancelled.current) return
    const nextTitle = draftTitle.trim()
    if (!nextTitle) { setError('任务名称不能为空'); return }
    if (nextTitle === task.title) { setDraftTitle(null); setError(''); return }
    pending.current = true
    setBusy(true)
    setError('')
    try {
      await updateTask(task.id, { title: nextTitle })
      setDraftTitle(null)
    } catch (err) {
      setError(err.message || '重命名失败，请重试')
    } finally { pending.current = false; setBusy(false) }
  }

  const remove = async () => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      const confirmed = await showConfirm(`确定要删除任务「${title}」吗？\n\n这将同时删除该任务的所有执行记录，此操作不可撤销。`, '删除定时任务', { danger: true })
      if (confirmed) await deleteTask(task.id)
    } catch (err) {
      setError(err.message || '删除失败，请重试')
    } finally { pending.current = false; setBusy(false) }
  }

  const toggleEnabled = async (event) => {
    if (pending.current || draftTitle !== null) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      await updateTask(task.id, { enabled: event.target.checked })
    } catch (err) {
      setError(err.message || '切换定时任务状态失败，请重试')
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  return (
    <div
      className={`scheduled-task-item sidebar-detail-item${active ? ' is-active' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`选择定时任务 ${title}`}
      aria-current={active ? 'true' : undefined}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          onSelect()
        }
      }}
    >
      {/* Enabled/disabled status dot */}
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: task.enabled ? '#22c55e' : '#9ca3af',
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, overflow: 'hidden', minWidth: 0 }}>
        {draftTitle !== null ? (
          <input
            autoFocus
            aria-label="编辑定时任务名称"
            aria-invalid={error ? 'true' : undefined}
            value={draftTitle}
            disabled={busy}
            onFocus={(event) => event.target.select()}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => { setDraftTitle(event.target.value); setError('') }}
            onBlur={saveTitle}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void saveTitle() }
              if (event.key === 'Escape') { event.preventDefault(); cancelled.current = true; setDraftTitle(null); setError('') }
            }}
            style={{ width: '100%', minWidth: 0, boxSizing: 'border-box', font: 'inherit', fontSize: 12, padding: '1px 3px', color: 'var(--text-primary)', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 4 }}
          />
        ) : <span
          style={{
            fontSize: 12,
            lineHeight: '18px',
            display: 'block',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
          }}
        >
          {title}
        </span>}
        <span
          style={{
            fontSize: 10,
            lineHeight: '15px',
            color: 'var(--text-muted)',
            display: 'block',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {cronToSummary(task.cron_expression)}
        </span>
        {error && <span role="alert" style={{ display: 'block', fontSize: 11, color: 'var(--error, #ef4444)' }}>{error}</span>}
      </div>
      <div className="sidebar-row-actions" style={{ opacity: draftTitle !== null ? 0 : undefined, pointerEvents: draftTitle !== null ? 'none' : undefined }} onClick={(event) => event.stopPropagation()}>
        <AppSwitch
          className="app-switch--sidebar"
          checked={Boolean(task.enabled)}
          disabled={busy || draftTitle !== null}
          onChange={toggleEnabled}
          aria-label={`${task.enabled ? '关闭' : '启用'}定时任务 ${title}`}
          title={task.enabled ? '关闭定时任务' : '启用定时任务'}
        />
        <Tooltip text="重命名">
          <button type="button" className="sidebar-row-action" aria-label={`重命名定时任务 ${title}`} disabled={busy || draftTitle !== null}
            onClick={() => { cancelled.current = false; setError(''); setDraftTitle(task.title || '') }}>
            <RenameIcon size={13} />
          </button>
        </Tooltip>
        <Tooltip text="删除">
          <button type="button" className="sidebar-row-action" aria-label={`删除定时任务 ${title}`} disabled={busy || draftTitle !== null} onClick={remove}>
            <TrashIcon size={13} />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
