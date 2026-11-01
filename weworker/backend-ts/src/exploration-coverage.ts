/**
 * 站点覆盖集：回答「这个站点是不是已经有确定性能力了」。
 *
 * 第 4 层是**兜底**，不是默认通道：只要某个站点已经有可直调工具（内置/用户安装的 adapter、
 * 探索固化出来的 toolkit skill），就不该再拉浏览器重探一遍——重探不只慢，探索成功后的固化
 * 会替换目标目录，等于把已有的、可能被人工修过的工具覆盖掉。
 *
 * 旧实现的问题（这次修的口径）：`buildKnownHosts()` 只读 adapter 的 `match`，而且用 host
 * **全等**比较，于是
 *   - 探索固化出的 toolkit 站点（`allowed_domains` 在 `.claude/skills` 里，压根不在
 *     `parseAllAdapters()` 的结果里）永远算「未注册」；
 *   - `www.example.com` 与 `example.com` 互不相等，同一个站点被当成两个；
 *   - `*.example.com` 这类通配 match 走 `new URL('https://*.example.com')` 直接抛错，被静默丢弃。
 * 三种情况都会让一个已被覆盖的站点重复进第 4 层。
 *
 * 本模块的判定方向刻意保守（宁可判「已覆盖」而少探索一次，也不重复探索）：父子域互相视为
 * 覆盖、忽略端口、忽略 `www.` 前缀、通配按基域处理。漏判的代价只是走一次 LLM（答案仍正确），
 * 误判的代价是覆盖用户已有工具——两者不对等。
 */
import type { ParsedAdapter } from './adapter-parser.js'
import { hostOf } from './exploration-url.js'

/** 覆盖来源，仅用于日志与排查（都等价于「不触发探索」）。 */
export type CoverageSource = 'adapter' | 'toolkit'

/** 覆盖来源的稳定排序：越靠前越「硬」（已安装的站点能力优先于探索产物）。 */
const SOURCE_ORDER: readonly CoverageSource[] = ['adapter', 'toolkit']

export interface SiteCoverage {
  /** host key（小写、去端口、去 `www.`、去通配前缀）→ 覆盖来源（已按 SOURCE_ORDER 排序） */
  hosts: Map<string, CoverageSource[]>
}

export interface SiteCoverageInput {
  /** 已注册 adapter（内置 + 用户安装 + 生成） */
  adapters?: Iterable<Pick<ParsedAdapter, 'match'>>
  /** 探索固化后的 toolkit skill（`allowed_domains` 即站点信号） */
  toolkitSkills?: Iterable<{ hosts?: string[] }>
}

/**
 * 站点键归一化：小写、去端口、去尾部点、去 `www.`、去 `*.` 通配前缀。
 *
 * 同时接受完整 URL、host:port、裸域与 `*.example.com` 四类输入——这些值来自四处不同的
 * 声明（manifest `match` / `allowed_domains` / 用户消息里的 URL），不归一就永远对不上。
 */
export function siteKey(raw: string): string {
  const text = String(raw ?? '').trim().toLowerCase()
  if (!text) return ''
  let host = text
  if (host.includes('://')) {
    host = hostOf(host)
    if (!host) return ''
  } else {
    host = host.split('/')[0].split('?')[0].split('#')[0]
  }
  host = host.replace(/:\d+$/, '').replace(/\.+$/, '')
  if (host.startsWith('*.')) host = host.slice(2)
  host = host.replace(/^\.+/, '').replace(/^www\./, '')
  return host
}

/** 收集当前环境里「已被覆盖」的站点。坏条目一律跳过，绝不抛（这个判定每回合都跑）。 */
export function collectSiteCoverage(input: SiteCoverageInput = {}): SiteCoverage {
  const collected = new Map<string, Set<CoverageSource>>()
  const add = (raw: string, source: CoverageSource) => {
    const key = siteKey(raw)
    if (!key) return
    const sources = collected.get(key) ?? new Set<CoverageSource>()
    sources.add(source)
    collected.set(key, sources)
  }

  for (const adapter of input.adapters ?? []) {
    for (const entry of adapter?.match ?? []) add(String(entry), 'adapter')
  }
  for (const skill of input.toolkitSkills ?? []) {
    for (const entry of skill?.hosts ?? []) add(String(entry), 'toolkit')
  }

  const hosts = new Map<string, CoverageSource[]>()
  for (const [key, sources] of collected) {
    const ordered = SOURCE_ORDER.filter((source) => sources.has(source))
    if (ordered.length) hosts.set(key, ordered)
  }
  return { hosts }
}

/**
 * 判断某个候选 URL 是否已被覆盖。
 *
 * 三个方向都算覆盖：URL 的 host（含逐级父域）、以及「覆盖项是子域、URL 是父域」的
 * 反向包含。反向那条是刻意的：manifest 只写了 `shop.example.com` 时，用户给
 * `https://example.com` 也不该再开一次探索——他十有八九指的是同一个站点。
 */
export function isHostCovered(
  url: string,
  coverage: SiteCoverage,
): { covered: boolean; by?: CoverageSource } {
  const key = siteKey(url)
  if (!key) return { covered: false }

  let current = key
  while (current) {
    const sources = coverage.hosts.get(current)
    if (sources && sources.length) return { covered: true, by: sources[0] }
    const dot = current.indexOf('.')
    if (dot < 0) break
    current = current.slice(dot + 1)
  }

  for (const [host, sources] of coverage.hosts) {
    if (host.endsWith(`.${key}`)) return { covered: true, by: sources[0] }
  }
  return { covered: false }
}
