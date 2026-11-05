import { showDedicatedAgentsPage } from '../../store/dedicated-agents.js'
import { isAgentChannelKey, summarizeAgentChannels } from '../../utils/dedicated-agents.js'
import React, { useState } from 'react'
import { useStatusStore } from '../../store/status.js'
import { useSettingsStore } from '../../store/settings.js'
import ExtensionGuide from '../ExtensionGuide.jsx'
import StatusAlerts from './StatusAlerts.jsx'
import { buildStatusAlerts } from '../../utils/status-alerts.js'

export default function StatusBar() {
  const { extension, extensionVersion, channels } = useStatusStore()
  const { model, hasApiKey } = useSettingsStore()
  const [showGuide, setShowGuide] = useState(false)

  // Check version mismatch between app and extension
  const [appVersion, setAppVersion] = useState('')
  React.useEffect(() => {
    window.electronAPI?.getVersion?.().then(v => setAppVersion(v || ''))
  }, [])

  // Detect bridge port conflict (port 3711 held by another process at startup).
  // Polled from the Electron main process — backend does not know about this.
  const [bridgeStatus, setBridgeStatus] = useState('unknown')
  const [backendStatus, setBackendStatus] = useState('unknown')
  React.useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const s = await window.electronAPI?.getStatus?.()
        if (!cancelled) {
          if (s?.bridge) setBridgeStatus(s.bridge)
          if (s?.python) setBackendStatus(s.python)
        }
      } catch {}
    }
    poll()
    const id = setInterval(poll, 3000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])
  const externalBackendRunning = backendStatus === 'external_running'
  const isWindows = navigator.userAgent.includes('Windows')
  const alerts = buildStatusAlerts({ extension, appVersion, extensionVersion, bridgeStatus, backendStatus, channels, isWindows })

  const dot = (status) => {
    const color = status === 'connected' ? 'var(--success)'
      : status === 'unknown' ? 'var(--warning)'
      : 'var(--error)'
    return <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: color, marginRight: 4, flexShrink: 0 }} />
  }

  const channelDot = (status) => {
    const color = status === 'connected' ? 'var(--success)'
      : status === 'starting' ? 'var(--warning)'
      : status === 'error' ? 'var(--error)'
      : 'var(--text-muted)'
    return <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: color, marginRight: 4, flexShrink: 0 }} />
  }

  const CHANNEL_NAMES = { qq: 'QQ', weixin: '微信', wecom: '企业微信', feishu: '飞书' }
  const agentChannels = summarizeAgentChannels(channels)
  const STATUS_TEXT = { connected: '已连接', starting: '连接中', error: '错误' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {/* Current model */}
      <div style={{ fontSize: 11, color: hasApiKey ? 'var(--text-secondary)' : 'var(--warning)', display: 'flex', alignItems: 'center', gap: 4 }}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <rect x="2" y="3" width="20" height="14" rx="2"/>
          <path d="M8 21h8M12 17v4"/>
        </svg>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>
          {hasApiKey ? (model || '未设置模型') : '未配置 API Key'}
        </span>
      </div>
      {/* Extension status */}
      <span style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 2 }}>
        {dot(extension)}扩展{extension === 'connected' ? '已连接' : '未连接'}
        <StatusAlerts alerts={alerts} onOpenGuide={() => setShowGuide(true)} />
      </span>
      {showGuide && <ExtensionGuide onClose={() => setShowGuide(false)} />}
      {externalBackendRunning && (
        <span
          title="当前使用单独启动的 backend-ts 开发服务"
          style={{ fontSize: 10, color: 'var(--success)', display: 'flex', alignItems: 'center', gap: 3, lineHeight: 1.3 }}
        >
          <span>●</span>
          <span>后端：外部开发服务</span>
        </span>
      )}
      {/* Channel statuses (dedicated agent bots are summarized in one line) */}
      {agentChannels.total > 0 && (
        <button
          type="button"
          onClick={showDedicatedAgentsPage}
          title={agentChannels.errors ? `${agentChannels.errors} 个WeWorker Bot 连接异常` : undefined}
          style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', padding: 0, border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit', alignSelf: 'flex-start' }}
        >
          {channelDot(agentChannels.errors ? 'error' : agentChannels.connected === agentChannels.total ? 'connected' : 'starting')}
          WeWorker Bot {agentChannels.connected}/{agentChannels.total} 在线
        </button>
      )}
      {Object.entries(channels).filter(([name]) => !isAgentChannelKey(name)).map(([name, info]) => (
        <span
          key={name}
          title={info.error ? `${CHANNEL_NAMES[name] || name}: ${info.error}` : undefined}
          style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center' }}
        >
          {channelDot(info.status)}
          {CHANNEL_NAMES[name] || name} {STATUS_TEXT[info.status] || info.status}
        </span>
      ))}
    </div>
  )
}
