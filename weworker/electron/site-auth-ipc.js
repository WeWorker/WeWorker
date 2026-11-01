/**
 * Website login actions from the Renderer, checked before they reach the Bridge.
 *
 * The Renderer may only name a fixed action and an Adapter id; it never passes
 * URLs or paths. A password is accepted only by `save_credential`, forwarded
 * once to the Bridge (which encrypts it) and never logged or returned.
 */
const SITE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const CONTEXT_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const ACTIONS = new Set(['status', 'check', 'login', 'show_login', 'cancel', 'set_autologin', 'save_credential', 'forget_credential'])

export function sanitizeSiteAuthRequest(action, payload = {}) {
  if (!ACTIONS.has(action)) throw new Error('Unsupported login action.')
  const input = payload && typeof payload === 'object' ? payload : {}
  if (action === 'status') return { action, extra: { refresh: input.refresh === true } }
  if (typeof input.site !== 'string' || !SITE_RE.test(input.site)) throw new Error('Invalid site.')
  const extra = { site: input.site }
  if (typeof input.contextId === 'string' && CONTEXT_ID_RE.test(input.contextId)) {
    extra.browserProfile = input.contextId
  }
  // The desktop never blocks on a login; progress arrives as events.
  if (action === 'login') extra.waitMs = 0
  if (action === 'set_autologin') {
    extra.enabled = input.enabled === true
    if (input.dismissed === true) extra.dismissed = true
  }
  if (action === 'save_credential') {
    if (typeof input.username !== 'string' || !input.username.trim() || input.username.length > 256) throw new Error('请填写账号。')
    if (typeof input.password !== 'string' || !input.password || input.password.length > 1024) throw new Error('请填写密码。')
    extra.username = input.username
    extra.password = input.password
  }
  return { action, extra }
}

/** System notification for login events while the WeWorker window is not in front; null for none. */
export function siteAuthNotification(event) {
  const name = event?.name || event?.site || '网站'
  if (event?.status === 'waiting_user' && event?.screenshotUpdated !== true) {
    const body = event?.qr?.available === true
      ? '登录二维码已准备好，请在 WeWorker 中扫码；二维码会自动刷新。'
      : event?.autologinMode === 'off'
        ? '该网站不支持自动登录，请在 WeWorker 浏览器中使用动态密码或其他方式手动登录。'
        : '已在 WeWorker 浏览器中打开登录页，可扫码、输入短信验证码或账号密码。完成后任务会自动继续。'
    return { title: `需要登录 ${name}`, body }
  }
  if (event?.status === 'autologin_failed') {
    return { title: `自动登录 ${name} 未成功`, body: event.message ? `${event.message}。请在 WeWorker 浏览器中手动完成登录。` : '请在 WeWorker 浏览器中手动完成登录。' }
  }
  return null
}
