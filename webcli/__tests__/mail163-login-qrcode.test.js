import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const COMMAND_PATH = resolve(process.cwd(), '../adapters/mail.163.com/extension/commands/get-login-qrcode.js')

/**
 * mail.163.com get-login-qrcode 的冷挂载行为。
 *
 * 2026-11-14 线上事故：登录页打开 4 秒后 auth_prepare_qr 就到来了，而 163 的
 * 登录壳先挂载、二维码 canvas 由 mailscanlogin 脚本晚几秒才画。旧实现找不到
 * canvas 时立即去找扫码切换入口（现在二维码是默认视图，入口已不存在），1.4 秒
 * 就返回 QR_ENTRY_NOT_FOUND，宿主登录流程只落了整页截图，用户在聊天里看不到
 * 二维码。修复：走切换机制之前先等初始挂载（COLD_MOUNT_WAIT_MS）。
 */

class FakeElement {
  constructor({ visible = true, width = 180, height = 180, text = '' } = {}) {
    this._visible = visible
    this._rect = { width, height }
    this.textContent = text
    this.clicked = 0
  }
  getBoundingClientRect() { return { ...this._rect } }
}

class FakeCanvas extends FakeElement {
  toDataURL() { return 'data:image/png;base64,iVBORw0KGgoAAAANSUhxUJREF==' }
}

function loadCommand({ mountAfterPolls = Infinity } = {}) {
  let registered = null
  let canvasPolls = 0
  const canvas = new FakeCanvas()
  // scoped fallback（.w-mc-codeWrap 内的 img/canvas）与 precise 选择器共享挂载状态。
  const wrap = new FakeElement({ width: 340, height: 222 })
  wrap.querySelectorAll = () => (canvasPolls > mountAfterPolls ? [canvas] : [])
  const shell = new FakeElement()
  // 与实测页面一致：#noScanWrap 常驻 DOM 但 display:none（0×0），不属于 noScan 态。
  const hiddenNoScan = new FakeElement({ visible: false, width: 0, height: 0 })

  const bySelector = (selector) => {
    if (selector === '.new-loginFunc, #loginBlock') return shell
    if (selector === '.s-noScan-active') return null
    if (selector === '#noScanWrap, .w-mc-appLogin-noScan') return hiddenNoScan
    if (selector === '.w-mc-codeWrap') return wrap
    if (selector === '.w-mc-appLogin-scanSuc, .w-mc-txt-suc') return null
    if (selector === '#appCodeRefresh') return null
    if (selector === '#appCodeMain canvas, .w-mc-appCode-wrap canvas') {
      canvasPolls += 1
      return canvasPolls > mountAfterPolls ? canvas : null
    }
    if (selector === '.new-loginFuncApp.qrcode-163-icon, .qrcode-163-icon') return null
    if (selector === '#scanReScanBtn, .w-mc-appLogin-noScan-switchBtn') return null
    throw new Error(`unexpected selector: ${selector}`)
  }

  const sandbox = {
    location: { hostname: 'mail.163.com' },
    document: {
      querySelector: bySelector,
      querySelectorAll: () => [],
    },
    HTMLCanvasElement: FakeCanvas,
    HTMLImageElement: class FakeImage extends FakeElement {},
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    // 快进定时器：等待循环以 0ms 间隔跑，6s 等待 = 30 轮轮询，瞬间完成。
    setTimeout: (fn) => { setImmediate(fn); return 0 },
    clearTimeout: () => {},
    __webcliRegisterCommand: (id, fn) => { registered = { id, fn } },
  }
  sandbox.window = sandbox
  vm.runInNewContext(readFileSync(COMMAND_PATH, 'utf8'), sandbox, { filename: 'get-login-qrcode.js' })
  if (!registered) throw new Error('command was not registered')
  return { registered, polls: () => canvasPolls }
}

describe('mail.163.com get-login-qrcode cold mount', () => {
  it('waits out the cold mount and returns the canvas image', async () => {
    const { registered, polls } = loadCommand({ mountAfterPolls: 5 })
    const result = await registered.fn()
    // 二维码在若干轮轮询后出现：命令等到了它，而不是立即放弃。
    expect(polls()).toBeGreaterThan(5)
    expect(result).toMatchObject({ found: true, image_data_url: expect.stringMatching(/^data:image\/png;base64,/) })
  })

  it('reports QR_ENTRY_NOT_FOUND only after exhausting the mount wait', async () => {
    const { registered, polls } = loadCommand({ mountAfterPolls: Infinity })
    const result = await registered.fn()
    // COLD_MOUNT_WAIT_MS=6000 / POLL_MS=200 = 30 轮：确实等待过才放弃。
    expect(polls()).toBeGreaterThanOrEqual(30)
    expect(result).toEqual({ found: false, reason: 'QR_ENTRY_NOT_FOUND' })
  })
})
