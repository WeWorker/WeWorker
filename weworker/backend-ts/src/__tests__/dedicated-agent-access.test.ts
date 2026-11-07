import { describe, expect, it } from 'vitest'
import { decideAgentAccess, extractPairingCode, type PairingAttempts } from '../dedicated-agents/agent-channel.js'
import type { DedicatedAgentRecord } from '../dedicated-agents/agent-store.js'
import { parseChannelCommand } from '../channels/wecom-channel.js'

function agent(overrides: Partial<DedicatedAgentRecord> = {}): DedicatedAgentRecord {
  return {
    id: 'agent0001',
    name: 'Example Operations Assistant',
    description: '',
    site_ids: ['example.com'],
    skill_names: [],
    work_dir: '',
    examples: ['Check today\'s orders'],
    enabled: true,
    wecom: { bot_id: 'placeholder-bot', secret_enc: 'placeholder' },
    owner_user_id: '',
    pairing_code: '123456',
    access_mode: 'owner_only',
    work_ids: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const site = { name: 'Example', enabled: true, exists: true }

function decide(record: DedicatedAgentRecord, userId: string, text: string, attempts: PairingAttempts = new Map(), now = 0, sites = [site]) {
  const paired: string[] = []
  const decision = decideAgentAccess({
    agent: record,
    userId,
    text,
    sites,
    attempts,
    now,
    onPair: (owner) => {
      paired.push(owner)
      return { ...record, owner_user_id: owner, pairing_code: '' }
    },
  })
  return { decision, paired }
}

describe('dedicated agent access', () => {
  it('extracts pairing codes in common formats', () => {
    expect(extractPairingCode('123456')).toBe('123456')
    expect(extractPairingCode('绑定 123456')).toBe('123456')
    expect(extractPairingCode('/bind 123456')).toBe('123456')
    expect(extractPairingCode('配对：123456')).toBe('123456')
    expect(extractPairingCode('12345')).toBeNull()
    expect(extractPairingCode('order 123456')).toBeNull()
  })

  it('pairs the first user who sends the right code', () => {
    const { decision, paired } = decide(agent(), 'owner-user', '绑定 123456')
    expect(paired).toEqual(['owner-user'])
    expect(decision).toMatchObject({ kind: 'reply' })
    expect((decision as { text: string }).text).toContain('绑定成功')
  })

  it('asks unpaired users for the code without running the agent', () => {
    const { decision, paired } = decide(agent(), 'someone', 'hello')
    expect(paired).toEqual([])
    expect(decision.kind).toBe('reply')
    expect((decision as { text: string }).text).toContain('绑定码')
  })

  it('locks pairing after repeated wrong codes', () => {
    const attempts: PairingAttempts = new Map()
    for (let index = 0; index < 5; index += 1) decide(agent(), 'guesser', '000000', attempts, 1000)
    const locked = decide(agent(), 'guesser', '123456', attempts, 2000)
    expect(locked.paired).toEqual([])
    expect((locked.decision as { text: string }).text).toContain('10 分钟')
    const later = decide(agent(), 'guesser', '123456', attempts, 2000 + 10 * 60_000 + 1)
    expect(later.paired).toEqual(['guesser'])
  })

  it('serves only the owner after pairing in the default private mode', () => {
    const owned = agent({ owner_user_id: 'owner-user', pairing_code: '' })
    expect(decide(owned, 'owner-user', 'Check stock').decision).toEqual({ kind: 'allow', mode: 'full' })
    const stranger = decide(owned, 'someone-else', 'Check stock').decision
    expect(stranger.kind).toBe('reply')
    expect((stranger as { text: string }).text).toContain('仅允许它的主人')
  })

  it('allows WeCom-authorized users when sharing is enabled', () => {
    const shared = agent({ owner_user_id: 'owner-user', pairing_code: '', access_mode: 'wecom_authorized' })
    expect(decide(shared, 'owner-user', 'Check stock').decision).toEqual({ kind: 'allow', mode: 'full' })
    expect(decide(shared, 'authorized-user', 'Check stock').decision).toEqual({ kind: 'allow', mode: 'full' })
    const weixin = agent({ channel: 'weixin', owner_user_id: 'owner-user', pairing_code: '', access_mode: 'wecom_authorized' })
    expect(decide(weixin, 'someone-else', 'Check stock').decision.kind).toBe('reply')
  })

  it('stops serving when disabled or when every bound site is off', () => {
    expect(decide(agent({ enabled: false, owner_user_id: 'owner-user' }), 'owner-user', 'hi').decision.kind).toBe('reply')
    const decision = decideAgentAccess({
      agent: agent({ owner_user_id: 'owner-user' }),
      userId: 'owner-user',
      text: 'hi',
      sites: [{ name: 'Example', enabled: false, exists: true }],
      attempts: new Map(),
      now: 0,
      onPair: () => { throw new Error('should not pair') },
    })
    expect(decision.kind).toBe('reply')
  })

  it('keeps serving while at least one bound site is usable, and with no sites at all', () => {
    const multiSite = agent({ site_ids: ['example.com', 'example.org'], owner_user_id: 'owner-user' })
    const sites = [
      { name: 'Example', enabled: false, exists: true },
      { name: 'Org', enabled: true, exists: true },
    ]
    expect(decide(multiSite, 'owner-user', 'hi', new Map(), 0, sites).decision).toEqual({ kind: 'allow', mode: 'full' })
    const noSites = agent({ site_ids: [], owner_user_id: 'owner-user' })
    expect(decide(noSites, 'owner-user', 'hi', new Map(), 0, []).decision).toEqual({ kind: 'allow', mode: 'full' })
  })

  it('always answers /myid', () => {
    const { decision } = decide(agent(), 'someone', '/myid')
    expect((decision as { text: string }).text).toContain('someone')
  })
})

describe('channel command parsing', () => {
  it.each([
    ['/new', '/new'],
    ['／new', '/new'],
    ['\u200B/new\u200B', '/new'],
    ['/NEW。', '/new'],
    ['新对话', '/new'],
    ['/reset', '/new'],
    ['/stop', '/stop'],
    ['停止！', '/stop'],
    ['/help', '/help'],
    ['帮助', '/help'],
    ['/id', '/id'],
    ['/myid', '/myid'],
    ['/targetid', '/targetid'],
    ['/chatid', '/targetid'],
    ['当前会话ID', '/targetid'],
  ])('recognizes %j', (input, expected) => {
    expect(parseChannelCommand(input)).toBe(expected)
  })

  it('ignores ordinary messages', () => {
    expect(parseChannelCommand('please start a new report')).toBeNull()
    expect(parseChannelCommand('')).toBeNull()
  })
})
