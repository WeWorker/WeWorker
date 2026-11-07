import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setMasterKeyForTests } from '../secret-store.js'
import {
  createAgent,
  findAgentByBotId,
  findAgentByWeixinToken,
  getAgent,
  getAgentWeixinToken,
  toAgentView,
  updateAgent,
} from '../dedicated-agents/agent-store.js'
import { createWeixinQrSessions, WEIXIN_QR_SESSION_TTL_MS } from '../dedicated-agents/weixin-qr.js'

const TEST_MASTER_KEY = '00112233445566778899aabbccddeeff'
const BASE_URL = 'https://ilinkai.weixin.qq.com'

describe('dedicated agents with WeChat bots', () => {
  let dir = ''
  let previousFile: string | undefined

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-agent-weixin-'))
    previousFile = process.env.WEWORKER_DEDICATED_AGENTS_FILE
    process.env.WEWORKER_DEDICATED_AGENTS_FILE = path.join(dir, 'dedicated-agents.json')
    setMasterKeyForTests(TEST_MASTER_KEY)
  })

  afterEach(() => {
    if (previousFile === undefined) delete process.env.WEWORKER_DEDICATED_AGENTS_FILE
    else process.env.WEWORKER_DEDICATED_AGENTS_FILE = previousFile
    setMasterKeyForTests(null)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const createWeixin = (overrides: Record<string, unknown> = {}) => createAgent({
    name: 'Example Operations Assistant',
    site_ids: ['example.com'],
    skill_names: [],
    channel: 'weixin',
    bot_id: 'placeholder-bot@im.bot',
    token: 'placeholder-weixin-token',
    base_url: BASE_URL,
    ...overrides,
  })

  it('stores the WeChat token encrypted and exposes only has_token', () => {
    const agent = createWeixin()
    expect(agent.channel).toBe('weixin')
    expect(agent.weixin?.token_enc).not.toContain('placeholder-weixin-token')
    expect(getAgentWeixinToken(agent)).toBe('placeholder-weixin-token')
    expect(fs.readFileSync(process.env.WEWORKER_DEDICATED_AGENTS_FILE!, 'utf8')).not.toContain('placeholder-weixin-token')

    const view = toAgentView(agent)
    expect(view.channel).toBe('weixin')
    expect(view.weixin).toEqual({ bot_id: 'placeholder-bot@im.bot', has_token: true })
    expect(view.wecom).toEqual({ bot_id: '', has_secret: false })
    expect(JSON.stringify(view)).not.toContain('placeholder-weixin-token')
    expect(findAgentByWeixinToken('placeholder-weixin-token')?.id).toBe(agent.id)
    expect(findAgentByBotId('placeholder-bot@im.bot')).toBeNull()
  })

  it('rejects disallowed hosts and missing tokens', () => {
    expect(() => createWeixin({ base_url: 'https://example.com' })).toThrow('允许列表')
    expect(() => createWeixin({ token: '' })).toThrow('重新扫码')
    expect(() => createWeixin({ bot_id: 'bad id' })).toThrow('格式不正确')
  })

  it('lets one WeChat bot serve only one agent and not the main channel', () => {
    createWeixin()
    expect(() => createWeixin({ name: 'Second', token: 'placeholder-other-token' })).toThrow('只能连接一个 Agent')
    expect(() => createWeixin({ name: 'Third', bot_id: '', token: 'placeholder-weixin-token' })).toThrow('只能连接一个 Agent')
    expect(() => createWeixin({ name: 'Fourth', bot_id: 'other@im.bot', token: 'placeholder-main-token' })).not.toThrow()
    expect(() => createAgent({
      name: 'Fifth', site_ids: ['example.org'], skill_names: [], channel: 'weixin', bot_id: 'fifth@im.bot', token: 'placeholder-reserved', base_url: BASE_URL,
    }, { reservedWeixinTokens: ['placeholder-reserved'] })).toThrow('设置 → 通道 → 微信')
  })

  it('treats records without a channel as WeCom', () => {
    fs.writeFileSync(process.env.WEWORKER_DEDICATED_AGENTS_FILE!, JSON.stringify({
      version: 1,
      agents: [{
        id: 'legacy0001', name: 'Legacy', description: '', site_id: 'example.com', skill_name: '', examples: [], enabled: true,
        wecom: { bot_id: 'placeholder-legacy', secret_enc: '' }, owner_user_id: 'owner-user', pairing_code: '', work_ids: [],
        created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
      }],
    }))
    expect(getAgent('legacy0001')?.channel).toBe('wecom')
    expect(toAgentView(getAgent('legacy0001')!).channel).toBe('wecom')
  })

  it('switches channels on rebind and requires pairing again', () => {
    const agent = createAgent({ name: 'Switcher', site_ids: ['example.com'], skill_names: [], bot_id: 'placeholder-wecom', secret: 'placeholder-secret' })
    expect(agent.channel).toBe('wecom')

    const switched = updateAgent(agent.id, { bot: { channel: 'weixin', bot_id: 'switch@im.bot', token: 'placeholder-switch-token', base_url: BASE_URL } })
    expect(switched.channel).toBe('weixin')
    expect(switched.wecom).toEqual({ bot_id: '', secret_enc: '' })
    expect(switched.pairing_code).toMatch(/^\d{6}$/)
    expect(findAgentByBotId('placeholder-wecom')).toBeNull()

    const back = updateAgent(agent.id, { bot: { bot_id: 'placeholder-wecom', secret: 'placeholder-secret' } })
    expect(back.channel).toBe('wecom')
    expect(back.weixin).toBeUndefined()
  })
})

