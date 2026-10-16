/**
 * 会话级大结果落盘 + TTL 缓存。
 *
 * runWebcliCall 拿到工具输出后，若超过 LARGE_OUTPUT_THRESHOLD_CHARS，则把整份
 * 结果写入 <userDir>/tool-results/<workId>/<tool>-<ts>.json，并返回精简指针
 * （含可读 summary）；模型永远不直接吃超大文本。后续按需读取由 webcli_result
 * 投影工具完成（见 webcli-result-project.ts）。
 *
 * 时限：以文件 mtime 为基准，超过 WEBCLI_RESULT_CACHE_TTL_MS 视为过期——读时
 * 返回 cache_expired、内存表判 miss；每次落盘后顺带清扫该 workId 目录下的过期
 * 文件。镜像 encryption-check-cache.ts 的 30 分钟 TTL 先例。
 */
import fs from 'node:fs'
import path from 'node:path'
import { getUserDirectory } from './config.js'
import { detectMainArray } from './webcli-result-project.js'
import { createLogger } from './logger.js'

const log = createLogger('webcli-result-cache')

/** 大结果判定阈值：超过则落盘（字符数）。保守取 16k，远低于 SDK 的应急截断线。 */
export const LARGE_OUTPUT_THRESHOLD_CHARS = 16000
/** 缓存有效期，默认 30 分钟（工单状态会变，过期即视为失效）。 */
export const WEBCLI_RESULT_CACHE_TTL_MS = 30 * 60 * 1000

interface LatestEntry {
  file: string
  tool: string
  savedAt: number
}

const _latestByWork = new Map<string, LatestEntry>()

/** 仅供测试重置内存表。 */
export function _resetWebcliResultCacheForTests(): void {
  _latestByWork.clear()
}

function resolveRoot(rootDir?: string): string {
  return path.resolve(rootDir ?? getUserDirectory())
}

/** 把 workId / toolName 规整成安全的文件名片段（去路径分隔符，防穿越）。 */
function sanitizeSegment(input: string, fallback: string): string {
  const cleaned = String(input ?? '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.+/g, '.').replace(/^[-_.]+|[-_.]+$/g, '')
  return cleaned || fallback
}

function assertInsideRoot(filePath: string, root: string): void {
  const resolved = path.resolve(filePath)
  const rel = path.relative(path.resolve(root), resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`cache file escapes root: ${resolved} (root=${root})`)
  }
}

function cacheDirFor(workId: string | null | undefined, rootDir?: string): string {
  const root = resolveRoot(rootDir)
  return path.join(root, 'tool-results', sanitizeSegment(workId || 'no-work', 'no-work'))
}

function fileMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs
  } catch {
    return null
  }
}

/** 文件是否存在且未过期。ttlMs<=0 表示不校验 TTL。 */
export function isCacheFresh(filePath: string, ttlMs = WEBCLI_RESULT_CACHE_TTL_MS): boolean {
  const mtime = fileMtimeMs(filePath)
  if (mtime == null) return false
  if (ttlMs <= 0) return true
  return Date.now() - mtime < ttlMs
}

/** 返回某 workId 最近一次大结果文件路径；过期或缺失返回 null（并清理内存表）。 */
export function getLatestCacheFile(
  workId: string | null | undefined,
  opts: { ttlMs?: number; rootDir?: string } = {},
): string | null {
  const key = workId || 'no-work'
  const entry = _latestByWork.get(key)
  if (!entry) return null
  if (!isCacheFresh(entry.file, opts.ttlMs) || fileMtimeMs(entry.file) == null) {
    _latestByWork.delete(key)
    return null
  }
  return entry.file
}

