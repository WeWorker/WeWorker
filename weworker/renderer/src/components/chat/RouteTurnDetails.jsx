import React, { useState } from 'react'

const STATUS = { answered: '快速路由已回答', fallback: '查询未完成，已转常规处理', missed: '常规处理', skipped: '本轮未尝试快速路由', incomplete: '路由诊断记录不完整' }
const PHASE = {
  route_skipped: '入口跳过', route_disabled: '路由关闭', route_config: '加载配置', route_plan: '规划候选',
  route_unmatched: '未命中', candidate_selected: '选中候选', candidate_skipped: '候选跳过',
  candidate_outcome: '候选结果', dispatch_start: '发起查询', dispatch_skipped: '未发起查询',
  dispatch_result: '查询返回', dispatch_failed: '查询失败', render_failed: '渲染失败',
  render_succeeded: '渲染成功', plan_skipped: '计划跳过', plan_failed: '计划失败',
  route_finished: '路由结束', route_failed: '路由失败', route_complete: '路由终态',
  turn_outcome: '整轮结果', route_attempt: '路由尝试', gate: '入口条件', candidate: '候选',
  dispatch: '调用', render: '渲染', handoff: '转常规处理',
}

/** Display only the backend allowlisted projection; never show raw events or error strings. */
export default function RouteTurnDetails({ turn, incomplete = false }) {
  const [open, setOpen] = useState(false)
  if (!turn?.events?.length) return null
  return (
    <div className="route-turn-details" style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }} onClick={event => event.stopPropagation()}>
      <span>{STATUS[turn.status] || STATUS.incomplete}</span>
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} style={{ marginLeft: 10, color: 'var(--text-secondary)', background: 'none', border: 0, cursor: 'pointer', font: 'inherit' }}>
        本轮处理详情 {open ? '收起' : '展开'}
      </button>
      {open && <div style={{ borderLeft: '1px solid var(--border)', margin: '7px 0 0 4px', paddingLeft: 10 }}>
        {turn.events.map((event, index) => <div key={index} style={{ marginBottom: 5 }}>
          {PHASE[event.phase] || '诊断阶段'}
          {event.layer && ` · ${event.layer}`}
          {event.reason && ` · ${event.reason}`}
          {event.category && ` · ${event.category}`}
          {event.tool && ` · ${event.tool}`}
          {event.source && ` · ${event.source}`}
          {event.fingerprint && ` · 配置 ${event.fingerprint}`}
          {event.durationMs != null && ` · ${event.durationMs} ms`}
          {event.fallback && ` · ${event.fallback === 'llm' || event.fallback === 'agent' ? '转常规处理' : event.fallback === 'none' ? '无需回退' : '回退受阻'}`}
        </div>)}
        {(incomplete || turn.status === 'incomplete') && <div>诊断记录不完整；无法确认未记录的阶段或常规处理结果。</div>}
      </div>}
    </div>
  )
}
