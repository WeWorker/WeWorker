import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SiteAuthChannelNotifier } from '../channels/site-auth-notifier.js'
import type { BridgeSiteAuthEvent } from '../bridge-rpc-client.js'

/** Minimal PNG (magic + payload) inside the controlled login-image root. */
function fixtureImage(): string {
  const dir = path.join(os.homedir(), '.webcli', 'login', `.notifier-test-${randomUUID().slice(0, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'qr.png')
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]))
  return file
}

describe('site auth channel notifier: QR supplement on the second waiting_user', () => {
  let emit!: (event: BridgeSiteAuthEvent) => void
  let notifier: SiteAuthChannelNotifier
  let texts: string[]
  let images: string[]
  let close: () => void
  let imageFile: string

  beforeEach(() => {
    let listener: (event: BridgeSiteAuthEvent) => void = () => {}
    notifier = new SiteAuthChannelNotifier({ onAuthEvent(l) { listener = l; return () => {} } })
    emit = (event) => listener(event)
    texts = []
    images = []
    imageFile = fixtureImage()
    const handle = notifier.registerTurn({
      channelKey: 'wecom',
      sendText: async (text) => { texts.push(text) },
      sendImage: async (image) => { images.push(image.filename) },
    })
    handle.observeToolCall('call-1', 'PowerShell', { command: 'webcli call weoa.example.com.upload-invoice --file=x' })
    close = handle.close
  })

  afterEach(() => {
    close()
    fs.rmSync(path.dirname(imageFile), { recursive: true, force: true })
  })

  const waitingUser = (extra: Partial<BridgeSiteAuthEvent> = {}): BridgeSiteAuthEvent =>
    ({ type: 'auth_event', site: 'weoa.example.com', name: '示例站', status: 'waiting_user', ...extra })

  it('sends conditional text first, then the QR image when the second event carries it', async () => {
    // ① Bridge 先广播裸事件（二维码还在提取）
    emit(waitingUser())
    await vi.waitFor(() => expect(texts).toHaveLength(1))
    expect(texts[0]).toContain('若该站点支持扫码登录')
    expect(images).toHaveLength(0)

    // ② 二维码就绪的第二条事件：补发引导 + 图片
    emit(waitingUser({ qr: { available: true, image: imageFile }, screenshot: imageFile }))
    await vi.waitFor(() => expect(images).toHaveLength(1))
    expect(texts[1]).toContain('请使用手机扫描')

    // ③ 15 秒周期刷新（同样带码）：静默，不再发任何消息
    emit(waitingUser({ qr: { available: true, image: imageFile }, screenshot: imageFile, screenshotVersion: 2 }))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(texts).toHaveLength(2)
    expect(images).toHaveLength(1)
  })

  it('sites without a QR keep the single conditional text and never get spammed', async () => {
    emit(waitingUser())
    await vi.waitFor(() => expect(texts).toHaveLength(1))
    // 无码站点的第二条：qr.available=false，无图路径
    emit(waitingUser({ qr: { available: false } }))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(texts).toHaveLength(1)
    expect(images).toHaveLength(0)
  })

  it('first event already carrying the QR sends intro + image immediately (fast-QR sites unchanged)', async () => {
    emit(waitingUser({ qr: { available: true, image: imageFile } }))
    await vi.waitFor(() => expect(images).toHaveLength(1))
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('请使用手机扫描')
    // 后续刷新静默
    emit(waitingUser({ qr: { available: true, image: imageFile }, screenshotVersion: 2 }))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(texts).toHaveLength(1)
    expect(images).toHaveLength(1)
  })

  it('image read failure falls back to manual text once, refreshes stay silent', async () => {
    emit(waitingUser({ qr: { available: true, image: path.join(os.tmpdir(), 'not-in-login-root.png') } }))
    await vi.waitFor(() => expect(texts.some(t => t.includes('无法安全发送二维码图片'))).toBe(true))
    expect(images).toHaveLength(0)
    emit(waitingUser({ qr: { available: true, image: path.join(os.tmpdir(), 'not-in-login-root.png') }, screenshotVersion: 2 }))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(texts.filter(t => t.includes('无法安全发送二维码图片'))).toHaveLength(1)
  })
})
