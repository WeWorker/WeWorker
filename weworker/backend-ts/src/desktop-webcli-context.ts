/**
 * 普通桌面聊天的 WebCLI 多轮关联（进程内、按 work/turn 隔离）。
 *
 * 三条硬边界（见 openspec/changes/add-desktop-contextual-quick-replies）：
 * 1. 回执不是证据：只有 `WEBCLI_CONTEXT` 回执 + 实际交付正文里可核对的编号/身份才登记；
 *    普通 Shell、模型自报、CLI status 查询都不能开通直答。
 * 2. 只信当前展示：较新的列表拿不到可信登记就禁用直答，绝不静默回退到更早快照。
 * 3. 生命周期只在进程内：重启后旧关联不复用；取消/失败回合的迟到回执不开启任何能力。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveWebcliEntry } from './webcli-path.js'
import { resolveDispatchTimeoutMs } from './api-query-router/route-dispatch.js'
import { runWebcliCallEx } from './webcli-runner.js'
import type { WebcliContextReceipt } from './webcli-runner.js'

const execFileAsync = promisify(execFile)

/** 快捷路径可引用的当前展示；displayVersion 来自登记成功后的 CLI 响应。 */
export interface DesktopDisplayRecord {
  contextId: string
  epoch?: string
  revision?: number
  roundId?: string | null
  snapshotId: string
  displayVersion: string
  /** 与 identities 一一对应；顺序即登记的展示顺序。 */
  orderedEntityRefs: readonly string[]
  completeness: 'complete' | 'page' | 'truncated' | 'unknown'
  turnId: string
  registeredAt: number
}

type PendingReceipt = { turnId: string; receipt: WebcliContextReceipt; receivedAt: number }
type WorkState = {
  contextId: string | null
  current: DesktopDisplayRecord | null
  pending: PendingReceipt[]
  activeTurn?: string
}

const MAX_WORKS = 64
const PENDING_TTL_MS = 5 * 60_000

const works = new Map<string, WorkState>()

function stateFor(workId: string): WorkState {
  let state = works.get(workId)
  if (!state) {
    state = { contextId: null, current: null, pending: [] }
    works.set(workId, state)
    while (works.size > MAX_WORKS) {
      const oldest = works.keys().next().value!
      if (oldest === workId) break
      works.delete(oldest)
    }
  }
  return state
}

export function beginDesktopTurn(workId: string, turnId: string): void {
  const state = stateFor(workId)
  state.activeTurn = turnId
  state.pending = []
}

export function forgetDesktopContext(workId: string): void {
  works.delete(workId)
}

function prunePending(state: WorkState): void {
  const now = Date.now()
  state.pending = state.pending.filter(entry => now - entry.receivedAt < PENDING_TTL_MS)
}

/** snapshotDisplay.markdown 的行：| 序号 | 对象(businessId) | 标题 | 状态 |。 */
function parseManifestIdentities(markdown: string | undefined, count: number): string[] {
  if (!markdown || count <= 0) return []
  const rows = markdown.split(/\r?\n/).filter(line => /^\|\s*\d+\s*\|/.test(line))
  const identities: string[] = []
  for (const row of rows.slice(0, count)) {
    const cells = row.split('|').slice(1, -1).map(cell => cell.trim())
    // 序号列之后依次是 对象/标题（snapshotDisplay 合同）；空表或列数不足视为不可核对。
    const rawBusinessId = cells[1] ?? ''
    const unescape = (value: string): string => value
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      .replace(/\\(.)/g, '$1')
    const businessId = unescape(rawBusinessId)
    const usable = (value: string) => value && value !== 'undefined' && value !== 'null' && !/^\s*$/.test(value)
    identities.push(usable(businessId) ? businessId : '')
  }
  return identities
}

/**
 * 逐个核对 identities 在交付正文中的位置：必须严格递增；遇到第一个缺失即停，
 * 只保留之前连续命中的前缀（无法归属的编号与其后内容一律不登记）。
 */
