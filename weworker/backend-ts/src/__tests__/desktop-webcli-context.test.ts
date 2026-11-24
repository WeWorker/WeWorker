import { promisify } from 'node:util'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const displayCall = vi.hoisted(() => vi.fn())
// 与真实 child_process.execFile 相同的 custom promisify 合同（resolve {stdout, stderr}）。
const execFile = Object.assign((...args: unknown[]) => displayCall(...args), {
  [promisify.custom]: (file: string, args: string[], opts: unknown) => new Promise((resolve, reject) => {
    displayCall(file, args, opts, (error: (Error & { stdout?: string; stderr?: string }) | null, stdout: string, stderr: string) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error) } else resolve({ stdout, stderr })
    })
  }),
})
vi.mock('node:child_process', () => ({ execFile }))
vi.mock('../webcli-path.js', () => ({ resolveWebcliEntry: () => 'webcli-entry.js' }))

const receiptBase = {
  contextProtocolVersion: 1,
  contextId: 'ctx-abc',
  contextPersistence: 'committed',
  displayState: 'staged',
  toolOutcome: 'read_success',
  epoch: 'e1',
  revision: 7,
  roundId: 'round-1',
}

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...receiptBase, snapshotId: 'snap-1',
    displayManifest: {
      orderedEntityRefs: ['ref-1', 'ref-2', 'ref-3'],
      completeness: 'complete',
      capturedCount: 3,
      resultCount: 3,
      markdown: '| 序号 | 对象 | 标题 | 状态 |\n| --- | --- | --- | --- |\n| 1 | id-alpha | First paper | ok |\n| 2 | id-beta | Second paper | ok |\n| 3 | id-gamma | Third paper | ok |',
    },
    ...overrides }
}

function flushDisplay(version = 'dv-1'): void {
  displayCall.mockImplementationOnce((_f: string, _a: string[], _o: Record<string, unknown>, cb: (e: null, out: string) => void) =>
    cb(null, JSON.stringify({ contextProtocolVersion: 1, display: { version } })))
}

async function commit(workId: string, turnId: string, text: string): Promise<boolean> {
  const { commitDeliveredDisplay } = await import('../desktop-webcli-context.js')
  return commitDeliveredDisplay(workId, turnId, text)
}

