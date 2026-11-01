import React, { useEffect, useRef, useState } from 'react'
import { QrcodeOutlined, LoadingOutlined } from '@ant-design/icons'
import QRCode from 'qrcode'
import { backendFetch } from '../../api/http.js'
import { requestBotQr } from '../../utils/wecom-qr-request.js'

export default function WecomQrConnect({ channel = 'wecom', onImport, onBusyChange, disabled = false }) {
  const name = { wecom: '企业微信', qq: 'QQ', feishu: '飞书' }[channel]
  const [state, setState] = useState({ status: 'idle', message: '', image: '' })
  const runRef = useRef(null)
  const onImportRef = useRef(onImport)
  onImportRef.current = onImport
  const busy = state.status === 'loading' || state.status === 'waiting' || state.status === 'saving'

  const cancelRun = () => {
    const run = runRef.current
    runRef.current = null
    if (!run) return
    clearTimeout(run.timer)
    if (run.id) void backendFetch(`/settings/${channel}/qr-cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: run.id }),
    }).catch(() => {})
  }
  useEffect(() => () => cancelRun(), [])
  useEffect(() => { onBusyChange?.(busy) }, [busy, onBusyChange])

  const start = async () => {
    cancelRun()
    const run = { id: '', timer: null }
    runRef.current = run
    setState({ status: 'loading', message: '正在获取二维码…', image: '' })
    const request = (action, body) => requestBotQr(channel, action, body)
    try {
      const data = await request('start')
      run.id = data.session_id
      if (runRef.current !== run) { void request('cancel', { session_id: run.id }).catch(() => {}); return }
      const image = await QRCode.toDataURL(data.qrcode_url, { width: 200, margin: 2 })
      if (runRef.current !== run) return
      setState({ status: 'waiting', image, message: channel === 'qq' ? '使用 QQ 扫码，选择机器人并确认绑定；新用户可先点击下方创建入口' : `使用${name}扫码，在手机上确认创建机器人` })
      const poll = async () => {
        if (runRef.current !== run) return
        try {
          if (Date.now() >= data.expires_at) {
            cancelRun(); setState({ status: 'expired', image: '', message: '二维码已过期，请重新获取' }); return
          }
          const result = await request('poll', { session_id: run.id })
          if (runRef.current !== run) return
          if (result.status === 'confirmed') {
            const credentials = channel === 'wecom' ? { bot_id: result.bot_id, secret: result.secret } : { app_id: result.app_id, app_secret: result.app_secret }
            if (Object.values(credentials).some(value => !value)) throw new Error('未获取完整配置，请重新扫码')
            setState({ status: 'saving', image: '', message: '扫码已完成，正在保存配置…' })
            try {
              await onImportRef.current(credentials)
            } catch {
              // The settings store retains the import and shows a save-retry action.
              if (runRef.current !== run) return
              cancelRun()
              setState({ status: 'idle', image: '', message: '' })
              return
            }
            if (runRef.current !== run) return
            cancelRun()
            setState({ status: 'confirmed', image: '', message: '机器人已关联并保存，可切换页面。主人 ID 可通过 /myid 获取。' })
          } else if (result.status === 'expired') {
            cancelRun(); setState({ status: 'expired', image: '', message: '二维码已过期，请重新获取' })
          } else if (result.status === 'error') {
            throw new Error(result.message || '扫码失败，请重新获取二维码')
          } else run.timer = setTimeout(poll, result.poll_interval_ms || data.poll_interval_ms || 3000)
        } catch (error) {
          if (runRef.current !== run) return
          cancelRun(); setState({ status: 'error', image: '', message: error.message || '获取扫码结果失败，请重新扫码或手动填写' })
        }
      }
      run.timer = setTimeout(poll, data.poll_interval_ms || 3000)
    } catch (error) {
      if (runRef.current !== run) return
      cancelRun(); setState({ status: 'error', image: '', message: error.message || '获取二维码失败，请重新尝试' })
    }
  }

  return <div className="wecom-qr-connect">
    <div className="wecom-qr-connect__actions">
      <button data-app-button="action" type="button" className="settings-btn settings-btn-secondary" onClick={start} disabled={busy || disabled}>
        {state.status === 'loading' ? <LoadingOutlined spin aria-hidden="true" /> : <QrcodeOutlined aria-hidden="true" />} {state.status === 'expired' || state.status === 'error' ? '重新获取二维码' : channel === 'qq' ? '扫码绑定机器人' : '扫码创建机器人'}
      </button>
      {busy && state.status !== 'saving' && <button data-app-button="action" type="button" className="settings-btn settings-btn-secondary" onClick={() => { cancelRun(); setState({ status: 'idle', message: '', image: '' }) }}>取消扫码</button>}
      {!state.message && <span>扫码确认后自动保存并启用，也可在下方手动填写</span>}
    </div>
    {channel === 'qq' && <p>还没有机器人？<a href="https://q.qq.com/qqbot/openclaw/login.html" target="_blank" rel="noreferrer">扫码创建 QQ 机器人</a>，完成后返回这里扫码绑定。</p>}
    {state.image && <img width="200" height="200" src={state.image} alt={`${name}机器人二维码`} />}
    {state.message && <p role="status" className={state.status === 'error' ? 'is-error' : state.status === 'confirmed' ? 'is-success' : ''}>{state.message}</p>}
  </div>
}