function verifiedPrefix(deliveredText: string, identities: readonly string[]): number {
  const rows = deliveredText.split(/\r?\n/).filter(line => /^\s*(?:\|\s*\d+\s*\||\d+[.、)]\s+)/.test(line))
  if (!rows.length || rows.length > identities.length || new Set(identities).size !== identities.length
    || /^(?:\s*```|\s*~~~)/m.test(deliveredText)) return 0
  let matched = 0
  for (const identity of identities) {
    if (!identity) return 0
    const row = rows[matched]
    if (!row || Number(row.match(/\d+/)?.[0]) !== matched + 1) return 0
    const tokens = row.replace(/^\s*(?:\|\s*\d+\s*\||\d+[.、)]\s+)/, '').split(/[\s|`()[\]]+/)
    if (!tokens.includes(identity) || identities.some(other => other !== identity && tokens.includes(other))) return 0
    matched += 1
    if (matched === rows.length) break
  }
  return matched
}

/** Add visible ordinals to a single deterministic table only when its row identities match the receipt. */
export function numberDesktopResult(workId: string, turnId: string, text: string): string {
  const state = works.get(workId)
  if (state?.activeTurn !== turnId || state.pending.length !== 1) return text
  const manifest = state.pending[0].receipt.displayManifest
  if (!manifest?.orderedEntityRefs) return text
  const lines = text.split('\n')
  const table = lines.map((line, index) => line.startsWith('| ') ? index : -1).filter(index => index >= 0)
  if (table.length < 3 || table.some((index, i) => index !== table[0] + i)) return text
  const numbered = [...lines]
  for (const [i, index] of table.entries()) {
    numbered[index] = '| ' + (i === 0 ? '序号' : i === 1 ? '---' : String(i - 1)) + ' ' + lines[index]
  }
  const result = numbered.join('\n')
  const identities = parseManifestIdentities(manifest.markdown, manifest.orderedEntityRefs.length)
  return verifiedPrefix(result, identities) === table.length - 2 ? result : text
}

export function currentDesktopContextId(workId: string): string | null {
  return works.get(workId)?.contextId ?? null
}

export function currentDesktopDisplay(workId: string): DesktopDisplayRecord | null {
  return works.get(workId)?.current ?? null
}

export function clearDesktopDisplay(workId: string): void {
  const state = works.get(workId)
  if (state) state.current = null
}

/** 新查询建立了快照 → 成为当前展示；否则是未映射查询/非列表 → 旧展示视为被替代，禁用直答。 */
export function recordWebcliReceipt(workId: string, turnId: string, receipt: WebcliContextReceipt): void {
  const state = works.get(workId)
  if (state?.activeTurn !== turnId) return
  if (receipt.contextProtocolVersion !== 1 || receipt.contextPersistence !== 'committed') return
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(receipt.contextId) || (state.contextId && receipt.contextId !== state.contextId)) return
  state.contextId = receipt.contextId
  prunePending(state)
  const snapshotId = typeof receipt.snapshotId === 'string' && receipt.snapshotId ? receipt.snapshotId : null
  if (!snapshotId) {
    if (receipt.toolOutcome === 'read_success' || receipt.toolOutcome === 'untracked') {
      state.current = null
      state.pending = []
    }
    return
  }
  const manifest = receipt.displayManifest
  if (receipt.toolOutcome !== 'read_success' || receipt.displayState !== 'staged' || !receipt.epoch || !receipt.roundId
    || !Number.isSafeInteger(receipt.revision)) return
  if (!manifest || !Array.isArray(manifest.orderedEntityRefs) || manifest.orderedEntityRefs.length === 0) {
    state.current = null
    return
  }
  if (state.pending.length < 2) state.pending.push({ turnId, receipt, receivedAt: Date.now() })
}

export interface DisplayRegistrationPlan {
  contextId: string
  epoch?: string
  revision?: number
  roundId?: string | null
  snapshotId: string
  orderedEntityRefs: string[]
  completeness: 'complete' | 'page' | 'truncated' | 'unknown'
}

