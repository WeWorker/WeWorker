import { backendFetch } from '../api/http.js'

export function channelProbeConfig(channel, form = {}) {
  const fields = channel === 'weixin' ? ['token', 'base_url'] : channel === 'wecom' ? ['bot_id', 'secret'] : ['app_id', 'app_secret']
  return Object.fromEntries(fields.map(key => [key, String(form[key] || '').trim()]))
}

export async function requestChannelProbe(channel, config, signal) {
  const response = await backendFetch('/settings/channels/probe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, profile_id: config.profile_id, config: channelProbeConfig(channel, config) }), signal,
  })
  if (response.status === 404) throw new Error('当前后端尚未支持通道检测，请重启 WeWorker')
  if (response.status === 409) throw new Error('该通道正在检测，请稍后重试')
  if (!response.ok) throw new Error('通道检测请求失败，请检查后端连接后重试')
  let data
  try { data = await response.json() } catch { throw new Error('通道检测返回格式异常，请重启 WeWorker 后重试') }
  if (!Array.isArray(data.checks) || !data.checks.length || data.checks.some(check => !check || !['success', 'failure', 'skipped'].includes(check.status) || typeof check.label !== 'string' || typeof check.message !== 'string')) {
    throw new Error('通道检测返回格式异常')
  }
  return { ...data, ok: data.ok === true && data.checks.every(check => check.status === 'success') }
}
