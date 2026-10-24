import React, { useCallback, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Alert, Button, Input, Space } from 'antd'
import { LoadingOutlined } from '@ant-design/icons'
import { pollWecomQr, pollWeixinQr, startWecomQr, startWeixinQr } from '../../api/dedicated-agents-api.js'
import { hintStyle, labelStyle, qrBoxStyle } from './styles.js'

const POLL_INTERVAL_MS = 3000

const CHANNEL_COPY = {
  wecom: {
    start: startWecomQr,
    poll: pollWecomQr,
    title: '用企业微信扫一扫',
    qrLabel: '企业微信扫码二维码',
    steps: ['打开手机企业微信，扫描左侧二维码', '选择「创建机器人」，或选择一个已有的机器人授权', '确认后这里会自动进入下一步'],
    note: '一个机器人只能连接一个 Agent。建议为每个专属 Agent 单独创建一个机器人，并起一个好认的名字。',
    success: (botId) => `已获取机器人（BotID：${botId}）`,
  },
  weixin: {
    start: startWeixinQr,
    poll: pollWeixinQr,
    title: '用微信扫一扫',
    qrLabel: '微信扫码二维码',
    steps: ['打开手机微信，扫描左侧二维码', '在手机上确认登录，微信里会出现这个机器人', '确认后这里会自动进入下一步'],
    note: '一个微信机器人只能连接一个 Agent 或「设置 → 通道 → 微信」。建议为每个专属 Agent 使用不同的微信号扫码。',
    success: (botId) => (botId ? `已获取微信机器人（${botId}）` : '已获取微信机器人'),
  },
}

/**
 * Scan to bind a bot for a dedicated agent.
 * - 企业微信: create a new AI bot or authorize an existing one; manual BotID/Secret also works.
 * - 微信: log in an iLink bot with the WeChat app.
 * Calls onBound({ channel, qr_session_id, bot_id }) after a successful scan, or
 * onBound({ channel: 'wecom', bot_id, secret }) for manual WeCom credentials.
 * Scanned secrets and tokens never reach the renderer.
 */
