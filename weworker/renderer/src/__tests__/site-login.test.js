import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  AUTOLOGIN_NOTICE_LINES,
  describeAutologin,
  describeLoginEvent,
  describeLoginState,
  loginContinueText,
  validateCredentialForm,
} from '../utils/site-login.js'
import { hideBrowserForNewTurn } from '../utils/dedicated-browser.js'

describe('website login display', () => {
  it('shows a notice only when the user can act or should know', () => {
    assert.equal(describeLoginEvent({ status: 'login_required', name: '示例站' }), null)
    const waiting = describeLoginEvent({ status: 'waiting_user', name: '示例站' })
    assert.match(waiting.title, /需要登录 示例站/)
    assert.match(waiting.text, /扫码、输入短信验证码或账号密码/)
    assert.deepEqual(waiting.actions, ['show', 'cancel'])
    assert.equal(waiting.autoDismissMs, 0)
    assert.deepEqual(describeLoginEvent({ status: 'autologin_failed', name: '示例站', message: '提交后仍停留在登录页' }).actions, ['show', 'update_password', 'disable_autologin'])
    const done = describeLoginEvent({ status: 'logged_in', name: '示例站' })
    assert.ok(done.autoDismissMs > 0)
    assert.deepEqual(describeLoginEvent({ status: 'logged_in', name: '示例站', offerAutologin: true }).actions, ['enable_autologin', 'dismiss_autologin', 'continue'])
    assert.match(describeLoginEvent({ status: 'logged_in', name: '示例站', autologin: true }).text, /已自动登录/)
    assert.equal(loginContinueText('示例站'), '已完成 示例站 登录，请继续刚才的操作。')
  })

  it('describes per-site state and auto-login preferences', () => {
    assert.equal(describeLoginState({ state: 'logged_in' }).text, '已登录')
    assert.equal(describeLoginState({ state: 'logged_out', flow: 'waiting_user' }).text, '等待登录')
    assert.equal(describeLoginState({}).text, '未检查')
    assert.match(describeAutologin({ autologin: { supported: true, enabled: true, username: 'fi****', lastResult: 'failed' } }), /已开启（fi\*\*\*\*），上次未成功/)
    assert.equal(describeAutologin({ autologin: { supported: false } }), '当前系统不支持保存密码')
    assert.match(describeAutologin({ autologin: { supported: true, allowed: false, mode: 'off' } }), /不支持自动登录/)
    const dynamic = describeLoginEvent({ status: 'waiting_user', name: '动态口令站点', autologinMode: 'off' })
    assert.match(dynamic.text, /动态密码/)
    assert.deepEqual(describeLoginEvent({ status: 'logged_in', name: '动态口令站点', autologinMode: 'off', offerAutologin: true }).actions, ['continue'])
  })

  it('requires an explicit acknowledgement before saving a password', () => {
    assert.match(validateCredentialForm({ username: 'a', password: 'b' }), /确认/)
    assert.equal(validateCredentialForm({ username: 'a', password: 'b', acknowledged: true }), '')
    assert.match(validateCredentialForm({ username: ' ', password: 'b', acknowledged: true }), /账号/)
    assert.ok(AUTOLOGIN_NOTICE_LINES.some((line) => /读不到明文密码/.test(line)))
  })

  it('the per-turn hide is soft so a waiting login page stays visible', async () => {
    const calls = []
    hideBrowserForNewTurn({ hideDedicatedBrowser: async (options) => { calls.push(options) } })
    assert.deepEqual(calls, [{ soft: true }])
  })

  it('login UI is mounted globally and never names the source package', () => {
    const app = fs.readFileSync(new URL('../App.jsx', import.meta.url), 'utf8')
    assert.match(app, /<SiteLoginNotice \/>/)
    const settings = fs.readFileSync(new URL('../components/settings/SettingsModal.jsx', import.meta.url), 'utf8')
    assert.match(settings, /<SiteLoginSettings \/>/)
    for (const file of ['../utils/site-login.js', '../components/site-login/SiteLoginNotice.jsx', '../components/site-login/SiteLoginSettings.jsx', '../components/site-login/AutoLoginDialog.jsx']) {
      assert.doesNotMatch(fs.readFileSync(new URL(file, import.meta.url), 'utf8'), /webwright/i, file)
    }
    const dialog = fs.readFileSync(new URL('../components/site-login/AutoLoginDialog.jsx', import.meta.url), 'utf8')
    assert.match(dialog, /type="password"/)
    assert.match(dialog, /aria-modal="true"/)
  })
})
