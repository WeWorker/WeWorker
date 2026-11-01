import { useEffect, useRef, useState } from 'react'
import { ApiOutlined, CheckOutlined, CloseOutlined, CopyOutlined, DisconnectOutlined, DownOutlined, LinkOutlined, LoadingOutlined, MinusOutlined, UpOutlined } from '@ant-design/icons'
import { channelProbeConfig, requestChannelProbe } from '../../utils/channel-probe.js'

export function useChannelProbe(forms, savedChannels) {
  const [states, setStates] = useState({})
  const active = useRef({})
  const mounted = useRef(true)
  const fingerprints = Object.fromEntries(Object.entries(forms).map(([id, form]) => [id, JSON.stringify([channelProbeConfig(id, form), savedChannels?.[id]])]))
  const current = useRef(fingerprints)
  current.current = fingerprints
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      Object.values(active.current).forEach(item => item.controller.abort())
      active.current = {}
    }
  }, [])
  useEffect(() => {
    for (const [id, item] of Object.entries(active.current)) {
      if (item.fingerprint !== current.current[id]) {
        item.controller.abort()
        delete active.current[id]
      }
    }
  }, [JSON.stringify(fingerprints)])
  const update = (id, patch) => setStates(previous => ({ ...previous, [id]: { ...previous[id], ...patch } }))
  const run = async id => {
    if (active.current[id]) return
    const fingerprint = current.current[id]
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    const item = { fingerprint, controller }
    active.current[id] = item
    update(id, { fingerprint, running: true, expanded: true, logs: false, ok: false, checks: [{ target: 'platform', label: '配置与平台验证', status: 'running', message: '正在检查凭证和平台连接…' }] })
    const isCurrent = () => mounted.current && active.current[id] === item && current.current[id] === fingerprint
    try {
      const result = await requestChannelProbe(id, forms[id], controller.signal)
      if (isCurrent()) update(id, { ...result, running: false })
    } catch (error) {
      if (isCurrent()) update(id, { running: false, ok: false, checks: [{ target: 'platform', label: '平台验证', status: 'failure', message: controller.signal.aborted ? '检测超时，请稍后重试' : error instanceof TypeError ? '无法连接后端，请确认 WeWorker 已启动' : error.message }] })
    } finally {
      clearTimeout(timer)
      if (active.current[id] === item) delete active.current[id]
    }
  }
  return { run, update, get: id => states[id]?.fingerprint === fingerprints[id] ? states[id] : undefined }
}

export function ChannelProbeButton({ state, disabled, onClick }) {
  const failed = state?.checks?.some(check => check.status === 'failure')
  return <button data-app-button="action" type="button" className={`settings-btn settings-btn-secondary channel-probe-button${state?.ok ? ' is-success' : failed ? ' is-error' : ''}`}
    disabled={disabled || state?.running} onClick={onClick}>
    {state?.running ? <LoadingOutlined spin /> : state?.ok ? <LinkOutlined /> : failed ? <DisconnectOutlined /> : <ApiOutlined />}
    {state?.running ? '检测中…' : '测试连通性'}
  </button>
}

export function ChannelProbeChecklist({ state, onChange }) {
  if (!state) return null
  const failed = state.checks.some(check => check.status === 'failure')
  return <section className="model-probe-checklist channel-probe-checklist" aria-label="通道连通性检查" aria-live="polite">
    <button type="button" className="model-probe-checklist__toggle" aria-expanded={state.expanded} onClick={() => onChange({ expanded: !state.expanded })}>
      <span>连通性检查<span className={`model-probe-checklist__summary${state.ok ? ' is-success' : failed ? ' is-error' : ''}`}>
        {state.running ? '正在检查…' : state.ok ? `全部通过 · ${state.duration_ms}ms` : failed ? '检查未通过' : '尚未验证'}
      </span></span><span>{state.expanded ? <UpOutlined /> : <DownOutlined />}</span>
    </button>
    {state.expanded && <>
      <div className="model-probe-checklist__items" role="list">
        {state.checks.map(check => <div key={check.target} className={`model-probe-checklist__item is-${check.status}`} role="listitem">
          <span className="model-probe-checklist__status" aria-hidden="true">{check.status === 'running' ? <LoadingOutlined spin /> : check.status === 'success' ? <CheckOutlined /> : check.status === 'failure' ? <CloseOutlined /> : <MinusOutlined />}</span>
          <span className="model-probe-checklist__content"><span className="model-probe-checklist__label">{check.label}{check.duration_ms !== undefined && ` · ${check.duration_ms}ms`}</span>
            <span className={`model-probe-checklist__message${state.logs ? ' is-expanded' : ''}`} title={check.message}>{check.message}</span>
          </span>
        </div>)}
      </div>
      <div className="model-probe-checklist__footer">
        <button type="button" className="model-probe-checklist__copy" aria-label="复制检查日志" onClick={() => { void navigator.clipboard?.writeText(state.checks.map(check => `${check.label}: ${check.message}`).join('\n')).catch(() => {}) }}><CopyOutlined /></button>
        <button type="button" className="model-probe-checklist__logs-toggle" aria-expanded={state.logs} onClick={() => onChange({ logs: !state.logs })}>
          {state.logs ? <UpOutlined /> : <DownOutlined />}{state.logs ? '收起日志' : '展开日志'}
        </button>
      </div>
    </>}
  </section>
}
