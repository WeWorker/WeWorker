import React, { useEffect, useId, useRef, useState } from 'react'
import { Brain, Check, Circle, CircleAlert, Globe, Pause } from 'lucide-react'
import ToolRunningIndicator from '../chat/ToolRunningIndicator.jsx'
import { ToolExecIcon, ToolRowChevron } from '../chat/ToolRowIcons.jsx'
import { ResourceImage } from './shared.jsx'
import ToolExecutionDetail, { ToolExecutionText } from '../chat/ToolExecutionDetail.jsx'

const ACTIVE_EXPLORATION_STATUSES = new Set(['queued', 'starting', 'starting_browser', 'running', 'cancel_requested'])

const statuses = {
  ok: ['已完成', 'success'], succeeded: ['已完成', 'success'], done: ['已完成', 'success'],
  error: ['执行失败', 'error'], failed: ['失败', 'error'],
  running: ['执行中', 'running'], starting: ['启动中', 'running'], starting_browser: ['启动浏览器', 'running'],
  queued: ['排队中', 'idle'], pending: ['等待中', 'idle'],
  paused: ['已暂停', 'paused'], waiting_for_user: ['等待你处理', 'paused'],
  cancelled: ['已停止', 'idle'], stopped: ['已停止', 'idle'],
  cancel_requested: ['正在停止', 'running'], stopping: ['正在停止', 'running'],
  unknown: ['已记录', 'idle'],
}

