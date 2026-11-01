import React from 'react'

export default class RenderErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('[RenderErrorBoundary]', error, info?.componentStack)
  }

  handleRetry = () => {
    this.setState({ error: null })
    this.props.onRetry?.()
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div style={shellStyle}>
        <h3 style={titleStyle}>工具包界面渲染出错</h3>
        <p style={messageStyle}>{error?.message || String(error)}</p>
        <p style={hintStyle}>
          若从桌面快捷方式打开，可能是旧安装版。请改用项目目录运行 <code style={codeStyle}>npm run dev</code>。
        </p>
        <div style={actionsStyle}>
          <button data-app-button="action" type="button" style={buttonStyle} onClick={this.handleRetry}>重试</button>
          {this.props.onClose && (
            <button data-app-button="action" type="button" style={secondaryButtonStyle} onClick={this.props.onClose}>关闭工具包</button>
          )}
        </div>
      </div>
    )
  }
}

const shellStyle = {
  flex: 1,
  display: 'grid',
  placeContent: 'center',
  gap: 10,
  padding: 32,
  textAlign: 'center',
}

const titleStyle = {
  margin: 0,
  fontSize: 18,
}

const messageStyle = {
  margin: 0,
  color: 'var(--text-secondary)',
  fontSize: 13,
  maxWidth: 480,
}

const hintStyle = {
  margin: 0,
  color: 'var(--text-secondary)',
  fontSize: 12,
  maxWidth: 520,
  lineHeight: 1.5,
}

const codeStyle = {
  fontFamily: 'ui-monospace, monospace',
  fontSize: 12,
}

const actionsStyle = {
  display: 'flex',
  justifyContent: 'center',
  gap: 8,
  marginTop: 4,
}

const buttonStyle = {
  height: 32,
  padding: '0 14px',
  borderRadius: 8,
  border: 'none',
  background: 'var(--accent)',
  color: '#fff',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 13,
}

const secondaryButtonStyle = {
  ...buttonStyle,
  background: 'var(--bg-secondary)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border)',
}
