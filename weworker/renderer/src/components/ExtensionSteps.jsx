import React, { useState } from 'react'

const isMac = navigator.platform.toLowerCase().includes('mac')

export const EXTENSION_PATH = isMac
  ? '/Applications/WeWorker.app/Contents/Resources/extension'
  : '%LOCALAPPDATA%\\Programs\\WeWorker\\resources\\extension'

export function useExtensionSteps() {
  return [
    {
      num: 1,
      title: '打开 Chrome 扩展管理页',
      desc: '点击下方按钮，Chrome 会自动打开扩展管理页面。',
      action: {
        label: '打开 chrome://extensions/',
        onClick: () => window.electronAPI?.openChromeUrl('chrome://extensions/'),
      },
    },
    {
      num: 2,
      title: '开启开发者模式',
      desc: '在扩展管理页右上角，打开"开发者模式"开关。',
    },
    {
      num: 3,
      title: '加载扩展',
      desc: isMac
        ? '点击"加载未解压的扩展程序"，在弹出的 Finder 窗口中选择扩展路径：'
        : '点击"加载未解压的扩展程序"，在弹出的文件选择窗口中粘贴以下路径后按回车：',
      path: EXTENSION_PATH,
      pathTip: isMac
        ? { icon: '💡', text: <>Finder 窗口弹出后，按 <kbd style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 4, padding: '1px 5px', fontSize: 11, fontFamily: 'monospace' }}>⌘ Shift G</kbd> 打开路径输入框，粘贴下方路径</> }
        : { icon: '💡', text: '在文件选择窗口的地址栏直接粘贴路径，按回车导航' },
    },
    {
      num: 4,
      title: '完成',
      desc: 'Chrome 右上角出现 WeWorker 扩展图标，WeWorker 左侧导航栏的拼图图标显示为已连接即安装成功。',
    },
  ]
}

export function StepList({ steps, onCopy, copied }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {steps.map((step) => (
        <div key={step.num} style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          borderRadius: 8, padding: 12,
          display: 'flex', gap: 10, alignItems: 'flex-start',
        }}>
          <div style={{
            width: 22, height: 22, borderRadius: '50%',
            background: 'var(--accent)', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11, fontWeight: 700, flexShrink: 0, marginTop: 1,
          }}>{step.num}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)', marginBottom: 3 }}>{step.title}</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{step.desc}</div>

            {step.path && (
              <div style={{ marginTop: 8 }}>
                {step.pathTip && (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.3)',
                    borderRadius: 6, padding: '6px 10px', marginBottom: 6,
                  }}>
                    <span style={{ fontSize: 14 }}>{step.pathTip.icon}</span>
                    <span style={{ fontSize: 12, color: 'var(--text-primary)' }}>{step.pathTip.text}</span>
                  </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <code style={{
                    flex: 1, fontSize: 11, background: 'var(--bg-primary)',
                    border: '1px solid var(--border)', borderRadius: 6,
                    padding: '5px 8px', color: 'var(--accent)',
                    fontFamily: 'monospace', wordBreak: 'break-all',
                  }}>{step.path}</code>
                  <button data-app-button="action"
                    onClick={onCopy}
                    style={{
                      flexShrink: 0, background: 'var(--bg-primary)',
                      border: '1px solid var(--border)', borderRadius: 6,
                      padding: '5px 10px', fontSize: 11, cursor: 'pointer',
                      color: copied ? 'var(--success)' : 'var(--text-secondary)',
                      fontFamily: 'inherit',
                    }}
                  >
                    {copied ? '已复制 ✓' : '复制'}
                  </button>
                </div>
              </div>
            )}

            {step.action && (
              <button data-app-button="action"
                onClick={step.action.onClick}
                style={{
                  marginTop: 8, background: 'var(--accent)', color: '#fff',
                  border: 'none', borderRadius: 6, padding: '6px 14px',
                  fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                {step.action.label}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