/** 从本回合的待登记回执中挑出能与交付正文唯一核对的计划；没有合格候选返回 null。 */
export function planDeliveredDisplay(workId: string, turnId: string, deliveredText: string): DisplayRegistrationPlan | null {
  const state = works.get(workId)
  if (state?.activeTurn !== turnId || !state.contextId || !deliveredText?.trim()) return null
  prunePending(state)
  const candidates = state.pending.filter(entry => entry.turnId === turnId)
  state.current = null
  state.pending = state.pending.filter(entry => entry.turnId !== turnId)
  // 多份候选无法唯一归属，宁可放弃直答。
  for (const entry of candidates.length === 1 ? candidates : []) {
    const { receipt } = entry
    const manifest = receipt.displayManifest
    if (!manifest || !Array.isArray(manifest.orderedEntityRefs) || manifest.orderedEntityRefs.length === 0) continue
    if (typeof receipt.snapshotId !== 'string' || !receipt.snapshotId) continue
    const identities = parseManifestIdentities(manifest.markdown, manifest.orderedEntityRefs.length)
    const matchedCount = verifiedPrefix(deliveredText, identities)
    if (matchedCount === 0) continue
    const refs = manifest.orderedEntityRefs.slice(0, matchedCount)
    const completeness: DisplayRegistrationPlan['completeness']
      = matchedCount === manifest.orderedEntityRefs.length && manifest.completeness === 'complete' ? 'complete' : 'unknown'
    return {
      contextId: state.contextId,
      epoch: typeof receipt.epoch === 'string' ? receipt.epoch : undefined,
      revision: typeof receipt.revision === 'number' ? receipt.revision : undefined,
      roundId: typeof receipt.roundId === 'string' ? receipt.roundId : null,
      snapshotId: receipt.snapshotId,
      orderedEntityRefs: refs,
      completeness,
    }
  }
  return null
}

/** 通过真实 CLI 登记展示；失败（含 CLI 拒绝）时清除当前展示，宁可少命中。 */
export async function commitDeliveredDisplay(
  workId: string,
  turnId: string,
  deliveredText: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<boolean> {
  if (options.signal?.aborted) return false
  const plan = planDeliveredDisplay(workId, turnId, deliveredText)
  if (!plan) return false
  const displayArgs = ['context', 'display', plan.contextId,
    '--epoch', plan.epoch ?? '', '--revision', String(plan.revision ?? 0),
    '--round', plan.roundId ?? '', '--snapshot', plan.snapshotId,
    '--args', JSON.stringify({ orderedEntityRefs: plan.orderedEntityRefs, completeness: plan.completeness, delivered: true })]
  let displayVersion: string | null = null
  try {
    const isPackaged = !!process.env.WEWORKER_PACKAGED
    const nodeBin = isPackaged ? (process.env.WEWORKER_EXEC_PATH || process.execPath) : 'node'
    const { stdout } = await execFileAsync(nodeBin, [resolveWebcliEntry(), ...displayArgs], {
      env: { ...process.env, ...(isPackaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}), WEBCLI_EMBEDDED: '1', WEBCLI_CLI_NAME: 'webgo' },
      timeout: options.timeoutMs ?? 3000,
      signal: options.signal,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    })
    const parsed = JSON.parse(stdout) as { contextProtocolVersion?: number; display?: { version?: string } }
    displayVersion = parsed.contextProtocolVersion === 1 && typeof parsed?.display?.version === 'string' ? parsed.display.version : null
  } catch {
    return false
  }
  const state = works.get(workId)
  if (!displayVersion || state?.activeTurn !== turnId || options.signal?.aborted) return false
  state.current = {
    contextId: plan.contextId,
    epoch: plan.epoch,
    revision: plan.revision,
    roundId: plan.roundId,
    snapshotId: plan.snapshotId,
    displayVersion,
    orderedEntityRefs: plan.orderedEntityRefs,
    completeness: plan.completeness,
    turnId,
    registeredAt: Date.now(),
  }
  return true
}

export function discardDesktopTurn(workId: string, turnId: string): void {
  const state = works.get(workId)
  if (state?.activeTurn !== turnId) return
  state.activeTurn = undefined
  state.pending = []
}

/**
 * 桌面直调的关联派发器：同一 Runner，附带 --new-context/--context 并旁路接收回执。
 * 仅普通桌面聊天使用；返回签名与 RouteDispatchFn 兼容。
 */
export function createDesktopTrackedDispatch(workId: string, turnId: string, signal?: AbortSignal): (tool: string, argsJson: string, callerWorkId: string) => Promise<string> {
  return async (tool, argsJson, callerWorkId) => runWebcliCallEx(tool, argsJson, callerWorkId, {
    timeoutMs: resolveDispatchTimeoutMs(),
    signal,
    context: currentDesktopContextId(workId) ? { contextId: currentDesktopContextId(workId)! } : { newContext: true },
    onReceipt: receipt => recordWebcliReceipt(workId, turnId, receipt),
  })
}

export function _resetDesktopWebcliContextForTests(): void {
  works.clear()
}