export function formatElapsedDuration(seconds) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0))
  if (safe < 60) return `${safe}s`
  const minutes = Math.floor(safe / 60)
  const remainder = safe % 60
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`
}

function resolveLivePhase(status, activity) {
  if (activity?.phase) return activity.phase
  if (status === 'queued') return 'queued'
  if (status === 'starting_browser') return 'starting_browser'
  if (status === 'starting') return 'starting'
  if (status === 'cancel_requested') return 'stopping'
  return 'thinking'
}

function describeLiveActivity(phase, activity, timeline) {
  const lastStep = [...timeline].reverse().find(item => item?.type === 'agent_step')
  const activityStep = Number(activity?.step || 0)
  const nextStep = activityStep > 0 ? activityStep : (lastStep?.step ? Number(lastStep.step) + 1 : 0)
  const reason = activity?.reason || ''
  switch (phase) {
    case 'queued': return '探索任务排队中…'
    case 'starting_browser': return '正在启动浏览器环境…'
    case 'starting': return '正在启动探索服务…'
    case 'initial_observation': return '正在读取当前页面状态…'
    case 'compacting': return '历史记录较长，正在整理上下文…'
    case 'stopping': return '正在停止探索…'
    case 'action_pending':
    case 'action_running':
      return activityStep > 0 ? `正在浏览器中执行第 ${activityStep} 步…` : '正在浏览器中执行操作…'
    case 'thinking':
      if (reason === 'recovering_from_error' || (!reason && lastStep?.status === 'error')) {
        return '上一步执行失败，正在分析原因并调整方案…'
      }
      if (reason === 'retrying_format') return '正在整理下一步操作格式…'
      if (reason === 'self_reflection') return '正在复核探索结果…'
      return nextStep > 0 ? `正在分析页面并规划第 ${nextStep} 步…` : '正在分析页面并规划下一步…'
    default:
      return '正在继续探索…'
  }
}

function slowActivityHint(phase, elapsedSeconds) {
  if ((phase === 'thinking' || phase === 'compacting') && elapsedSeconds >= 30) {
    return '模型响应较慢，仍在等待返回；如长时间无变化可点击停止探索。'
  }
  if ((phase === 'action_running' || phase === 'initial_observation') && elapsedSeconds >= 25) {
    return '页面操作耗时较长，仍在等待浏览器响应…'
  }
  return ''
}

export function ExplorationStatus({ value }) {
  const [label, tone] = statuses[value] || [value || '已记录', 'idle']
  const Icon = tone === 'success' ? Check : tone === 'error' ? CircleAlert : tone === 'paused' ? Pause : Circle
  return <span className={`wx-exploration-status wx-exploration-status--${tone}`}>
    {tone === 'running' ? <ToolRunningIndicator size={13} /> : <Icon size={13} strokeWidth={1.8} aria-hidden="true" />}
    <span>{label}</span>
  </span>
}

export function ExplorationDisclosure({ label, icon, summary, children }) {
  const [open, setOpen] = useState(false)
  const contentId = useId()
  return <div className={'wx-step-disclosure' + (open ? ' is-open' : '')}>
    <button type="button" className="tool-row-header wx-step-disclosure__trigger" aria-expanded={open} aria-controls={contentId} onClick={() => setOpen(value => !value)}>
      <span className="tool-row-header__icon" aria-hidden="true">{icon}</span>
      <span className="wx-step-disclosure__label">{label}</span>
      {summary && <span className="wx-step-disclosure__summary" title={summary}>{summary}</span>}
      <span className="tool-row-header__chevron" aria-hidden="true"><ToolRowChevron expanded={open} /></span>
    </button>
    <ToolExecutionDetail id={contentId} hidden={!open} className="wx-step-disclosure__content">
      {open && children}
    </ToolExecutionDetail>
  </div>
}

export default function ExplorationStep({ item, elapsed = '' }) {
  const observation = item.observation
  const hasObservation = observation && (observation.title || observation.url || observation.screenshot_url)
  const exception = typeof item.exception === 'string' ? item.exception : item.exception?.message
  return <article className="wx-step wx-chat-message wx-chat-assistant">
    <header className="wx-step-heading">
      <span className="wx-step-heading__icon" aria-hidden="true"><Brain size={16} strokeWidth={1.8} /></span>
      <h3>步骤 {item.step}</h3>
      <ExplorationStatus value={item.status} />
      {elapsed && <span className="wx-step-elapsed">{elapsed}</span>}
    </header>
    {item.thought && <p className="wx-step-thought">{item.thought}</p>}
    <div className="wx-step-tools">
      {item.code && <ExplorationDisclosure label="执行动作" icon={<ToolExecIcon />}><ToolExecutionText>{item.code}</ToolExecutionText></ExplorationDisclosure>}
      {hasObservation && <ExplorationDisclosure label="页面结果" summary={observation.title} icon={<Globe size={14} strokeWidth={1.7} aria-hidden="true" />}>
        {observation.url && <p className="wx-url">{observation.url}</p>}
        <ResourceImage path={observation.screenshot_url} alt={observation.title || '执行后页面'} />
      </ExplorationDisclosure>}
    </div>
    {exception && <div className="wx-step-error" role="alert"><CircleAlert size={15} aria-hidden="true" /><p>{exception}</p></div>}
  </article>
}

export function ExplorationLiveActivity({ status, activity, timeline = [], now }) {
  const active = ACTIVE_EXPLORATION_STATUSES.has(status)
  const phase = active ? resolveLivePhase(status, activity) : ''
  const stepNumber = Number(activity?.step || 0)
  const reason = activity?.reason || ''
  const serverUpdatedAt = Number(activity?.updated_at_ms || 0)
  const activityKey = `${status}:${phase}:${stepNumber}:${reason}:${serverUpdatedAt}`
  const fallbackStartRef = useRef({ key: '', startedAt: typeof now === 'number' ? now : Date.now() })
  if (fallbackStartRef.current.key !== activityKey) {
    fallbackStartRef.current = { key: activityKey, startedAt: typeof now === 'number' ? now : Date.now() }
  }
  const [tickNow, setTickNow] = useState(() => (typeof now === 'number' ? now : Date.now()))
  useEffect(() => {
    if (!active || typeof now === 'number') return
    setTickNow(Date.now())
    const timer = setInterval(() => setTickNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active, activityKey, now])

  if (!active) return null

  const currentNow = typeof now === 'number' ? now : tickNow
  const baseTimestamp = serverUpdatedAt > 0 ? serverUpdatedAt : fallbackStartRef.current.startedAt
  const elapsedSeconds = Math.max(0, Math.floor((currentNow - baseTimestamp) / 1000))
  const elapsedLabel = formatElapsedDuration(elapsedSeconds)
  const hint = slowActivityHint(phase, elapsedSeconds)

  const timelineHasStep = stepNumber > 0 && timeline.some(
    item => item?.type === 'agent_step' && Number(item.step) === stepNumber
  )

  if ((phase === 'action_pending' || phase === 'action_running') && stepNumber > 0 && !timelineHasStep) {
    return <div className="wx-live-step-wrap" role="status" aria-live="polite">
      <ExplorationStep
        item={{
          step: stepNumber,
          status: 'running',
          thought: activity?.thought || '',
          code: activity?.code || '',
          observation: {},
        }}
        elapsed={`已耗时 ${elapsedLabel}`}
      />
      {hint && <p className="wx-live-activity__hint wx-live-activity__hint--indented">{hint}</p>}
    </div>
  }

  const label = describeLiveActivity(phase, activity, timeline)
  return <div className="wx-live-activity wx-chat-message wx-chat-assistant" role="status" aria-live="polite">
    <div className="wx-live-activity__row">
      <ToolRunningIndicator size={14} />
      <span className="wx-live-activity__label">{label}</span>
      <span className="wx-live-activity__elapsed">已耗时 {elapsedLabel}</span>
    </div>
    {hint && <p className="wx-live-activity__hint">{hint}</p>}
  </div>
}
