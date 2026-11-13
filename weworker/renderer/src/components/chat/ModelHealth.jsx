import React from 'react'
import { DisconnectOutlined, LinkOutlined, LoadingOutlined, QuestionCircleOutlined, ReloadOutlined } from '@ant-design/icons'

export function ModelHealthIndicator({ model, result, busy, disabled, onCheck, protocolLabel = '会话协议' }) {
  const state = result ? (result.ok ? 'success' : 'failure') : 'unknown'
  const time = result ? new Date(result.checkedAt).toLocaleString() : ''
  const title = result
    ? `上次检测：${time} · ${result.ok ? `${protocolLabel}可用` : '检测未通过'} · 请求总耗时 ${result.elapsedMs}ms${busy ? ' · 正在重新检测' : ''}`
    : busy ? `正在检测${protocolLabel}` : '尚未检测'
  const content = <>
    {busy ? <LoadingOutlined spin /> : result ? (result.ok ? <LinkOutlined /> : <DisconnectOutlined />) : <QuestionCircleOutlined />}
    <span>{busy ? '检测中' : result ? (result.ok ? `${result.elapsedMs}ms` : '不可用') : '未检测'}</span>
  </>
  return onCheck ? <button type="button" className={`model-health model-health-action is-${state}`}
    title="点击仅检测此模型" aria-label={`检测模型 ${model}`} aria-busy={Boolean(busy)}
    disabled={busy || disabled} onClick={onCheck}>{content}</button>
    : <span className={`model-health is-${state}`} title={title} aria-label={title}>{content}</span>
}

export function ModelHealthToolbar({ running, disabled, onCheck, protocolLabel = '会话协议' }) {
  return <div className="model-health-toolbar">
    <span>{running ? `正在检测${protocolLabel}…` : '上次检测结果'}</span>
    <button type="button" className="model-health-refresh" aria-label="检测全部模型"
      title="检测全部模型（真实请求，可能产生费用）" disabled={running || disabled} onClick={onCheck}>
      {running ? <LoadingOutlined spin /> : <ReloadOutlined />}
    </button>
  </div>
}