export default function WecomQrBind({ onBound, busy = false, autoStart = true, channel = 'wecom' }) {
  const copy = CHANNEL_COPY[channel] || CHANNEL_COPY.wecom
  const [state, setState] = useState('idle') // idle | loading | waiting | scanned | success | expired | error
  const [message, setMessage] = useState('')
  const [qrUrl, setQrUrl] = useState('')
  const [manualOpen, setManualOpen] = useState(false)
  const [manual, setManual] = useState({ bot_id: '', secret: '' })
  const canvasRef = useRef(null)
  const timerRef = useRef(null)
  const expireRef = useRef(null)
  const mountedRef = useRef(true)
  const onBoundRef = useRef(onBound)
  onBoundRef.current = onBound

  const stop = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current)
    if (expireRef.current) clearTimeout(expireRef.current)
    timerRef.current = null
    expireRef.current = null
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      stop()
    }
  }, [stop])

  const showQr = state === 'waiting' || state === 'scanned'
  useEffect(() => {
    if (!qrUrl || !canvasRef.current) return
    QRCode.toCanvas(canvasRef.current, qrUrl, { width: 196, margin: 1 }, (error) => {
      if (error) console.error('[dedicated-agents] QR render error:', error)
    })
  }, [qrUrl, showQr])

  const start = useCallback(async () => {
    stop()
    setState('loading')
    setMessage('')
    setQrUrl('')
    try {
      const session = await copy.start()
      if (!mountedRef.current) return
      setQrUrl(session.qr_url)
      setState('waiting')
      expireRef.current = setTimeout(() => {
        stop()
        if (!mountedRef.current) return
        setState('expired')
        setQrUrl('')
      }, (session.expires_in || 300) * 1000)
      timerRef.current = setInterval(async () => {
        try {
          const result = await copy.poll(session.session_id)
          if (!mountedRef.current) return
          if (result.status === 'success') {
            stop()
            setState('success')
            setQrUrl('')
            setMessage(copy.success(result.bot_id))
            onBoundRef.current?.({ channel, qr_session_id: session.session_id, bot_id: result.bot_id })
          } else if (result.status === 'expired') {
            stop()
            setState('expired')
            setQrUrl('')
          } else if (result.status === 'scanned') {
            setState('scanned')
          }
        } catch {
          // Keep polling through transient failures.
        }
      }, POLL_INTERVAL_MS)
    } catch (error) {
      if (!mountedRef.current) return
      setState('error')
      setMessage(error.message || '获取二维码失败')
    }
  }, [stop, copy, channel])

  useEffect(() => {
    if (autoStart) start()
    // Start once on mount; the parent remounts this component to switch channels.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const submitManual = () => {
    const bot_id = manual.bot_id.trim()
    const secret = manual.secret.trim()
    if (!bot_id || !secret) {
      setMessage('请同时填写 BotID 和 Secret')
      setState('error')
      return
    }
    stop()
    onBoundRef.current?.({ channel: 'wecom', bot_id, secret })
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ ...qrBoxStyle, width: 220, height: 220, alignItems: 'center', justifyContent: 'center' }}>
          {showQr && qrUrl && <canvas ref={canvasRef} aria-label={copy.qrLabel} />}
          {state === 'loading' && <LoadingOutlined style={{ fontSize: 28, color: '#999' }} />}
          {(state === 'expired' || state === 'error' || state === 'idle') && (
            <Button data-app-button="action" onClick={start}>{state === 'idle' ? '获取二维码' : '刷新二维码'}</Button>
          )}
          {state === 'success' && <span style={{ color: '#16a34a', fontSize: 40 }} aria-label="扫码成功">✓</span>}
        </div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
            {state === 'success' ? '扫码成功' : state === 'scanned' ? '已扫码，请在手机上确认' : copy.title}
          </div>
          <ol style={{ ...hintStyle, paddingLeft: 18, margin: '0 0 12px' }}>
            {copy.steps.map((step) => <li key={step}>{step}</li>)}
          </ol>
          <div style={hintStyle}>{copy.note}</div>
          {state === 'expired' && <div style={{ ...hintStyle, color: 'var(--warning, #f59e0b)', marginTop: 8 }}>二维码已过期，请刷新后重新扫码。</div>}
          {message && (
            <div style={{ ...hintStyle, marginTop: 8, color: state === 'error' ? 'var(--error, #ef4444)' : 'var(--success, #22c55e)' }}>{message}</div>
          )}
          {busy && <div style={{ ...hintStyle, marginTop: 8 }}><LoadingOutlined /> 正在保存…</div>}
        </div>
      </div>

      {channel === 'wecom' && (
        <div style={{ marginTop: 16 }}>
          <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setManualOpen((value) => !value)} aria-expanded={manualOpen}>
            {manualOpen ? '收起手动填写' : '扫码不方便？手动填写 BotID 和 Secret'}
          </Button>
          {manualOpen && (
            <div style={{ marginTop: 10, maxWidth: 420 }}>
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 10 }}
                message="在企业微信「工作台 → 智能机器人」中创建 API 模式机器人，选择「通过长连接配置」后可获取 BotID 和 Secret。"
              />
              <label style={labelStyle} htmlFor="agent-bot-id">BotID</label>
              <Input id="agent-bot-id" value={manual.bot_id} onChange={(event) => setManual((value) => ({ ...value, bot_id: event.target.value }))} placeholder="智能机器人 BotID" style={{ marginBottom: 10 }} />
              <label style={labelStyle} htmlFor="agent-bot-secret">Secret</label>
              <Input.Password id="agent-bot-secret" value={manual.secret} onChange={(event) => setManual((value) => ({ ...value, secret: event.target.value }))} placeholder="长连接 Secret" style={{ marginBottom: 10 }} autoComplete="off" />
              <Space>
                <Button data-app-button="action" type="primary" onClick={submitManual} disabled={busy}>使用这个机器人</Button>
              </Space>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** 企业微信 / 微信 switch shown above the QR code. */
export function BotChannelPicker({ value, onChange, disabled = false }) {
  return (
    <div role="radiogroup" aria-label="机器人类型" style={{ display: 'inline-flex', gap: 4, padding: 3, borderRadius: 8, background: 'var(--bg-secondary)', marginBottom: 14 }}>
      {[['wecom', '企业微信'], ['weixin', '微信']].map(([key, label]) => {
        const active = value === key
        return (
          <button data-app-button="action"
            key={key}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(key)}
            style={{
              border: 'none', borderRadius: 6, padding: '5px 14px', fontSize: 13, fontFamily: 'inherit', cursor: disabled ? 'not-allowed' : 'pointer',
              background: active ? 'var(--bg-primary)' : 'transparent',
              color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontWeight: active ? 600 : 400,
            }}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}
