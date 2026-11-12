const PRESENTATIONS = {
  starting: { label: '探索服务启动中', enabled: false, tone: 'warning' },
  running: { label: '打开Adapter工坊', enabled: true, tone: 'success' },
  error: { label: '探索服务启动失败', enabled: false, tone: 'error' },
  port_in_use: { label: '端口 8766 被占用', enabled: false, tone: 'warning' },
  version_mismatch: { label: '探索服务版本不匹配', enabled: false, tone: 'error' },
  stopped: { label: '探索服务已停止', enabled: false, tone: 'muted' },
}

export function getWebwrightPresentation(status) {
  return PRESENTATIONS[status] || { label: '探索服务状态未知', enabled: false, tone: 'muted' }
}