describe('desktop webcli context registry', () => {
  beforeEach(async () => {
    displayCall.mockReset()
    const mod = await import('../desktop-webcli-context.js')
    mod._resetDesktopWebcliContextForTests()
    mod.beginDesktopTurn('work-a', 't1')
  })

  it('adds visible ordinal numbers only to an identity-matched deterministic table', async () => {
    const { numberDesktopResult, recordWebcliReceipt } = await import('../desktop-webcli-context.js')
    recordWebcliReceipt('work-a', 't1', receipt() as never)
    const table = '| 编号 | 标题 |\n| --- | --- |\n| id-alpha | First |\n| id-beta | Second |'
    expect(numberDesktopResult('work-a', 't1', table)).toContain('| 2 | id-beta | Second |')
    const unrelated = table.replace('id-beta', 'other-id')
    expect(numberDesktopResult('work-a', 't1', unrelated)).toBe(unrelated)
  })

  it('registers only when delivered text verifies every prefix identity in order', async () => {
    const { recordWebcliReceipt, currentDesktopDisplay } = await import('../desktop-webcli-context.js')
    recordWebcliReceipt('work-a', 't1', receipt() as never)
    flushDisplay()
    expect(await commit('work-a', 't1', '查询结果：\n| 1 | id-alpha | First paper |\n| 2 | id-beta | Second paper |\n| 3 | id-gamma | Third paper |')).toBe(true)
    const current = currentDesktopDisplay('work-a')
    expect(current).toMatchObject({ contextId: 'ctx-abc', snapshotId: 'snap-1', displayVersion: 'dv-1', completeness: 'complete' })
    expect(current?.orderedEntityRefs).toEqual(['ref-1', 'ref-2', 'ref-3'])
  })

  it('registers a contiguous displayed prefix when the rendered table is truncated', async () => {
    const { recordWebcliReceipt, currentDesktopDisplay } = await import('../desktop-webcli-context.js')
    recordWebcliReceipt('work-a', 't1', receipt({ displayManifest: {
      orderedEntityRefs: ['ref-1', 'ref-2', 'ref-3'], completeness: 'complete', capturedCount: 3, resultCount: 3,
      markdown: '| 序号 | 对象 | 标题 | 状态 |\n| --- | --- | --- | --- |\n| 1 | id-alpha | First paper | ok |\n| 2 | id-beta | Second paper | ok |\n| 3 | id-gamma | Third paper | ok |',
    } }) as never)
    flushDisplay()
    expect(await commit('work-a', 't1', '| 1 | id-alpha | First paper |\n| 2 | id-beta | Second paper |')).toBe(true)
    expect(currentDesktopDisplay('work-a')?.orderedEntityRefs).toEqual(['ref-1', 'ref-2'])
    expect(currentDesktopDisplay('work-a')?.completeness).toBe('unknown')
  })

  it('clears instead of registering when nothing can be attributed (newer unverifiable list)', async () => {
    const { recordWebcliReceipt, currentDesktopDisplay } = await import('../desktop-webcli-context.js')
    ;(await import('../desktop-webcli-context.js')).beginDesktopTurn('work-a', 't0')
    recordWebcliReceipt('work-a', 't0', receipt() as never)
    flushDisplay()
    await commit('work-a', 't0', '1. id-alpha\n2. id-beta')
    ;(await import('../desktop-webcli-context.js')).beginDesktopTurn('work-a', 't1')
    expect(currentDesktopDisplay('work-a')).not.toBeNull()
    // 新一轮流查询，正文无法核对 → 清除，不给旧列表直答资格
    recordWebcliReceipt('work-a', 't1', receipt({ roundId: 'round-2', snapshotId: 'snap-2' }) as never)
    expect(await commit('work-a', 't1', '共 3 条结果，未展示明细。')).toBe(false)
    expect(currentDesktopDisplay('work-a')).toBeNull()
  })

  it('unmapped successful read queries supersede the current display', async () => {
    const { recordWebcliReceipt, currentDesktopDisplay } = await import('../desktop-webcli-context.js')
    ;(await import('../desktop-webcli-context.js')).beginDesktopTurn('work-a', 't0')
    recordWebcliReceipt('work-a', 't0', receipt() as never)
    flushDisplay()
    await commit('work-a', 't0', '1. id-alpha')
    ;(await import('../desktop-webcli-context.js')).beginDesktopTurn('work-a', 't1')
    recordWebcliReceipt('work-a', 't1', { ...receiptBase, snapshotId: null, reasonCode: 'context_binding_unavailable' } as never)
    expect(currentDesktopDisplay('work-a')).toBeNull()
  })

  it('isolates pending receipts by turn and drops cancelled turns', async () => {
    const { recordWebcliReceipt, commitDeliveredDisplay, discardDesktopTurn, currentDesktopDisplay } = await import('../desktop-webcli-context.js')
    ;(await import('../desktop-webcli-context.js')).beginDesktopTurn('work-a', 't-turn')
    recordWebcliReceipt('work-a', 't-turn', receipt() as never)
    // 其他 turn 的提交不得消费这份回执
    expect(await commitDeliveredDisplay('work-a', 't-other', '1. id-alpha\n2. id-beta\n3. id-gamma')).toBe(false)
    discardDesktopTurn('work-a', 't-turn')
    expect(await commitDeliveredDisplay('work-a', 't-turn', '1. id-alpha\n2. id-beta\n3. id-gamma')).toBe(false)
    expect(currentDesktopDisplay('work-a')).toBeNull()
  })

  it('passes the exact epoch/revision/round/snapshot from the receipt to the CLI display command', async () => {
    const { recordWebcliReceipt } = await import('../desktop-webcli-context.js')
    recordWebcliReceipt('work-a', 't1', receipt() as never)
    flushDisplay()
    await commit('work-a', 't1', '1. id-alpha\n2. id-beta\n3. id-gamma')
    const args = displayCall.mock.calls.at(-1)![1] as string[]
    expect(args.slice(1, 10)).toEqual(['context', 'display', 'ctx-abc', '--epoch', 'e1', '--revision', '7', '--round', 'round-1'])
    const argsJson = JSON.parse(String(args[args.indexOf('--args') + 1]))
    expect(argsJson).toEqual({ orderedEntityRefs: ['ref-1', 'ref-2', 'ref-3'], completeness: 'complete', delivered: true })
  })

  it('clears the display when the CLI rejects the registration', async () => {
    const { recordWebcliReceipt, currentDesktopDisplay } = await import('../desktop-webcli-context.js')
    recordWebcliReceipt('work-a', 't1', receipt({ revision: 3 }) as never) // stale revision → CLI 拒绝
    displayCall.mockImplementationOnce((_f: string, _a: string[], _o: Record<string, unknown>, cb: (e: { code: number }, _o2: string, stderr: string) => void) =>
      cb({ code: 2 }, '', '{"error":"context_invalid_display"}'))
    expect(await commit('work-a', 't1', '1. id-alpha\n2. id-beta\n3. id-gamma')).toBe(false)
    expect(currentDesktopDisplay('work-a')).toBeNull()
  })

  it('rejects identity mentions without matching displayed ordinals and ignores late receipts', async () => {
    const { beginDesktopTurn, recordWebcliReceipt, currentDesktopDisplay } = await import('../desktop-webcli-context.js')
    recordWebcliReceipt('work-a', 't1', receipt() as never)
    expect(await commit('work-a', 't1', '1. id-beta\n2. id-alpha')).toBe(false)
    beginDesktopTurn('work-a', 't2')
    recordWebcliReceipt('work-a', 't1', receipt() as never)
    expect(await commit('work-a', 't2', '1. id-alpha')).toBe(false)
    expect(currentDesktopDisplay('work-a')).toBeNull()
    expect(displayCall).not.toHaveBeenCalled()
  })

  it('keeps works isolated from each other', async () => {
    const { recordWebcliReceipt, currentDesktopDisplay } = await import('../desktop-webcli-context.js')
    recordWebcliReceipt('work-a', 't1', receipt() as never)
    expect(currentDesktopDisplay('work-b')).toBeNull()
    flushDisplay()
    expect(await commit('work-b', 't1', '1. id-alpha\n2. id-beta\n3. id-gamma')).toBe(false)
    flushDisplay()
    expect(await commit('work-a', 't1', '1. id-alpha\n2. id-beta\n3. id-gamma')).toBe(true)
  })
})
