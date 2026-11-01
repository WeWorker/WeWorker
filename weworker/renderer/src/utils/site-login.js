/**
 * Display rules for website login. WeWorker (the Bridge) runs the login flow;
 * the desktop only shows its progress and offers fixed actions.
 */

/** What the user agrees to when turning auto-login on. */
export const AUTOLOGIN_NOTICE_LINES = [
  '需要登录时，WeWorker 会在 WeWorker 浏览器中替你填写账号密码并点击登录。',
  '密码用本机系统密钥（Windows DPAPI）加密保存在本机，只有当前系统用户能解密。',
  'WeWorker 的 AI、网站适配器和浏览器扩展都读不到明文密码，日志中也不会出现。',
  '只在该网站声明的 HTTPS 登录页上填写；遇到验证码、短信验证码、扫码或登录失败，会交给你处理。',
  '随时可以在 设置 → 网站登录 中暂停自动登录或删除密码。',
]

const named = (event) => event?.name || event?.site || '网站'

/**
 * One notice per login event; null for events that need no notice
 * (`login_required` is followed within seconds by a result or `waiting_user`).
 */
export function describeLoginEvent(event) {
  const name = named(event)
  const autologinAllowed = event?.autologinMode !== 'off'
  switch (event?.status) {
    case 'autologin_started':
      return { tone: 'pending', title: `正在自动登录 ${name}`, text: '正在 WeWorker 浏览器中填写已保存的账号密码…', actions: [], autoDismissMs: 0 }
    case 'waiting_user': {
      const qrReady = event?.qr?.available === true
      return {
        tone: 'warn', title: `需要登录 ${name}`,
        text: qrReady
          ? '登录二维码已准备好，请用手机扫码。二维码会自动刷新；也可以显示浏览器切换其他登录方式。'
          : autologinAllowed
            ? '已在 WeWorker 浏览器中打开登录页。可以扫码、输入短信验证码或账号密码，完成后任务会自动继续。'
            : '该网站不支持自动登录。请在 WeWorker 浏览器中使用动态密码或网站提供的其他方式完成登录。',
        actions: ['show', 'cancel'], autoDismissMs: 0,
      }
    }
    case 'autologin_failed':
      return {
        tone: 'warn', title: `自动登录 ${name} 未成功`,
        text: autologinAllowed
          ? `${event.message || '原因未知'}。请在浏览器中手动完成登录；如果密码已更改，可以更新保存的密码。`
          : '该网站不支持自动登录，请在浏览器中手动完成登录。',
        actions: autologinAllowed ? ['show', 'update_password', 'disable_autologin'] : ['show'], autoDismissMs: 0,
      }
    case 'logged_in':
      return event.offerAutologin && autologinAllowed
        ? {
            tone: 'ok', title: `已登录 ${name}`,
            text: '这已经是你第二次手动登录这个网站。要让 WeWorker 下次替你自动登录吗？',
            actions: ['enable_autologin', 'dismiss_autologin', 'continue'], autoDismissMs: 0,
          }
        : { tone: 'ok', title: `已登录 ${name}`, text: event.autologin ? '已自动登录，任务继续执行。' : '任务继续执行。', actions: ['continue'], autoDismissMs: 6000 }
    case 'cancelled':
      return { tone: 'muted', title: `已取消 ${name} 登录`, text: '', actions: [], autoDismissMs: 4000 }
    case 'timeout':
      return { tone: 'warn', title: `${name} 登录等待超时`, text: '登录页已收起；需要时重新执行任务即可再次登录。', actions: [], autoDismissMs: 10000 }
    case 'failed':
      return { tone: 'error', title: `无法打开 ${name} 登录页`, text: event.message || '', actions: ['show'], autoDismissMs: 0 }
    default:
      return null
  }
}

export const LOGIN_ACTION_LABELS = {
  show: '显示浏览器',
  cancel: '取消登录',
  update_password: '更新密码',
  disable_autologin: '关闭自动登录',
  enable_autologin: '开启自动登录',
  dismiss_autologin: '不再询问',
  continue: '继续任务',
}

/** Text sent to the chat when the user continues a task that stopped for a login. */
export function loginContinueText(name) {
  return `已完成 ${name || '网站'} 登录，请继续刚才的操作。`
}

export function describeLoginState(entry) {
  if (entry?.flow === 'waiting_user') return { tone: 'warn', text: '等待登录' }
  if (entry?.flow) return { tone: 'pending', text: '登录中' }
  if (entry?.state === 'logged_in') return { tone: 'ok', text: '已登录' }
  if (entry?.state === 'logged_out') return { tone: 'warn', text: '未登录' }
  return { tone: 'muted', text: '未检查' }
}

export function describeAutologin(entry) {
  const auto = entry?.autologin || {}
  if (auto.allowed === false || auto.mode === 'off') return '该网站不支持自动登录，请使用动态密码或其他方式手动登录'
  if (!auto.supported) return '当前系统不支持保存密码'
  if (auto.enabled) return `自动登录：已开启（${auto.username || '已保存账号'}）${auto.lastResult === 'failed' ? '，上次未成功' : ''}`
  if (auto.configured) return '自动登录：已暂停'
  return '自动登录：未开启'
}

export function validateCredentialForm({ username, password, acknowledged } = {}) {
  if (!String(username || '').trim()) return '请填写账号。'
  if (String(username).length > 256) return '账号过长。'
  if (!password) return '请填写密码。'
  if (String(password).length > 1024) return '密码过长。'
  if (acknowledged !== true) return '请先确认已了解自动登录的说明。'
  return ''
}
