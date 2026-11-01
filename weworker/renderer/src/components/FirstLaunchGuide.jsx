import React, { useState } from 'react'
import { EXTENSION_PATH, useExtensionSteps, StepList } from './ExtensionSteps.jsx'
import changelog from '../../../changelog.json'
import disclaimer from '../../../disclaimer.json'

const currentVersion = changelog[0]

export default function FirstLaunchGuide({ onClose }) {
  const [copied, setCopied] = useState(false)
  const [agreed, setAgreed] = useState(false)
  const steps = useExtensionSteps()

  const handleCopy = () => {
    navigator.clipboard.writeText(EXTENSION_PATH).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000 }}>
      <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 16, padding: 32, width: 520, maxWidth: '92vw', maxHeight: '85vh', overflowY: 'auto' }}>
        {/* Header */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 16 }}>W</div>
            <span style={{ fontWeight: 700, fontSize: 18, color: 'var(--text-primary)' }}>欢迎使用 WeWorker</span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>v{currentVersion.version}</span>
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 }}>
            WeWorker 需要配合 Chrome 扩展才能操作网页。请按以下步骤完成安装，约需 2 分钟。
          </p>
        </div>

        <StepList steps={steps} onCopy={handleCopy} copied={copied} />

        {/* Version changelog */}
        <div style={{ marginTop: 20, padding: '14px 16px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
            v{currentVersion.version} 更新内容
            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400, marginLeft: 8 }}>{currentVersion.date}</span>
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
            {currentVersion.items.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>

        {/* Disclaimer */}
        <div style={{ marginTop: 16, padding: '14px 16px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
            {disclaimer.title}
          </div>
          <div style={{ maxHeight: 160, overflowY: 'auto', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
            {disclaimer.sections.map((sec, i) => (
              <div key={i} style={{ marginBottom: i < disclaimer.sections.length - 1 ? 10 : 0 }}>
                <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 }}>{sec.heading}</div>
                <div>{sec.content}</div>
              </div>
            ))}
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, cursor: 'pointer', fontSize: 12, color: 'var(--text-primary)', userSelect: 'none' }}>
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              style={{ width: 16, height: 16, accentColor: 'var(--accent)', cursor: 'pointer' }}
            />
            {disclaimer.agreement}
          </label>
        </div>

        <div style={{ marginTop: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>之后可在左下角"?"重新查看此指南</span>
          <button data-app-button="action"
            onClick={onClose}
            disabled={!agreed}
            style={{
              background: agreed ? 'var(--accent)' : 'var(--bg-tertiary)',
              color: agreed ? '#fff' : 'var(--text-muted)',
              border: 'none',
              borderRadius: 8,
              padding: '9px 28px',
              fontSize: 13,
              fontWeight: 600,
              cursor: agreed ? 'pointer' : 'not-allowed',
              fontFamily: 'inherit',
              transition: 'background 0.15s, color 0.15s',
            }}
          >
            开始使用
          </button>
        </div>
      </div>
    </div>
  )
}
