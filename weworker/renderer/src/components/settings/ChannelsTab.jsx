import React, { useState, useRef, useCallback, useEffect } from 'react'
import QRCode from 'qrcode'
import { useSettingsStore } from '../../store/settings.js'
import { normalizeOwnerUserId, validateOwnerUserId } from '../../utils/owner-user-id.js'
import { backendFetch } from '../../api/http.js'

const API = 'http://127.0.0.1:8765'

const OWNER_PERMISSION_OPTIONS = [
  { value: 'qa_only', label: '问答权限', hint: '仅可进行知识问答，与访客权限相同' },
  { value: 'no_bash', label: '禁用原生命令', hint: '可使用标准技能和文件工具，不能执行适配器或其他本地命令' },
  { value: 'full', label: '完全权限', hint: '包含命令行与全部智能体能力' },
]

export default function ChannelsTab() {
  const { channels, saveChannels } = useSettingsStore()
  const qq = channels?.qq ?? {}
  const weixin = channels?.weixin ?? {}

  const [form, setForm] = useState({
    enabled: qq.enabled ?? false,
    app_id: qq.app_id ?? '',
    app_secret: '',
    owner_user_id: qq.owner_user_id ?? '',
    owner_permission_level: qq.owner_permission_level ?? 'full',
  })
  const [wxForm, setWxForm] = useState({
    enabled: weixin.enabled ?? false,
    base_url: weixin.base_url ?? '',
    owner_user_id: weixin.owner_user_id ?? '',
    owner_permission_level: weixin.owner_permission_level ?? 'full',
  })
  const wecom = channels?.wecom ?? {}
  const [wecomForm, setWecomForm] = useState({
    enabled: wecom.enabled ?? false,
    bot_id: wecom.bot_id ?? '',
    secret: '',
    owner_user_id: wecom.owner_user_id ?? '',
    owner_permission_level: wecom.owner_permission_level ?? 'full',
  })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveMessage, setSaveMessage] = useState(null)
  const [ownerIdErrors, setOwnerIdErrors] = useState({ qq: '', weixin: '', wecom: '' })

  // WeChat QR login state
  const [qrData, setQrData] = useState(null) // raw URL content to encode as QR
  const [qrStatus, setQrStatus] = useState('') // '' | 'loading' | 'waiting' | 'scaned' | 'confirmed' | 'expired' | 'error'
  const [qrMsg, setQrMsg] = useState('')
  const pollRef = useRef(null)
  const canvasRef = useRef(null)

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  useEffect(() => {
    setForm((current) => ({
      ...current,
      enabled: qq.enabled ?? false,
      app_id: qq.app_id ?? '',
      owner_user_id: qq.owner_user_id ?? '',
      owner_permission_level: qq.owner_permission_level ?? 'full',
    }))
    setWxForm((current) => ({
      ...current,
      enabled: weixin.enabled ?? false,
      base_url: weixin.base_url ?? '',
      owner_user_id: weixin.owner_user_id ?? '',
      owner_permission_level: weixin.owner_permission_level ?? 'full',
    }))
    setWecomForm((current) => ({
      ...current,
      enabled: wecom.enabled ?? false,
      bot_id: wecom.bot_id ?? '',
      owner_user_id: wecom.owner_user_id ?? '',
      owner_permission_level: wecom.owner_permission_level ?? 'full',
    }))
  }, [qq.enabled, qq.app_id, qq.owner_user_id, qq.owner_permission_level, weixin.enabled, weixin.base_url, weixin.owner_user_id, weixin.owner_permission_level, wecom.enabled, wecom.bot_id, wecom.owner_user_id, wecom.owner_permission_level])

  // Render QR code to canvas when data changes
  useEffect(() => {
    if (qrData && canvasRef.current) {
      QRCode.toCanvas(canvasRef.current, qrData, { width: 200, margin: 2 }, (err) => {
        if (err) console.error('[weixin] QR render error:', err)
      })
    }
  }, [qrData])

  const startQrLogin = useCallback(async () => {
    stopPolling()
    setQrStatus('loading')
    setQrMsg('')
    setQrData(null)
    try {
      const res = await backendFetch(`${API}/settings/weixin/qr-start`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) { setQrStatus('error'); setQrMsg(data.detail || '获取二维码失败'); return }
      setQrData(data.qrcode_url)
      setQrStatus('waiting')
      setQrMsg('请使用微信扫描二维码')

      // Start polling
      pollRef.current = setInterval(async () => {
        try {
          const r = await backendFetch(`${API}/settings/weixin/qr-poll`, { method: 'POST' })
          const d = await r.json()
          if (d.status === 'confirmed') {
            stopPolling()
            setQrStatus('confirmed')
            setQrMsg(d.message)
            setQrData(null)
            setWxForm(f => ({ ...f, enabled: true }))
            // Reload channels
            useSettingsStore.getState().load()
          } else if (d.status === 'expired') {
            stopPolling()
            setQrStatus('expired')
            setQrMsg(d.message)
            setQrData(null)
          } else if (d.status === 'scaned') {
            setQrStatus('scaned')
            setQrMsg(d.message)
          }
        } catch {
          // ignore poll errors
        }
      }, 3000)
    } catch (e) {
      setQrStatus('error')
      setQrMsg(e.message || '网络错误')
    }
  }, [stopPolling])

  const handleSave = async () => {
    const nextErrors = {
      qq: validateOwnerUserId('qq', form.owner_user_id) || '',
      weixin: validateOwnerUserId('weixin', wxForm.owner_user_id) || '',
      wecom: validateOwnerUserId('wecom', wecomForm.owner_user_id) || '',
    }
    setOwnerIdErrors(nextErrors)
    const firstError = nextErrors.qq || nextErrors.weixin || nextErrors.wecom
    if (firstError) {
      setSaveMessage({ ok: false, text: firstError })
      return
    }

    setSaving(true)
    setSaveMessage(null)
    const payload = {
      qq: {
        enabled: form.enabled,
        app_id: form.app_id,
        owner_user_id: normalizeOwnerUserId(form.owner_user_id),
        owner_permission_level: normalizeOwnerUserId(form.owner_user_id) ? form.owner_permission_level : 'full',
      },
      weixin: {
        enabled: wxForm.enabled,
        base_url: wxForm.base_url,
        owner_user_id: normalizeOwnerUserId(wxForm.owner_user_id),
        owner_permission_level: normalizeOwnerUserId(wxForm.owner_user_id) ? wxForm.owner_permission_level : 'full',
      },
      wecom: {
        enabled: wecomForm.enabled,
        bot_id: wecomForm.bot_id,
        owner_user_id: normalizeOwnerUserId(wecomForm.owner_user_id),
        owner_permission_level: normalizeOwnerUserId(wecomForm.owner_user_id) ? wecomForm.owner_permission_level : 'full',
      },
    }
    if (form.app_secret) payload.qq.app_secret = form.app_secret
    if (wecomForm.secret) payload.wecom.secret = wecomForm.secret
    try {
      await saveChannels(payload)
      const configured = []
      if (payload.qq.owner_user_id) configured.push('QQ')
      if (payload.weixin.owner_user_id) configured.push('微信')
      if (payload.wecom.owner_user_id) configured.push('企业微信')
      setSaved(true)
      setSaveMessage({
        ok: true,
        text: configured.length
          ? `已保存。${configured.join('、')} 的主人 ID 已生效，下方权限级别对该 ID 生效。`
          : '已保存。未配置主人 ID 时，所有用户仅有问答权限。',
      })
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setSaveMessage({ ok: false, text: err.message || '保存失败' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      {/* QQ Bot Card */}
      <div className="settings-channel-card" style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>QQ</span>
          <label style={toggleLabelStyle}>
            <input type="checkbox" checked={form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))} style={checkboxStyle} />
            启用
          </label>
        </div>
        <Field label="AppID">
          <input className="settings-input" value={form.app_id} onChange={e => setForm(f => ({ ...f, app_id: e.target.value }))} placeholder="你的 AppID" />
        </Field>
        <Field label="AppSecret" hint={qq.has_app_secret ? '已设置（留空保持不变）' : '未设置'}>
          <input className="settings-input" type="password" value={form.app_secret} onChange={e => setForm(f => ({ ...f, app_secret: e.target.value }))} placeholder={qq.has_app_secret ? '••••••••••••' : '输入 AppSecret'} />
        </Field>
        <OwnerIdField
          channel="qq"
          label="主人 ID"
          hint="留空则所有用户仅有问答权限"
          value={form.owner_user_id}
          error={ownerIdErrors.qq}
          permissionLevel={form.owner_permission_level}
          onChange={(owner_user_id) => {
            setOwnerIdErrors((current) => ({ ...current, qq: '' }))
            setForm((f) => ({ ...f, owner_user_id }))
          }}
        />
        <OwnerPermissionLevelField
          name="qq-owner-permission-level"
          value={form.owner_permission_level}
          disabled={!form.owner_user_id.trim()}
          onChange={(owner_permission_level) => setForm((f) => ({ ...f, owner_permission_level }))}
        />
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
          在 <a href="https://q.qq.com/" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>QQ 开放平台</a> 创建频道机器人后获取凭证。
          用户在频道中 @ 机器人即可对话，发送 /new 开启新对话，发送 /myid 查看用户 ID。
          未配置主人 ID 时所有用户仅有问答权限；配置后可为主人选择权限级别。
        </div>
      </div>

      {/* WeChat Card */}
      <div className="settings-channel-card" style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>微信</span>
          <label style={toggleLabelStyle}>
            <input type="checkbox" checked={wxForm.enabled} onChange={e => setWxForm(f => ({ ...f, enabled: e.target.checked }))} style={checkboxStyle} />
            启用
          </label>
        </div>

        {/* Status indicator */}
        <div style={{ fontSize: 12, color: weixin.has_token ? '#22c55e' : 'var(--text-muted)', marginBottom: 10 }}>
          {weixin.has_token ? '✓ 已连接' : '未连接'}
        </div>

        {/* QR Login */}
        <div style={{ marginBottom: 12 }}>
          <button onClick={startQrLogin} disabled={qrStatus === 'loading' || qrStatus === 'waiting' || qrStatus === 'scaned'} style={{ ...btnSmallStyle, marginBottom: 8 }}>
            {qrStatus === 'loading' ? '获取中...' : weixin.has_token ? '重新扫码登录' : '扫码登录'}
          </button>

          {qrData && (
            <div style={{ textAlign: 'center', padding: 12, background: '#fff', borderRadius: 8, marginBottom: 8 }}>
              <canvas ref={canvasRef} />
            </div>
          )}

          {qrMsg && (
            <div style={{ fontSize: 12, color: qrStatus === 'confirmed' ? '#22c55e' : qrStatus === 'error' || qrStatus === 'expired' ? '#ef4444' : 'var(--text-secondary)', marginTop: 4 }}>
              {qrMsg}
            </div>
          )}
        </div>

        <OwnerIdField
          channel="weixin"
          label="主人 ID"
          hint="留空则所有用户仅有问答权限"
          value={wxForm.owner_user_id}
          error={ownerIdErrors.weixin}
          permissionLevel={wxForm.owner_permission_level}
          onChange={(owner_user_id) => {
            setOwnerIdErrors((current) => ({ ...current, weixin: '' }))
            setWxForm((f) => ({ ...f, owner_user_id }))
          }}
        />
        <OwnerPermissionLevelField
          name="weixin-owner-permission-level"
          value={wxForm.owner_permission_level}
          disabled={!wxForm.owner_user_id.trim()}
          onChange={(owner_permission_level) => setWxForm((f) => ({ ...f, owner_permission_level }))}
        />

        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          通过微信 ClawBot 插件连接。扫码后微信用户发消息给 ClawBot 即可与 WeWorker 对话，发送 /new 开启新对话，发送 /myid 查看用户 ID。
          未配置主人 ID 时所有用户仅有问答权限；配置后可为主人选择权限级别。
        </div>
      </div>

      {/* WeCom Card */}
      <div className="settings-channel-card" style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>企业微信</span>
          <label style={toggleLabelStyle}>
            <input type="checkbox" checked={wecomForm.enabled} onChange={e => setWecomForm(f => ({ ...f, enabled: e.target.checked }))} style={checkboxStyle} />
            启用
          </label>
        </div>
        <Field label="BotID">
          <input className="settings-input" value={wecomForm.bot_id} onChange={e => setWecomForm(f => ({ ...f, bot_id: e.target.value }))} placeholder="智能机器人 BotID" />
        </Field>
        <Field label="Secret" hint={wecom.has_secret ? '已设置（留空保持不变）' : '未设置'}>
          <input className="settings-input" type="password" value={wecomForm.secret} onChange={e => setWecomForm(f => ({ ...f, secret: e.target.value }))} placeholder={wecom.has_secret ? '••••••••••••' : '输入长连接专用 Secret'} />
        </Field>
        <OwnerIdField
          channel="wecom"
          label="主人 ID"
          hint="留空则所有用户仅有问答权限"
          value={wecomForm.owner_user_id}
          error={ownerIdErrors.wecom}
          permissionLevel={wecomForm.owner_permission_level}
          onChange={(owner_user_id) => {
            setOwnerIdErrors((current) => ({ ...current, wecom: '' }))
            setWecomForm((f) => ({ ...f, owner_user_id }))
          }}
        />
        <OwnerPermissionLevelField
          name="wecom-owner-permission-level"
          value={wecomForm.owner_permission_level}
          disabled={!wecomForm.owner_user_id.trim()}
          onChange={(owner_permission_level) => setWecomForm((f) => ({ ...f, owner_permission_level }))}
        />
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
          在 <a href="https://work.weixin.qq.com/" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>企业微信管理后台</a> 创建智能机器人，开启长连接 API 模式后获取 BotID 和 Secret。
          用户在企业微信中 @ 机器人或私聊即可对话，发送 /new 开启新对话，发送 /myid 查看用户 ID。
          未配置主人 ID 时所有用户仅有问答权限；配置后可为主人选择权限级别。
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, gap: 12 }}>
        {saveMessage && (
          <div style={{ fontSize: 12, color: saveMessage.ok ? 'var(--success, #22c55e)' : 'var(--error, #ef4444)', flex: 1 }}>
            {saveMessage.text}
          </div>
        )}
        <button onClick={handleSave} disabled={saving} style={{ ...btnStyle, marginLeft: 'auto' }}>
          {saving ? '保存中...' : saved ? '已保存 ✓' : '保存'}
        </button>
      </div>
    </div>
  )
}