/** 清扫某 workId 目录下 mtime 早于 TTL 的缓存文件。失败不抛。 */
export function sweepWorkCache(
  workId: string | null | undefined,
  opts: { ttlMs?: number; rootDir?: string } = {},
): number {
  const ttlMs = opts.ttlMs ?? WEBCLI_RESULT_CACHE_TTL_MS
  if (ttlMs <= 0) return 0
  const dir = cacheDirFor(workId, opts.rootDir)
  let removed = 0
  let entries: string[] = []
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return 0
  }
  const now = Date.now()
  for (const name of entries) {
    const full = path.join(dir, name)
    const mtime = fileMtimeMs(full)
    if (mtime == null) continue
    if (now - mtime >= ttlMs) {
      try {
        fs.unlinkSync(full)
        removed++
      } catch (e) {
        log.warn?.(`failed to remove expired cache file ${full}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
  return removed
}

export interface SaveResult {
  filePath: string
  savedAt: number
  bytes: number
  obj: unknown
}

/** 把完整输出落盘，登记到内存表，并清扫过期文件。 */
export function saveLargeResult(
  toolName: string,
  output: string,
  workId: string | null | undefined,
  opts: { rootDir?: string; now?: number } = {},
): SaveResult {
  const root = resolveRoot(opts.rootDir)
  const dir = cacheDirFor(workId, opts.rootDir)
  const now = opts.now ?? Date.now()
  const file = path.join(dir, `${sanitizeSegment(toolName, 'tool')}-${now}.json`)
  assertInsideRoot(file, root)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, output, 'utf8')

  const key = (workId || 'no-work')
  _latestByWork.set(key, { file, tool: toolName, savedAt: now })

  let obj: unknown = null
  try {
    obj = JSON.parse(output)
  } catch {
    obj = null
  }

  try {
    sweepWorkCache(workId, { rootDir: opts.rootDir })
  } catch (e) {
    log.warn?.(`sweepWorkCache failed (ignored): ${e instanceof Error ? e.message : String(e)}`)
  }

  return { filePath: file, savedAt: now, bytes: Buffer.byteLength(output, 'utf8'), obj }
}

/** 读取并解析缓存文件为对象（调用方负责路径校验）。 */
export function readCacheResult(filePath: string): unknown {
  const text = fs.readFileSync(filePath, 'utf8')
  try {
    return JSON.parse(text)
  } catch {
    return { _rawText: text }
  }
}

/**
 * fast-path 回读：把 `large_output` 指针还原成落盘内容的 JSON 串。
 *
 * LLM 路径上指针就是终点——模型按需用 `webcli_result` 工具回读文件。但路由 fast-path 回合
 * **零 LLM**，落库的只有渲染出的那段 md，指针便成了「查到了但没给数据」。调用方（渲染期）
 * 用本函数把内容取回来自己渲染。
 *
 * 任一条不成立即返回 null，调用方退回指针文案（行为与不做回读完全一致）：
 * 不是指针 / 路径越出缓存根 / 文件不存在或已过期 TTL / 内容读不出来。
 */
export function rehydratePointer(pointerText: string, rootDir?: string): string | null {
  let record: any
  try {
    record = JSON.parse(pointerText)
  } catch {
    return null
  }
  if (!record || typeof record !== 'object' || record.type !== 'large_output') return null
  const file = typeof record.file === 'string' ? record.file : ''
  if (!file) return null
  try {
    assertInsideRoot(file, resolveRoot(rootDir))
    if (!isCacheFresh(file)) return null
    return JSON.stringify(readCacheResult(file))
  } catch (e) {
    log.warn(`rehydrate skipped: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

export interface PointerOptions {
  rootDir?: string
  ttlMs?: number
}

/** 从落盘结果里取一行表头 + 计数，供指针 minimal 内联。不读条目内容。 */
function buildHeader(obj: unknown): { count: number | null; header: string } {
  let count: number | null = null
  const o = obj as any
  if (o && typeof o === 'object') {
    if (typeof o.count === 'number') count = o.count
    else if (typeof o.total === 'number') count = o.total
    else {
      const main = detectMainArray(o)
      if (main) count = main.array.length
    }
  }
  const parts: string[] = []
  if (o?.mode) parts.push(`mode=${o.mode}`)
  if (count != null) parts.push(`count=${count}`)
  return { count, header: parts.join('  ') || '(已落盘大结果)' }
}

/**
 * 若 output 超阈则落盘并返回**最小指针**（只含 file/count/一行表头，不含条目内容）；
 * 否则返回 null（调用方原样返回 output）。
 *
 * 设计：不把数据内联进指针，避免超大文本在后续每个推理回合被反复重扫。
 * 模型在汇总阶段按需用 webcli_result 工具读取对应文件。
 */
export function offloadIfLarge(
  toolName: string,
  output: string,
  workId: string | null | undefined,
  opts: PointerOptions = {},
): string | null {
  if (typeof output !== 'string' || output.length <= LARGE_OUTPUT_THRESHOLD_CHARS) {
    return null
  }
  const { filePath, savedAt, bytes, obj } = saveLargeResult(toolName, output, workId, opts)
  const { count, header } = buildHeader(obj)
  const pointer = {
    type: 'large_output',
    tool: toolName,
    file: filePath,
    bytes,
    count,
    header,
    savedAt: new Date(savedAt).toISOString(),
    ttlMs: opts.ttlMs ?? WEBCLI_RESULT_CACHE_TTL_MS,
    hint: '完整结果已落盘，这里只给计数与表头，不含具体数据。需要内容时用 webcli_result 工具读取本文件（mode=summary 看总览 / page 分页 / pick 挑字段 / item 看单条），不要重跑原查询、也不要用 shell 自行解析。',
  }
  return JSON.stringify(pointer, null, 2)
}
