/**
 * WecomChannel 的文件推送（sendFilesToTarget / sendNotificationFiles）。
 *
 * 修复的约束：定时推送的附件复用互动回合的上传原语（aibot_upload_media_init →
 * chunk → finish → aibot_send_msg msgtype=file），单个文件失败不中断其余文件，
 * 且每个失败都要点名；sendNotificationFiles 必须送到与文本通知同一个会话。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { WecomChannel } from '../channels/wecom-channel.js'

let dir = ''
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-wecom-files-')) })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

interface SentFrame { cmd: string; headers: { req_id: string }; body: Record<string, unknown> }

/**
 * Fake OPEN socket that answers the upload handshake with success frames.
 * `failOnNthInit` makes the Nth aibot_upload_media_init fail (1-based) so a
 * multi-file push exercises partial failure.
 */
function fakeSocket(channel: WecomChannel, opts: { failOnNthInit?: number } = {}) {
  const frames: SentFrame[] = []
  let initCount = 0
  const socket = {
    readyState: WebSocket.OPEN,
    send: vi.fn((raw: string) => {
      const request = JSON.parse(raw) as SentFrame
      frames.push(request)
      const reqId = request.headers.req_id
      if (request.cmd === 'aibot_upload_media_init') {
        const nth = ++initCount
        setImmediate(() => (channel as unknown as { _handleFrame: (frame: object) => void })._handleFrame(
          nth === opts.failOnNthInit
            ? { headers: { req_id: reqId }, errcode: 46003, errmsg: 'fixture upload rejected' }
            : { headers: { req_id: reqId }, body: { upload_id: `upload-${nth}` } },
        ))
      } else if (request.cmd === 'aibot_upload_media_chunk') {
        setImmediate(() => (channel as unknown as { _handleFrame: (frame: object) => void })._handleFrame({ headers: { req_id: reqId } }))
      } else if (request.cmd === 'aibot_upload_media_finish') {
        setImmediate(() => (channel as unknown as { _handleFrame: (frame: object) => void })._handleFrame({ headers: { req_id: reqId }, body: { media_id: `media-${initCount}` } }))
      }
    }),
  }
  ;(channel as unknown as { _ws: unknown })._ws = socket
  return { frames }
}

const fileMessages = (frames: SentFrame[]) => frames.filter(f => f.cmd === 'aibot_send_msg' && f.body.msgtype === 'file')

function fixture(name: string): string {
  const file = path.join(dir, name)
  fs.writeFileSync(file, `fixture-content-${name}`)
  return file
}

describe('WecomChannel file notifications', () => {
  const channel = () => new WecomChannel({ enabled: true, bot_id: 'fixture-bot', secret: 'fixture-secret' })

  it('uploads a file and sends it as a file message to the target chat', async () => {
    const ch = channel()
    const { frames } = fakeSocket(ch)
    const report = fixture('report-fixture.pdf')

    await ch.sendFilesToTarget({ id: 'chat-fixture', chatType: 1 }, [{ path: report, name: 'report-fixture.pdf' }])

    const cmds = frames.map(f => f.cmd)
    expect(cmds).toContain('aibot_upload_media_init')
    expect(cmds).toContain('aibot_upload_media_finish')
    expect(fileMessages(frames)).toEqual([{
      cmd: 'aibot_send_msg',
      headers: expect.objectContaining({ req_id: expect.any(String) }),
      body: {
        chatid: 'chat-fixture',
        chat_type: 1,
        msgtype: 'file',
        file: { media_id: 'media-1' },
      },
    }])
  })

  it('rejects with a named failure when the upload is rejected and sends no file message', async () => {
    const ch = channel()
    const { frames } = fakeSocket(ch, { failOnNthInit: 1 })
    const report = fixture('report-fixture.pdf')

    await expect(ch.sendFilesToTarget({ id: 'chat-fixture', chatType: 1 }, [{ path: report, name: 'report-fixture.pdf' }]))
      .rejects.toThrow(/文件发送失败（1\/1）.*report-fixture\.pdf/)
    expect(fileMessages(frames)).toEqual([])
  })

  it('keeps sending the remaining files when one fails, and names every failure', async () => {
    const ch = channel()
    const { frames } = fakeSocket(ch, { failOnNthInit: 2 })
    const good = fixture('list-fixture.tsv')
    const bad = fixture('missing-broken.xlsx')

    await expect(ch.sendFilesToTarget({ id: 'chat-fixture', chatType: 2 }, [
      { path: good, name: 'list-fixture.tsv' },
      { path: bad, name: 'missing-broken.xlsx' },
    ])).rejects.toThrow(/文件发送失败（1\/2）.*missing-broken\.xlsx/)

    // 第一个文件不受第二个失败影响，已经送达。
    expect(fileMessages(frames).map(f => (f.body as { file: { media_id: string } }).file.media_id)).toEqual(['media-1'])
    expect((fileMessages(frames)[0].body as { chatid: string }).chatid).toBe('chat-fixture')
  })

  it('sendNotificationFiles routes to the remembered notification target', async () => {
    const ch = channel()
    const { frames } = fakeSocket(ch)
    ;(ch as unknown as { _lastUserId: string | null })._lastUserId = 'owner-fixture'
    ;(ch as unknown as { _lastChatType: number })._lastChatType = 2
    const report = fixture('report-fixture.pdf')

    await ch.sendNotificationFiles([{ path: report, name: 'report-fixture.pdf' }])
    expect(fileMessages(frames).map(f => f.body)).toEqual([{
      chatid: 'owner-fixture',
      chat_type: 2,
      msgtype: 'file',
      file: { media_id: 'media-1' },
    }])
  })

  it('sendNotificationFiles without a remembered target rejects like text notifications do', async () => {
    const ch = channel()
    fakeSocket(ch)
    await expect(ch.sendNotificationFiles([{ path: fixture('report-fixture.pdf'), name: 'report-fixture.pdf' }]))
      .rejects.toThrow(/没有可用的企业微信用户/)
  })

  it('validates the target shape before touching the socket', async () => {
    const ch = channel()
    await expect(ch.sendFilesToTarget({ id: '', chatType: 1 }, [{ path: 'unused', name: 'unused' }]))
      .rejects.toThrow('文件通知目标无效')
    await expect(ch.sendFilesToTarget({ id: 'chat-fixture', chatType: 3 as 1 }, [{ path: 'unused', name: 'unused' }]))
      .rejects.toThrow('文件通知目标类型无效')
  })
})
