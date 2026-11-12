import React, { useEffect, useRef, useState } from 'react'
import { showConfirm } from '../../store/dialog.js'
import { codeBadgeStyle } from '../dedicated-agents/styles.js'

export function WecomPairingGuide({ config }) {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const paired = !!config.owner_user_id
  const command = config.pairing_code ? `绑定 ${config.pairing_code}` : ''
  useEffect(() => { setCopied(false); setError('') }, [command, paired])

  return <section className={`wecom-pairing-guide${paired ? ' is-paired' : ''}`} aria-label="主人绑定引导">
    <div className="wecom-pairing-guide__title" role={paired ? 'status' : undefined}>
      {paired ? '主人已绑定' : '最后一步：绑定主人'}
    </div>
    {paired ? <div className="wecom-pairing-guide__hint">现在可以在企业微信中与机器人对话。</div> : <>
      <div className="wecom-pairing-guide__instruction">在<strong>企业微信</strong>中找到这个机器人，私聊发送下面这句话：</div>
      {command ? <div className="wecom-pairing-guide__command">
        <span className="wecom-pairing-code" style={codeBadgeStyle}>{command}</span>
        <button data-app-button="action" type="button" className="settings-btn settings-btn-secondary" onClick={async () => {
          try { await navigator.clipboard.writeText(command); setCopied(true); setError('') }
          catch { setError('复制失败，请选中绑定指令手动复制') }
        }}>{copied ? '已复制' : '复制'}</button>
      </div> : <div className="wecom-pairing-guide__hint">正在生成绑定码…</div>}
      <div className="wecom-pairing-guide__hint" role="status">等待绑定，完成后此处会自动更新。</div>
    </>}
    {error && <div role="alert" className="wecom-owner-binding__error">{error}</div>}
  </section>
}

export default function WecomOwnerBinding({ profileId, config, active, disabled = false, onAction, onRefresh, onBusyChange, confirm = showConfirm }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const callbacks = useRef({ onAction, onRefresh, onBusyChange })
  callbacks.current = { onAction, onRefresh, onBusyChange }
  const mounted = useRef(true)
  const pending = useRef(false)
  const ready = active && config.enabled && config.bot_id && config.has_secret && !disabled
  const paired = !!config.owner_user_id
  const command = config.pairing_code ? `绑定 ${config.pairing_code}` : ''

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { callbacks.current.onBusyChange?.(busy); return () => callbacks.current.onBusyChange?.(false) }, [busy])

  const request = async action => {
    if (pending.current || !mounted.current) return
    pending.current = true
    setBusy(true)
    setError('')
    try { await callbacks.current.onAction(action) }
    catch (e) { if (mounted.current) setError(e.message || '绑定操作失败，请重试') }
    finally { pending.current = false; if (mounted.current) setBusy(false) }
  }

  useEffect(() => {
    if (!ready || paired) return
    if (!config.pairing_code) { void request('pair'); return }
    let cancelled = false
    let timer
    const poll = async () => {
      try { await callbacks.current.onRefresh(); if (!cancelled) setError('') }
      catch { if (!cancelled) setError('绑定状态刷新失败，正在重试…') }
      if (!cancelled) timer = setTimeout(poll, 2000)
    }
    timer = setTimeout(poll, 2000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [profileId, config.bot_id, config.pairing_code, ready, paired])

  const rePair = async () => {
    if (await confirm('当前主人将失效，权限恢复为问答权限，需要重新发送新的绑定码。', '重新绑定主人')) {
      await request('re-pair')
    }
  }

  return <div className="channel-settings-field wecom-owner-binding">
    <div className="channel-settings-field__label">主人绑定</div>
    <div className="channel-settings-field__control">
      <div className="wecom-owner-binding__status">
        <span role="status" className={paired ? 'is-paired' : ''}>{paired ? '已绑定' : '未绑定'}</span>
        {paired && <button type="button" className="wecom-owner-binding__action" disabled={!ready || busy} onClick={rePair}>重新绑定</button>}
        {!paired && ready && <button type="button" className="wecom-owner-binding__action" disabled={busy} onClick={() => request(command ? 're-pair' : 'pair')}>{command ? '更换绑定码' : '生成绑定码'}</button>}
      </div>
      {!paired && <div className="wecom-owner-binding__hint">
        {!ready ? '请先保存并启用机器人。' : command ? <>在企业微信中输入「<span className="wecom-pairing-code">{command}</span>」完成绑定。</> : busy ? '正在生成绑定码…' : '尚未生成绑定码。'}
      </div>}
      {error && <div role="alert" className="wecom-owner-binding__error">{error}</div>}
    </div>
  </div>
}
