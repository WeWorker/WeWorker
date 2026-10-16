/**
 * 第4层毕业引导计数（`docs/intelligent_routing_design.md` §2 第 16 行）。
 *
 * 同一 host 每次第4层任务成功 +1（持久化 `CONFIG_DIR/tier4-usage.json`）；恰好第 N 次
 * （`WEWORKER_TIER4_GRADUATE_AFTER`，默认 3，0 = 关）在回合尾部提示可到网站探索agent
 * 固化 Toolkit、毕业为本地技能。**只提示，不自动生成**（自动生成会把一次成功当成能力验证）。
 *
 * 数据边界：`tier4-usage.json` 是 WeWorker 自己的计数，落在 `getConfigDirectory()`，
 * 不写网站探索agent的持久数据根。
 */
import fs from 'node:fs'
import path from 'node:path'
import { getConfigDirectory } from './config.js'

interface UsageStore {
  version: 1
  hosts: Record<string, { count: number; lastAt: string }>
}

export interface GraduationDeps {
  storePath?: string
  now?: () => Date
}

function readStore(storePath: string): UsageStore {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf-8')) as UsageStore
    if (raw && typeof raw === 'object' && raw.hosts && typeof raw.hosts === 'object') {
      return { version: 1, hosts: raw.hosts }
    }
  } catch {
    // 缺失/坏文件：按空档重新开始。
  }
  // 每次返回新对象——调用方会直接写入 store.hosts，不得共享可变引用。
  return { version: 1, hosts: {} }
}

function writeStore(storePath: string, store: UsageStore): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true })
  const tmp = `${storePath}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(store), 'utf-8')
  fs.renameSync(tmp, storePath)
}

function storePathOf(deps: GraduationDeps): string {
  return deps.storePath ?? path.join(getConfigDirectory(), 'tier4-usage.json')
}

/** 毕业提示阈值：0 = 关闭提示（计数仍记录）；未设/非法 = 默认 3。 */
export function graduationThreshold(): number {
  const raw = process.env.WEWORKER_TIER4_GRADUATE_AFTER
  if (raw === undefined || raw.trim() === '') return 3
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 3
}

/** host 第4层成功任务数 +1，返回新计数。 */
export function recordTier4HostUsage(host: string, deps: GraduationDeps = {}): number {
  const key = String(host || '').trim().toLowerCase()
  if (!key) return 0
  const storePath = storePathOf(deps)
  const store = readStore(storePath)
  const entry = store.hosts[key] ?? { count: 0, lastAt: '' }
  entry.count += 1
  entry.lastAt = (deps.now ?? (() => new Date()))().toISOString()
  store.hosts[key] = entry
  writeStore(storePath, store)
  return entry.count
}

/** 恰好在第 N 次提示一次（N+1、N-1 与后续都不提示）。 */
export function shouldSuggestGraduation(count: number): boolean {
  const threshold = graduationThreshold()
  return threshold > 0 && count === threshold
}

export function graduationHint(host: string, count: number): string {
  return (
    `\n\n💡 ${host} 已是第 ${count} 次由网站探索agent处理。` +
    '若这是常用站点，可在网站探索agent的 Toolkit 流程中把它固化为本地工具包并安装；' +
    '安装后此类请求会直接走本地工具，无需再逐次探索。\n入口：http://127.0.0.1:8766/ui'
  )
}