function OwnerIdField({ channel, label, hint, value, error, permissionLevel, onChange }) {
  const trimmed = normalizeOwnerUserId(value)
  const validationError = error || validateOwnerUserId(channel, value)
  const configured = trimmed && !validationError
  const permissionLabel = OWNER_PERMISSION_OPTIONS.find((option) => option.value === permissionLevel)?.label || '完全权限'

  return (
    <Field label={label} hint={hint}>
      <input
        className="settings-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="发送 /myid 获取你的用户 ID"
        style={validationError && trimmed ? { borderColor: 'var(--error, #ef4444)' } : undefined}
      />
      {validationError && trimmed && (
        <div style={{ fontSize: 11, color: 'var(--error, #ef4444)', marginTop: 6 }}>{validationError}</div>
      )}
      {configured && (
        <div style={{ fontSize: 11, color: 'var(--success, #22c55e)', marginTop: 6 }}>
          主人 ID 已填写，下方权限级别已生效（当前：{permissionLabel}）。
        </div>
      )}
    </Field>
  )
}

function OwnerPermissionLevelField({ name, value, onChange, disabled }) {
  return (
    <Field label="主人拥有的权限级别" hint={disabled ? '请先填写主人 ID' : '单选'}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, opacity: disabled ? 0.55 : 1 }}>
        {OWNER_PERMISSION_OPTIONS.map((option) => (
          <label
            key={option.value}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              cursor: disabled ? 'not-allowed' : 'pointer',
              fontSize: 13,
              color: 'var(--text-primary)',
            }}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              disabled={disabled}
              onChange={() => onChange(option.value)}
              style={{ marginTop: 3, accentColor: 'var(--accent)' }}
            />
            <span>
              <span style={{ fontWeight: 600 }}>{option.label}</span>
              <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{option.hint}</span>
            </span>
          </label>
        ))}
      </div>
    </Field>
  )
}

function Field({ label, hint, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={labelStyle}>
        {label}
        {hint && <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: 6 }}>{hint}</span>}
      </label>
      {children}
    </div>
  )
}

const cardStyle = {
  background: 'var(--bg-primary)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: 16,
  marginBottom: 12,
}
const toggleLabelStyle = { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12, color: 'var(--text-secondary)' }
const checkboxStyle = { accentColor: 'var(--accent)', width: 14, height: 14 }
const labelStyle = { display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 5, fontWeight: 600 }
const btnStyle = {
  border: 'none',
  borderRadius: 7,
  color: '#fff',
  cursor: 'pointer',
  padding: '8px 20px',
  fontSize: 13,
  fontWeight: 600,
  background: 'var(--accent)',
}
const btnSmallStyle = {
  border: '1px solid var(--border)',
  borderRadius: 7,
  color: 'var(--text-primary)',
  cursor: 'pointer',
  padding: '6px 14px',
  fontSize: 12,
  fontWeight: 500,
  background: 'var(--bg-secondary)',
}