describe('dedicated agent WeChat QR sessions', () => {
  const qr = { qrcode: 'fixture-qrcode', qrcode_img_content: 'https://example.com/fixture-qr' }

  it('keeps the bot token in backend memory and never returns it from poll', async () => {
    const pollQr = vi.fn()
      .mockResolvedValueOnce({ status: 'wait' })
      .mockResolvedValueOnce({ status: 'scaned' })
      .mockResolvedValueOnce({ status: 'confirmed', bot_token: 'placeholder-token', ilink_bot_id: 'fixture@im.bot', baseurl: BASE_URL })
    const fetchQr = vi.fn().mockResolvedValue(qr)
    const sessions = createWeixinQrSessions({ fetchQr, pollQr })
    const started = await sessions.start()
    expect(started.qr_url).toBe(qr.qrcode_img_content)
    expect(started).not.toHaveProperty('qrcode')
    expect(fetchQr).toHaveBeenCalledWith(BASE_URL)

    expect(await sessions.poll(started.session_id)).toEqual({ status: 'waiting' })
    expect(await sessions.poll(started.session_id)).toEqual({ status: 'scanned' })
    const confirmed = await sessions.poll(started.session_id)
    expect(confirmed).toEqual({ status: 'success', bot_id: 'fixture@im.bot' })
    expect(JSON.stringify(confirmed)).not.toContain('placeholder-token')
    expect(pollQr).toHaveBeenLastCalledWith(BASE_URL, 'fixture-qrcode')

    expect(sessions.peek(started.session_id)).toEqual({ botId: 'fixture@im.bot', token: 'placeholder-token', baseUrl: BASE_URL })
    expect(sessions.consume(started.session_id)?.token).toBe('placeholder-token')
    expect(sessions.consume(started.session_id)).toBeNull()
    expect(await sessions.poll(started.session_id)).toEqual({ status: 'expired' })
  })

  it('rejects login results on hosts outside the WeChat allowlist', async () => {
    const sessions = createWeixinQrSessions({
      fetchQr: async () => qr,
      pollQr: async () => ({ status: 'confirmed', bot_token: 'placeholder-token', baseurl: 'https://example.com' }),
    })
    const started = await sessions.start()
    await expect(sessions.poll(started.session_id)).rejects.toThrow('not allowed')
    expect(sessions.peek(started.session_id)).toBeNull()
  })

  it('expires sessions and hides upstream failures', async () => {
    let now = 0
    const sessions = createWeixinQrSessions({ fetchQr: async () => qr, pollQr: async () => ({ status: 'wait' }), now: () => now })
    const started = await sessions.start()
    now = WEIXIN_QR_SESSION_TTL_MS + 1
    expect(await sessions.poll(started.session_id)).toEqual({ status: 'expired' })

    const failing = createWeixinQrSessions({ fetchQr: async () => { throw new Error('fixture-upstream-detail') } })
    await expect(failing.start()).rejects.toThrow('获取微信二维码失败')
    const empty = createWeixinQrSessions({ fetchQr: async () => ({ qrcode: '', qrcode_img_content: '' }) })
    await expect(empty.start()).rejects.toThrow('有效二维码')
    const noToken = createWeixinQrSessions({ fetchQr: async () => qr, pollQr: async () => ({ status: 'confirmed' }) })
    await expect(noToken.poll((await noToken.start()).session_id)).rejects.toThrow('凭证')
  })
})
