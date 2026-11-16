import React, { useId, useState } from 'react'
import { Brain, Check, Circle, CircleAlert, Globe, Pause } from 'lucide-react'
import ToolRunningIndicator from '../chat/ToolRunningIndicator.jsx'
import { ToolExecIcon, ToolRowChevron } from '../chat/ToolRowIcons.jsx'
import { ResourceImage } from './shared.jsx'
import ToolExecutionDetail, { ToolExecutionText } from '../chat/ToolExecutionDetail.jsx'

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

export default function ExplorationStep({ item }) {
  const observation = item.observation
  const hasObservation = observation && (observation.title || observation.url || observation.screenshot_url)
  const exception = typeof item.exception === 'string' ? item.exception : item.exception?.message
  return <article className="wx-step wx-chat-message wx-chat-assistant">
    <header className="wx-step-heading">
      <span className="wx-step-heading__icon" aria-hidden="true"><Brain size={16} strokeWidth={1.8} /></span>
      <h3>步骤 {item.step}</h3>
      <ExplorationStatus value={item.status} />
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
