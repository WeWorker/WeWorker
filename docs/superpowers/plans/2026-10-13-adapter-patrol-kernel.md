# Adapter 巡检内核 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `webcli/patrol/` 下做出可独立运行的巡检内核：枚举命令 → 并发执行 → 三层判定 → 基线 diff → 归类 → 出报告。

**Architecture:** 纯函数（形状提取 / 判定 / 归类 / 汇总）与副作用层（spawn 执行、基线读写、报告落盘）严格分离，纯函数全部单测。命令执行复用 `run-real-e2e.js` 已验证的 spawn 方式；判定复用既有 `safetyMode` 语义；基线只存形状声明、不存业务值。

**Tech Stack:** Node ≥18 ESM、node:child_process、node:fs、Vitest

**设计文档:** `docs/superpowers/specs/2026-10-10-adapter-daily-patrol-design.md`（总纲 `2026-10-13-adapter-health-suite-design.md`）

**说明：** 本计划只覆盖**巡检内核**。客户端集成（`scheduled_tasks` 加 `kind` 列、`task-executor` 分派、`patrol_runs` 表、通知、「立即跑一次」入口）是另一份计划。内核做完即可命令行单跑并产出报告，是独立的可交付物。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `webcli/patrol/shape.js` | 返回值形状提取与 diff（纯函数） | 新建 |
| `webcli/patrol/classify.js` | 三层判定与失效归类（纯函数） | 新建 |
| `webcli/patrol/enumerate.js` | 枚举巡检清单：adapter × 工具，匹配样本与基线 | 新建 |
| `webcli/patrol/probe.js` | 执行单条命令（spawn + 并发池 + 超时） | 新建 |
| `webcli/patrol/baseline.js` | 基线读写、首跑自建、更新预览 | 新建 |
| `webcli/patrol/ensure-login.js` | `ensureLogin(adapterId)` 接口与默认降级实现 | 新建 |
| `webcli/patrol/report.js` | 汇总报告（覆盖率优先 + 未覆盖清单 + 需重新取证） | 新建 |
| `webcli/patrol/index.js` | 编排与 CLI 入口 | 新建 |
| `webcli/patrol/baselines/<adapterId>.json` | 基线（入仓） | 运行期生成 |
| `webcli/__tests__/patrol-shape.test.js` 等 | 各纯函数单测 | 新建 |

## 前置约定

1. 所有命令在 `webcli/` 目录下执行
2. 新建 `.js` 文件保持 **LF** 换行；建完检查 `grep -c $'\r' <file>` 应为 0
3. 提交信息用仓库风格（`feat(webcli):` / `test(webcli):`）
4. 每步跑完相关测试再提交

---

### Task 1: 形状提取与 diff

**Files:**
- Create: `webcli/patrol/shape.js`
- Test: `webcli/__tests__/patrol-shape.test.js`

- [ ] **Step 1: 写失败的测试**

```js
import { describe, expect, it } from 'vitest'
import { diffShape, extractShape } from '../patrol/shape.js'

describe('extractShape', () => {
  it('提取标量字段的类型', () => {
    expect(extractShape({ title: 'a', price: 12 })).toEqual({ title: 'string', price: 'number' })
  })

  it('嵌套对象用点号路径', () => {
    expect(extractShape({ a: { b: 'x' } })).toEqual({ a: 'object', 'a.b': 'string' })
  })

  it('数组取首元素形状，路径用 [] 标记', () => {
    const shape = extractShape({ items: [{ id: 1, name: 'x' }] })
    expect(shape['items']).toBe('array')
    expect(shape['items[].id']).toBe('number')
    expect(shape['items[].name']).toBe('string')
  })

  it('空数组记为 empty-array（内容信号，不是结构）', () => {
    expect(extractShape({ items: [] })['items[]']).toBe('empty-array')
  })

  it('null 单独记类型', () => {
    expect(extractShape({ x: null }).x).toBe('null')
  })

  it('忽略数组里的 null 元素，取首个非空元素', () => {
    const shape = extractShape({ items: [null, { id: 1 }] })
    expect(shape['items[].id']).toBe('number')
  })

  it('超过最大深度即停（防爆栈）', () => {
    let deep = { v: 'leaf' }
    for (let i = 0; i < 12; i += 1) deep = { child: deep }
    expect(Object.keys(extractShape(deep)).length).toBeLessThan(10)
  })
})

describe('diffShape', () => {
  const base = { a: 'string', 'b.c': 'number', 'items[].id': 'number' }

  it('字段缺失算退化', () => {
    const r = diffShape(base, { a: 'string', 'items[].id': 'number' })
    expect(r.degraded).toBe(true)
    expect(r.missing).toEqual([{ path: 'b.c', baselineType: 'number' }])
  })

  it('类型变化算退化', () => {
    const r = diffShape(base, { a: 'number', 'b.c': 'number', 'items[].id': 'number' })
    expect(r.degraded).toBe(true)
    expect(r.typeChanged).toEqual([{ path: 'a', baselineType: 'string', currentType: 'number' }])
  })

  it('新增字段不算退化，只记 added', () => {
    const r = diffShape(base, { ...base, extra: 'boolean' })
    expect(r.degraded).toBe(false)
    expect(r.added).toEqual(['extra'])
  })

  it('数组变空不算结构退化，交给内容层', () => {
    const r = diffShape(base, { a: 'string', 'b.c': 'number', 'items[]': 'empty-array' })
    expect(r.degraded).toBe(false)
    expect(r.emptied).toEqual(['items'])
  })

  it('完全一致时无退化无新增', () => {
    const r = diffShape(base, base)
    expect(r).toMatchObject({ degraded: false, missing: [], typeChanged: [], added: [], emptied: [] })
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest --run __tests__/patrol-shape.test.js
```

Expected: FAIL —— 找不到 `../patrol/shape.js`。

- [ ] **Step 3: 实现**

创建 `webcli/patrol/shape.js`：

```js
/**
 * 返回值"形状"的提取与对比。
 *
 * 形状 = 字段路径 → 类型。数组只取首个非空元素的形状，元素路径用 `[]` 标记。
 * 形状里**不含任何业务值**——这是基线的核心约束（基线要能入仓）。
 */

const MAX_DEPTH = 6

function walk(value, path, out, depth) {
  if (depth > MAX_DEPTH) return

  if (Array.isArray(value)) {
    const first = value.find((item) => item !== undefined && item !== null)
    const elemPath = path ? `${path}[]` : '[]'
    if (first === undefined) {
      out[elemPath] = 'empty-array'
      return
    }
    walk(first, elemPath, out, depth + 1)
    return
  }

  const type = value === null ? 'null' : typeof value
  out[path || '<root>'] = type
  if (type === 'object') {
    for (const [key, child] of Object.entries(value)) {
      walk(child, path ? `${path}.${key}` : key, out, depth + 1)
    }
  }
}

/** 把任意 JSON 值提取成 `{ 路径: 类型 }`。 */
export function extractShape(value) {
  const out = {}
  walk(value, '', out, 0)
  return out
}

/**
 * 基线形状 vs 当前形状。
 * - missing / typeChanged → 结构退化
 * - added → 只是 drift 信号，不算退化
 * - emptied → 数组变空，属**内容**退化，单独给出
 */
export function diffShape(baselineShape, currentShape) {
  const missing = []
  const typeChanged = []
  const emptied = []

  for (const [path, baselineType] of Object.entries(baselineShape)) {
    if (currentShape[path] === undefined) {
      missing.push({ path, baselineType })
    } else if (currentShape[path] !== baselineType) {
      if (currentShape[path] === 'empty-array') emptied.push(path.replace(/\[\]$/, ''))
      else typeChanged.push({ path, baselineType, currentType: currentShape[path] })
    }
  }

  const added = Object.keys(currentShape).filter((path) => baselineShape[path] === undefined)

  return {
    missing,
    typeChanged,
    added,
    emptied: [...new Set(emptied)],
    degraded: missing.length > 0 || typeChanged.length > 0,
  }
}
```

- [ ] **Step 4: 运行确认通过**

```bash
npx vitest --run __tests__/patrol-shape.test.js
```

Expected: PASS —— 12 passed。

- [ ] **Step 5: 提交**

```bash
git add webcli/patrol/shape.js webcli/__tests__/patrol-shape.test.js
git commit -m "feat(webcli): 巡检形状提取与 diff（基线只存形状，不存业务值）"
```

---

### Task 2: 三层判定与归类

**Files:**
- Create: `webcli/patrol/classify.js`
- Test: `webcli/__tests__/patrol-classify.test.js`

- [ ] **Step 1: 写失败的测试**

```js
import { describe, expect, it } from 'vitest'
import { classifyConnectivity, evaluateTool } from '../patrol/classify.js'

const ok = { ok: true }
const shapeOk = { missing: [], typeChanged: [], added: [], emptied: [], degraded: false }

describe('classifyConnectivity', () => {
  it('退出码 0 即连通', () => {
    expect(classifyConnectivity({ exitCode: 0, stdout: '{}', stderr: '' })).toEqual({ ok: true })
  })

  it('超时优先判定', () => {
    expect(classifyConnectivity({ exitCode: 1, stdout: '', stderr: '', timedOut: true }).reason).toBe('timeout')
  })

  it('登录特征', () => {
    expect(classifyConnectivity({ exitCode: 1, stdout: '', stderr: 'Error: 未登录' }).reason).toBe('login_required')
  })

  it('权限特征', () => {
    expect(classifyConnectivity({ exitCode: 1, stdout: '', stderr: 'no permission' }).reason).toBe('permission_denied')
  })

  it('其它非零退出码归 error', () => {
    expect(classifyConnectivity({ exitCode: 2, stdout: '', stderr: 'boom' }).reason).toBe('error')
  })
})

describe('evaluateTool', () => {
  it('连通失败即止，不判结构内容', () => {
    const r = evaluateTool({
      connectivity: { ok: false, reason: 'login_required' },
      shapeDiff: { ...shapeOk, degraded: true },
      emptiedPaths: [],
    })
    expect(r.verdict).toBe('failed')
    expect(r.kind).toBe('login_required')
    expect(r.details.reason).toBe('login_required')
  })

  it('结构退化归 site_changed，并带上字段明细', () => {
    const r = evaluateTool({
      connectivity: ok,
      shapeDiff: { missing: [{ path: 'a', baselineType: 'string' }], typeChanged: [], added: [], emptied: [], degraded: true },
      emptiedPaths: [],
    })
    expect(r.kind).toBe('site_changed')
    expect(r.details.missing).toHaveLength(1)
  })

  it('数组变空归 content_degraded', () => {
    const r = evaluateTool({ connectivity: ok, shapeDiff: shapeOk, emptiedPaths: ['items'] })
    expect(r.verdict).toBe('failed')
    expect(r.kind).toBe('content_degraded')
    expect(r.details.emptied).toEqual(['items'])
  })

  it('新增字段只记录，不判失败', () => {
    const r = evaluateTool({ connectivity: ok, shapeDiff: { ...shapeOk, added: ['x'] }, emptiedPaths: [] })
    expect(r.verdict).toBe('pass')
    expect(r.details.added).toEqual(['x'])
  })

  it('无基线时只判连通', () => {
    const r = evaluateTool({ connectivity: ok, shapeDiff: null, emptiedPaths: [] })
    expect(r.verdict).toBe('pass')
    expect(r.details.needsBaseline).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest --run __tests__/patrol-classify.test.js
```

Expected: FAIL —— 找不到模块。

- [ ] **Step 3: 实现**

创建 `webcli/patrol/classify.js`：

```js
/**
 * 巡检的两级判定：
 *   1) classifyConnectivity —— 这条命令"跑通了吗"
 *   2) evaluateTool        —— 跑通之后"结果还对吗"（结构 → 内容）
 *
 * 判定策略：上一层不通过就不往下判（与自检工具"超时直接返回"一致）。
 * 判定必须是确定性代码——不可交给 LLM。
 */

const LOGIN_PATTERNS = [/未登录/, /登录态失效/, /请先登录/, /认证失败/, /login required/i, /authentication required/i, /not logged in/i]
const PERMISSION_PATTERNS = [/无权限/, /权限不足/, /permission denied/i, /no permission/i]
const TIMEOUT_PATTERNS = [/超时/, /timeout/i, /timed out/i]

/** 连通层：退出码 + 特征词。 */
export function classifyConnectivity({ exitCode, stdout = '', stderr = '', timedOut = false }) {
  if (timedOut) return { ok: false, reason: 'timeout' }
  if (exitCode === 0) return { ok: true }

  const text = `${stdout}\n${stderr}`
  if (LOGIN_PATTERNS.some((re) => re.test(text))) return { ok: false, reason: 'login_required' }
  if (PERMISSION_PATTERNS.some((re) => re.test(text))) return { ok: false, reason: 'permission_denied' }
  if (TIMEOUT_PATTERNS.some((re) => re.test(text))) return { ok: false, reason: 'timeout' }
  return { ok: false, reason: 'error' }
}

/**
 * 工具级判定。
 * @param {{ connectivity: {ok: boolean, reason?: string},
 *           shapeDiff: object | null,     // null = 无基线，只判连通
 *           emptiedPaths: string[] }} input
 * @returns {{ verdict: 'pass'|'failed', kind: string|null, details: object }}
 */
export function evaluateTool({ connectivity, shapeDiff, emptiedPaths = [] }) {
  if (!connectivity.ok) {
    return { verdict: 'failed', kind: connectivity.reason, details: { reason: connectivity.reason } }
  }

  if (shapeDiff === null) {
    return { verdict: 'pass', kind: null, details: { needsBaseline: true } }
  }

  if (shapeDiff.degraded) {
    return {
      verdict: 'failed',
      kind: 'site_changed',
      details: {
        missing: shapeDiff.missing,
        typeChanged: shapeDiff.typeChanged,
        added: shapeDiff.added,
      },
    }
  }

  if (emptiedPaths.length > 0) {
    return { verdict: 'failed', kind: 'content_degraded', details: { emptied: emptiedPaths } }
  }

  return { verdict: 'pass', kind: null, details: { added: shapeDiff.added } }
}
```

- [ ] **Step 4: 运行确认通过**

```bash
npx vitest --run __tests__/patrol-classify.test.js
```

Expected: PASS —— 10 passed。

- [ ] **Step 5: 提交**

```bash
git add webcli/patrol/classify.js webcli/__tests__/patrol-classify.test.js
git commit -m "feat(webcli): 巡检三层判定（连通即止 / 结构 site_changed / 内容 content_degraded）"
```

---

### Task 3: 清单枚举

**Files:**
- Create: `webcli/patrol/enumerate.js`
- Test: `webcli/__tests__/patrol-enumerate.test.js`

- [ ] **Step 1: 写失败的测试**

```js
import { describe, expect, it } from 'vitest'
import { buildPatrolList, indexSamples } from '../patrol/enumerate.js'

const caseManifest = {
  name: 'demo',
  cases: [
    { id: 'jd-search', site: 'jd.com', command: 'jd.com.search_products', safety: 'read', safetyMode: 'read', args: { keyword: '手机' } },
    { id: 'jd-del', site: 'jd.com', command: 'jd.com.delete_item', safety: 'mutating', safetyMode: 'nonexistent-resource', args: { id: '__x__' } },
    { id: 'xx-risky', site: 'x.com', command: 'x.com.submit', safety: 'high_risk', safetyMode: 'none' },
  ],
}

describe('indexSamples', () => {
  it('按 command 建索引，多份清单后者覆盖并保留来源', () => {
    const map = indexSamples([['a.json', caseManifest]])
    expect(map.get('jd.com.search_products').source).toBe('a.json#jd-search')
    expect(map.get('jd.com.search_products').safetyMode).toBe('read')
  })
})

describe('buildPatrolList', () => {
  const tools = [
    { tool: 'jd.com.search_products' },
    { tool: 'jd.com.view_cart' },
    { tool: 'jd.com.delete_item' },
    { tool: 'x.com.submit' },
  ]

  it('每条工具一行，标出样本与基线状态', () => {
    const rows = buildPatrolList({
      adapterId: 'jd.com',
      tools: tools.slice(0, 3),
      samples: indexSamples([['a.json', caseManifest]]),
      baseline: { tools: { 'jd.com.search_products': { shape: { a: 'string' } } } },
    })
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ tool: 'jd.com.search_products', hasSample: true, hasBaseline: true })
    expect(rows[1]).toMatchObject({ tool: 'jd.com.view_cart', hasSample: false, hasBaseline: false, skipReason: 'needs-sample' })
  })

  it('有安全跑法的写命令可执行；safetyMode=none 的写命令跳过', () => {
    const rows = buildPatrolList({
      adapterId: 'x.com',
      tools: [{ tool: 'x.com.submit' }],
      samples: indexSamples([['a.json', caseManifest]]),
      baseline: null,
    })
    expect(rows[0].skipReason).toBe('unsafe-write')
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest --run __tests__/patrol-enumerate.test.js
```

Expected: FAIL。

- [ ] **Step 3: 实现**

创建 `webcli/patrol/enumerate.js`：

```js
/**
 * 巡检清单：已装 adapter 的每条工具一行，标注"有没有样本 / 有没有基线 / 能不能安全执行"。
 *
 * 样本来自 e2e-cases/*.json（既有资产，人工维护了参数与安全跑法）；
 * 没有样本的命令**不是错误**，只是本轮只判连通并标 needs-sample。
 */

/** `safetyMode === 'none'` 表示"没有安全跑法"——写命令直接跳过。 */
const UNSAFE_SAFETY_MODES = new Set(['none', undefined, null, ''])

/** 只读语义的 safety 值，读命令不需要 safetyMode。 */
const READ_SAFETY = new Set(['read', 'sensitive_read'])

export function indexSamples(manifests) {
  const map = new Map()
  for (const [fileName, manifest] of manifests) {
    for (const testCase of manifest.cases ?? []) {
      map.set(testCase.command, { ...testCase, source: `${fileName}#${testCase.id}` })
    }
  }
  return map
}

/**
 * @param {{ adapterId: string, tools: Array<{tool: string}>, samples: Map, baseline: object|null }} input
 * @returns {Array<{tool, adapterId, hasSample, hasBaseline, skipReason, sample}>}
 */
export function buildPatrolList({ adapterId, tools, samples, baseline }) {
  return tools.map(({ tool }) => {
    const sample = samples.get(tool) ?? null
    const hasSample = sample !== null
    const hasBaseline = Boolean(baseline?.tools?.[tool]?.shape)

    let skipReason = null
    if (!hasSample) {
      skipReason = 'needs-sample'
    } else {
      const isRead = READ_SAFETY.has(sample.safety)
      const hasSafeWriteMode = !UNSAFE_SAFETY_MODES.has(sample.safetyMode)
      if (!isRead && !hasSafeWriteMode) skipReason = 'unsafe-write'
    }

    return { adapterId, tool, hasSample, hasBaseline, skipReason, sample }
  })
}
```

- [ ] **Step 4: 运行确认通过**

```bash
npx vitest --run __tests__/patrol-enumerate.test.js
```

Expected: PASS —— 3 passed。

- [ ] **Step 5: 提交**

```bash
git add webcli/patrol/enumerate.js webcli/__tests__/patrol-enumerate.test.js
git commit -m "feat(webcli): 巡检清单枚举（样本/基线/安全跑法状态标注）"
```

---

### Task 4: 探针（执行 + 并发池）

**Files:**
- Create: `webcli/patrol/probe.js`
- Test: `webcli/__tests__/patrol-probe.test.js`

- [ ] **Step 1: 写失败的测试**

```js
import { describe, expect, it } from 'vitest'
import { buildPatrolEnv, runWithConcurrency, summarizeProbe } from '../patrol/probe.js'

describe('buildPatrolEnv', () => {
  it('强制 WEBCLI_METRICS=off 并移除 ENDPOINT，避免污染本机统计', () => {
    const env = buildPatrolEnv({ PATH: '/x', WEBCLI_METRICS_ENDPOINT: 'http://y' })
    expect(env.WEBCLI_METRICS).toBe('off')
    expect(env.WEBCLI_METRICS_ENDPOINT).toBeUndefined()
    expect(env.PATH).toBe('/x')
  })
})

describe('runWithConcurrency', () => {
  it('保持顺序且并发不超限', async () => {
    let peak = 0
    let inFlight = 0
    const seen = []
    const out = await runWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      seen.push(n)
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
      return n * 2
    })
    expect(out).toEqual([2, 4, 6, 8, 10])
    expect(peak).toBeLessThanOrEqual(2)
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5])
  })
})

describe('summarizeProbe', () => {
  it('解析 stdout 里的 JSON，失败则 parsed 为 null', () => {
    expect(summarizeProbe({ exitCode: 0, stdout: '{"a":1}', stderr: '', timedOut: false }).parsed).toEqual({ a: 1 })
    expect(summarizeProbe({ exitCode: 0, stdout: 'not json', stderr: '', timedOut: false }).parsed).toBeNull()
  })

  it('剥掉服务启动 banner 行后再解析', () => {
    const out = 'Bridge not running, starting...\n{"ok":true}\n'
    expect(summarizeProbe({ exitCode: 0, stdout: out, stderr: '', timedOut: false }).parsed).toEqual({ ok: true })
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest --run __tests__/patrol-probe.test.js
```

Expected: FAIL。

- [ ] **Step 3: 实现**

创建 `webcli/patrol/probe.js`：

```js
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PATROL_DIR = dirname(fileURLToPath(import.meta.url))
export const WEBCLI_DIR = resolve(PATROL_DIR, '..')
export const CLI_ENTRY = join(WEBCLI_DIR, 'index.js')

export const DEFAULT_CONCURRENCY = 4
export const DEFAULT_TIMEOUT_MS = 20_000

/**
 * 子进程环境：继承当前环境，但固定两处。
 * - WEBCLI_METRICS=off：巡检不写 ~/.webcli/metrics.jsonl
 * - 删除 WEBCLI_METRICS_ENDPOINT：避免 stats 类命令依赖外部端点
 */
export function buildPatrolEnv(base = process.env) {
  const env = { ...base, WEBCLI_METRICS: 'off' }
  delete env.WEBCLI_METRICS_ENDPOINT
  return env
}

/** 固定并发度的任务池，结果按输入顺序返回。 */
export async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const size = Math.max(1, Math.min(limit, items.length))
  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/** 从 stdout 里剥掉服务启动 banner，取首个 JSON 对象/数组。 */
export function parseToolOutput(stdout) {
  const trimmed = String(stdout ?? '').trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.search(/[[{]/)
    if (start === -1) return null
    const candidate = trimmed.slice(start)
    try {
      return JSON.parse(candidate)
    } catch {
      return null
    }
  }
}

export function summarizeProbe(raw) {
  return { ...raw, parsed: parseToolOutput(raw.stdout) }
}

/** 执行一条命令，返回原始结果（不做判定）。 */
export function probeTool({ tool, args }, { env, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const argv = [CLI_ENTRY, 'call', tool]
  if (args && Object.keys(args).length > 0) argv.push('--args', JSON.stringify(args))
  argv.push('-v')

  return new Promise((resolvePromise) => {
    const started = Date.now()
    const child = spawn(process.execPath, argv, { cwd: WEBCLI_DIR, env: env ?? buildPatrolEnv(), windowsHide: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ exitCode: null, stdout, stderr: `${stderr}${error.message}`, timedOut: false, durationMs: Date.now() - started })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ exitCode: code ?? 1, stdout, stderr, timedOut, durationMs: Date.now() - started })
    })
  })
}
```

- [ ] **Step 4: 运行确认通过**

```bash
npx vitest --run __tests__/patrol-probe.test.js
```

Expected: PASS —— 4 passed。

- [ ] **Step 5: 提交**

```bash
git add webcli/patrol/probe.js webcli/__tests__/patrol-probe.test.js
git commit -m "feat(webcli): 巡检探针（并发池 / 超时 / 输出解析 / 不污染统计）"
```

---

### Task 5: 基线读写与更新预览

**Files:**
- Create: `webcli/patrol/baseline.js`
- Test: `webcli/__tests__/patrol-baseline.test.js`

- [ ] **Step 1: 写失败的测试**

```js
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildBaseline, diffBaselinePlan, loadBaseline, saveBaseline } from '../patrol/baseline.js'

const roots = []
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'patrol-'))
  roots.push(dir)
  return dir
}

afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }) })

describe('buildBaseline', () => {
  it('从首跑结果生成基线条目，记录 requiredNonEmpty', () => {
    const entry = buildBaseline({
      tool: 'jd.com.search_products',
      parsed: { items: [{ id: 1, name: 'x' }], total: 3 },
      sampleSource: 'a.json#jd-search',
      updatedAt: '2026-10-13',
      updatedBy: 'tester',
    })
    expect(entry.source).toBe('first-run')
    expect(entry.sampleSource).toBe('a.json#jd-search')
    expect(entry.shape['items[].id']).toBe('number')
    expect(entry.requiredNonEmpty).toContain('items')
  })
})

describe('saveBaseline / loadBaseline', () => {
  it('写入后可读回', () => {
    const root = tmp()
    saveBaseline(root, 'jd.com', { version: 1, adapterId: 'jd.com', tools: { t: { shape: { a: 'string' } } } })
    expect(loadBaseline(root, 'jd.com').tools.t.shape.a).toBe('string')
    expect(loadBaseline(root, 'absent.com')).toBeNull()
  })

  it('落盘内容不含业务值', () => {
    const root = tmp()
    saveBaseline(root, 'jd.com', { version: 1, adapterId: 'jd.com', tools: { t: { shape: { a: 'string' } } } })
    const text = readFileSync(join(root, 'jd.com.json'), 'utf8')
    expect(text).not.toContain('秘密')
  })
})

describe('diffBaselinePlan', () => {
  it('列出将要新增/变化的条目，供更新前预览', () => {
    const plan = diffBaselinePlan(
      { tools: { a: { shape: { x: 'string' } } } },
      { tools: { a: { shape: { x: 'number' } }, b: { shape: { y: 'string' } } } },
    )
    expect(plan.changed).toEqual(['a'])
    expect(plan.added).toEqual(['b'])
    expect(plan.removed).toEqual([])
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest --run __tests__/patrol-baseline.test.js
```

Expected: FAIL。

- [ ] **Step 3: 实现**

创建 `webcli/patrol/baseline.js`：

```js
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractShape } from './shape.js'

export const BASELINE_VERSION = 1

export function baselineDir(repoRoot) {
  return join(repoRoot, 'webcli', 'patrol', 'baselines')
}

export function baselinePath(repoRoot, adapterId) {
  return join(baselineDir(repoRoot), `${adapterId}.json`)
}

export function loadBaseline(repoRoot, adapterId) {
  const file = baselinePath(repoRoot, adapterId)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function saveBaseline(repoRoot, adapterId, baseline) {
  mkdirSync(baselineDir(repoRoot), { recursive: true })
  writeFileSync(baselinePath(repoRoot, adapterId), `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
}

/** 判断一个路径在本次采样里是否非空（用于 requiredNonEmpty 的首采记录）。 */
function isNonEmpty(value) {
  if (value === null || value === undefined) return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'string') return value.length > 0
  return true
}

/** 从一次成功执行的结果生成基线条目。 */
export function buildBaseline({ tool, parsed, sampleSource, updatedAt, updatedBy }) {
  const shape = extractShape(parsed)
  const requiredNonEmpty = Object.entries(parsed ?? {})
    .filter(([, value]) => isNonEmpty(value))
    .map(([key]) => key)

  return { source: 'first-run', shape, requiredNonEmpty, sampleSource, updatedAt, updatedBy }
}

/** 更新前的预览：哪些会新增 / 变化 / 移除，供人确认。 */
export function diffBaselinePlan(oldBaseline, newBaseline) {
  const oldTools = oldBaseline?.tools ?? {}
  const newTools = newBaseline?.tools ?? {}
  const changed = []
  const added = []
  for (const [tool, entry] of Object.entries(newTools)) {
    if (!(tool in oldTools)) added.push(tool)
    else if (JSON.stringify(oldTools[tool].shape) !== JSON.stringify(entry.shape)) changed.push(tool)
  }
  const removed = Object.keys(oldTools).filter((tool) => !(tool in newTools))
  return { added, changed, removed }
}
```

- [ ] **Step 4: 运行确认通过**

```bash
npx vitest --run __tests__/patrol-baseline.test.js
```

Expected: PASS —— 4 passed。

- [ ] **Step 5: 提交**

```bash
git add webcli/patrol/baseline.js webcli/__tests__/patrol-baseline.test.js
git commit -m "feat(webcli): 巡检基线读写与更新预览（只存形状，入仓可评审）"
```

---

### Task 6: ensureLogin 接口与降级实现

**Files:**
- Create: `webcli/patrol/ensure-login.js`
- Test: `webcli/__tests__/patrol-ensure-login.test.js`

- [ ] **Step 1: 写失败的测试**

```js
import { describe, expect, it } from 'vitest'
import { createEnsureLogin } from '../patrol/ensure-login.js'

describe('ensureLogin', () => {
  it('登录态可用时走 session，不碰账号', async () => {
    const calls = []
    const ensureLogin = createEnsureLogin({
      probeSession: async () => { calls.push('session'); return true },
      tryAccounts: async () => { calls.push('accounts'); return null },
    })
    expect(await ensureLogin('a.com')).toEqual({ ok: true, source: 'session' })
    expect(calls).toEqual(['session'])
  })

  it('session 失效则尝试账号', async () => {
    const ensureLogin = createEnsureLogin({
      probeSession: async () => false,
      tryAccounts: async () => ({ account: 'patrol-read' }),
    })
    expect(await ensureLogin('a.com')).toEqual({ ok: true, source: 'account', account: 'patrol-read' })
  })

  it('没有账号时返回 no-account', async () => {
    const ensureLogin = createEnsureLogin({
      probeSession: async () => false,
      tryAccounts: async () => ({ reason: 'no-account' }),
    })
    expect(await ensureLogin('a.com')).toEqual({ ok: false, reason: 'no-account' })
  })

  it('账号都失败返回 login-failed，全 suspect 返回 login-blocked', async () => {
    const failed = createEnsureLogin({ probeSession: async () => false, tryAccounts: async () => ({ reason: 'login-failed' }) })
    expect(await failed('a.com')).toEqual({ ok: false, reason: 'login-failed' })

    const blocked = createEnsureLogin({ probeSession: async () => false, tryAccounts: async () => ({ reason: 'login-blocked' }) })
    expect(await blocked('a.com')).toEqual({ ok: false, reason: 'login-blocked' })
  })

  it('探测自身抛错时降级为 login-failed，不炸整轮巡检', async () => {
    const ensureLogin = createEnsureLogin({
      probeSession: async () => { throw new Error('bridge down') },
      tryAccounts: async () => ({ reason: 'no-account' }),
    })
    expect(await ensureLogin('a.com')).toEqual({ ok: false, reason: 'login-failed' })
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest --run __tests__/patrol-ensure-login.test.js
```

Expected: FAIL。

- [ ] **Step 3: 实现**

创建 `webcli/patrol/ensure-login.js`：

```js
/**
 * `ensureLogin(adapterId)` —— 巡检与账号体系之间唯一的接口。
 *
 * 巡检**不关心**账号从哪来、怎么登；它只问"这站现在能不能用"：
 *   { ok: true,  source: 'session' | 'account', account? }
 *   { ok: false, reason: 'no-account' | 'login-failed' | 'login-blocked' }
 *
 * 本子项目只提供这个接口与**默认降级实现**（没有账号库时如实说 no-account）；
 * 账号库与自动登录由子项目 2 实现并注入。
 */
export function createEnsureLogin({ probeSession, tryAccounts }) {
  return async function ensureLogin(adapterId) {
    let sessionOk = false
    try {
      sessionOk = await probeSession(adapterId)
    } catch {
      sessionOk = false
    }
    if (sessionOk) return { ok: true, source: 'session' }

    try {
      const result = await tryAccounts(adapterId)
      if (!result) return { ok: false, reason: 'login-failed' }
      if (result.account) return { ok: true, source: 'account', account: result.account }
      return { ok: false, reason: result.reason ?? 'login-failed' }
    } catch {
      return { ok: false, reason: 'login-failed' }
    }
  }
}

/** 默认实现：只能判断"当前进程里有没有可用登录态"，不涉及账号库。 */
export function createDefaultEnsureLogin({ sessionStore, probeStatus }) {
  return createEnsureLogin({
    probeSession: async (adapterId) => Boolean(await probeStatus(adapterId, sessionStore)),
    tryAccounts: async () => ({ reason: 'no-account' }),
  })
}
```

- [ ] **Step 4: 运行确认通过**

```bash
npx vitest --run __tests__/patrol-ensure-login.test.js
```

Expected: PASS —— 5 passed。

- [ ] **Step 5: 提交**

```bash
git add webcli/patrol/ensure-login.js webcli/__tests__/patrol-ensure-login.test.js
git commit -m "feat(webcli): ensureLogin 接口与默认降级实现（无账号库时如实报 no-account）"
```

---

### Task 7: 报告生成

**Files:**
- Create: `webcli/patrol/report.js`
- Test: `webcli/__tests__/patrol-report.test.js`

- [ ] **Step 1: 写失败的测试**

```js
import { describe, expect, it } from 'vitest'
import { buildReport, formatTextReport } from '../patrol/report.js'

const rows = [
  { adapterId: 'a.com', tool: 'a.com.ok', verdict: 'pass', kind: null },
  { adapterId: 'a.com', tool: 'a.com.bad', verdict: 'failed', kind: 'site_changed', details: { missing: [{ path: 'x', baselineType: 'string' }] } },
  { adapterId: 'b.com', tool: 'b.com.x', verdict: 'uncovered', kind: 'login_required', details: { reason: 'login_required' } },
  { adapterId: 'c.com', tool: 'c.com.y', verdict: 'uncovered', kind: 'needs-sample', details: { reason: 'needs-sample' } },
]

describe('buildReport', () => {
  const report = buildReport({ runId: 'r1', startedAt: 's', finishedAt: 'f', rows, siteCount: 3, loginHealth: [] })

  it('覆盖率是头号指标', () => {
    expect(report.coverage).toMatchObject({ tools: '2/4' })
  })

  it('未覆盖单独成块并带原因', () => {
    expect(report.uncovered).toHaveLength(2)
    expect(report.uncovered.map((u) => u.reason).sort()).toEqual(['login_required', 'needs-sample'])
  })

  it('site_changed 进需重新取证清单', () => {
    expect(report.reEvidence).toHaveLength(1)
    expect(report.reEvidence[0].tool).toBe('a.com.bad')
  })

  it('内容退化不进清单（除非连续两次）', () => {
    const r = buildReport({ runId: 'r', rows: [{ adapterId: 'a.com', tool: 't', verdict: 'failed', kind: 'content_degraded', details: { emptied: ['items'] } }], previousReport: null })
    expect(r.reEvidence).toHaveLength(0)
    expect(r.results.find((x) => x.tool === 't').escalated).toBe(false)
  })

  it('内容退化连续两次才升级进清单', () => {
    const r = buildReport({
      runId: 'r',
      rows: [{ adapterId: 'a.com', tool: 't', verdict: 'failed', kind: 'content_degraded', details: { emptied: ['items'] } }],
      previousReport: { results: [{ tool: 't', kind: 'content_degraded' }] },
    })
    expect(r.reEvidence).toHaveLength(1)
  })
})

describe('formatTextReport', () => {
  it('文本报告把覆盖率放在最前', () => {
    const text = formatTextReport(buildReport({ runId: 'r1', rows, siteCount: 3 }))
    expect(text.split('\n')[0]).toContain('覆盖')
  })

  it('列出未覆盖原因与需重新取证', () => {
    const text = formatTextReport(buildReport({ runId: 'r1', rows, siteCount: 3 }))
    expect(text).toContain('未覆盖')
    expect(text).toContain('需重新取证')
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest --run __tests__/patrol-report.test.js
```

Expected: FAIL。

- [ ] **Step 3: 实现**

创建 `webcli/patrol/report.js`：

```js
/**
 * 巡检报告。
 *
 * 核心约定：**未覆盖 ≠ 通过**。覆盖率是报告的头号指标，排在通过率之前——
 * 否则"35 个站只跑了 3 个"会被读成一片绿。
 */

const CONTENT_ESCALATION = 'content_degraded'

export function buildReport({ runId, startedAt = null, finishedAt = null, rows = [], siteCount = 0, loginHealth = [], previousReport = null }) {
  const covered = rows.filter((row) => row.verdict !== 'uncovered')
  const passed = covered.filter((row) => row.verdict === 'pass')
  const failed = covered.filter((row) => row.verdict === 'failed')
  const uncovered = rows
    .filter((row) => row.verdict === 'uncovered')
    .map((row) => ({ adapterId: row.adapterId, tool: row.tool, reason: row.details?.reason ?? row.kind ?? 'unknown' }))

  const coveredSites = new Set(covered.map((row) => row.adapterId))

  const previousByTool = new Map((previousReport?.results ?? []).map((item) => [item.tool, item]))

  const results = rows.map((row) => {
    const prev = previousByTool.get(row.tool)
    // 内容退化需要"连续两次"才升级——单次波动不惊动人
    const escalated = row.kind === CONTENT_ESCALATION && prev?.kind === CONTENT_ESCALATION
    return { ...row, escalated }
  })

  const reEvidence = results
    .filter((row) => row.kind === 'site_changed' || row.escalated)
    .map((row) => ({ adapterId: row.adapterId, tool: row.tool, reason: row.kind, evidence: row.details ?? {} }))

  const newlyFailed = results
    .filter((row) => row.verdict === 'failed' && previousByTool.get(row.tool)?.verdict !== 'failed')
    .map((row) => row.tool)
  const recovered = results
    .filter((row) => row.verdict === 'pass' && previousByTool.get(row.tool)?.verdict === 'failed')
    .map((row) => row.tool)

  return {
    runId,
    startedAt,
    finishedAt,
    coverage: {
      sites: `${coveredSites.size}/${siteCount}`,
      tools: `${covered.length}/${rows.length}`,
    },
    passed: passed.length,
    failed: failed.length,
    uncovered,
    results,
    reEvidence,
    newlyFailed,
    recovered,
    loginHealth,
  }
}

export function formatTextReport(report) {
  const lines = []
  lines.push(`覆盖 ${report.coverage.sites} 站 · ${report.coverage.tools} 条命令   通过 ${report.passed} / 失败 ${report.failed} / 未覆盖 ${report.uncovered.length}`)

  if (report.failed > 0) {
    lines.push('')
    lines.push('── 失败 ──')
    for (const row of report.results.filter((item) => item.verdict === 'failed')) {
      lines.push(`[${row.kind}] ${row.tool}`)
      for (const [key, value] of Object.entries(row.details ?? {})) {
        if (Array.isArray(value) && value.length > 0) lines.push(`       ${key}: ${JSON.stringify(value)}`)
      }
    }
  }

  if (report.uncovered.length > 0) {
    lines.push('')
    lines.push('── 未覆盖（不计入通过）──')
    const byReason = {}
    for (const item of report.uncovered) (byReason[item.reason] ??= []).push(item.tool)
    for (const [reason, tools] of Object.entries(byReason)) lines.push(`  ${reason}: ${tools.length} 条（如 ${tools[0]}）`)
  }

  if (report.reEvidence.length > 0) {
    lines.push('')
    lines.push('── 需重新取证 ──')
    for (const item of report.reEvidence) lines.push(`  ${item.tool}（${item.reason}）`)
  }

  if (report.newlyFailed.length > 0) lines.push(`\n新增失败：${report.newlyFailed.join(', ')}`)
  if (report.recovered.length > 0) lines.push(`已恢复：${report.recovered.join(', ')}`)

  return lines.join('\n')
}
```

- [ ] **Step 4: 运行确认通过**

```bash
npx vitest --run __tests__/patrol-report.test.js
```

Expected: PASS —— 7 passed。

- [ ] **Step 5: 提交**

```bash
git add webcli/patrol/report.js webcli/__tests__/patrol-report.test.js
git commit -m "feat(webcli): 巡检报告（覆盖率优先 + 未覆盖成块 + 需重新取证）"
```

---

### Task 8: 编排与 CLI 入口

**Files:**
- Create: `webcli/patrol/index.js`
- Test: `webcli/__tests__/patrol-cli.test.js`

- [ ] **Step 1: 写失败的测试**

```js
import { describe, expect, it } from 'vitest'
import { parsePatrolArgs } from '../patrol/index.js'

describe('parsePatrolArgs', () => {
  it('解析常用参数', () => {
    expect(parsePatrolArgs(['--concurrency', '8', '--only', 'a.com', '--json'])).toMatchObject({ concurrency: 8, only: 'a.com', json: true })
  })

  it('默认并发 4', () => {
    expect(parsePatrolArgs([]).concurrency).toBe(4)
  })

  it('识别 --update-baseline', () => {
    expect(parsePatrolArgs(['--update-baseline']).updateBaseline).toBe(true)
  })

  it('--timeout 以秒为单位换算', () => {
    expect(parsePatrolArgs(['--timeout', '30']).timeoutMs).toBe(30_000)
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest --run __tests__/patrol-cli.test.js
```

Expected: FAIL。

- [ ] **Step 3: 实现**

创建 `webcli/patrol/index.js`：

```js
#!/usr/bin/env node
/**
 * 巡检执行器 CLI。
 *
 * 用法：
 *   node webcli/patrol/index.js [--json] [--only <adapterId>] [--concurrency 4]
 *                               [--timeout 20] [--update-baseline] [--list]
 *
 * 退出码：0 全绿（含未覆盖） / 1 有失败 / 2 脚本自身异常
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadBaseline } from './baseline.js'
import { classifyConnectivity, evaluateTool } from './classify.js'
import { buildPatrolList, indexSamples } from './enumerate.js'
import { createDefaultEnsureLogin } from './ensure-login.js'
import { buildPatrolEnv, probeTool, runWithConcurrency, summarizeProbe, WEBCLI_DIR } from './probe.js'
import { buildReport, formatTextReport } from './report.js'
import { diffShape, extractShape } from './shape.js'

const PATROL_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(WEBCLI_DIR, '..')
const RUNS_DIR = join(REPO_ROOT, 'webcli', 'patrol', 'runs')

export function parsePatrolArgs(argv) {
  const options = { json: false, only: null, concurrency: 4, timeoutMs: 20_000, updateBaseline: false, list: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') options.json = true
    else if (arg === '--list') options.list = true
    else if (arg === '--update-baseline') options.updateBaseline = true
    else if (arg === '--only') options.only = argv[++i] ?? null
    else if (arg === '--concurrency') options.concurrency = Math.max(1, Number(argv[++i]) || 4)
    else if (arg === '--timeout') options.timeoutMs = Math.max(1, Number(argv[++i]) || 20) * 1000
  }
  return options
}

/** 读取 e2e-cases/ 下所有样本清单（既有资产，人工维护了参数与安全跑法）。 */
function loadSampleManifests() {
  const dir = join(WEBCLI_DIR, 'e2e-cases')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => [name, JSON.parse(readFileSync(join(dir, name), 'utf8'))])
}

/** 枚举某个 adapter 的全部工具（`loadExtensionAdapters()` 的条目自带 tools 数组）。 */
async function loadTools(adapterId) {
  const { loadExtensionAdapters } = await import('../adapter-cli.js')
  const adapters = await loadExtensionAdapters()
  const target = adapters.find((adapter) => adapter.id === adapterId)
  if (!target) return []
  return (target.tools ?? [])
    .map((tool) => (typeof tool === 'string' ? tool : tool.name))
    .filter(Boolean)
    .map((tool) => ({ tool }))
}

async function patrolAdapter({ adapterId, samples, options, env, ensureLogin }) {
  const login = await ensureLogin(adapterId)
  if (!login.ok) {
    const tools = await loadTools(adapterId)
    return tools.map(({ tool }) => ({
      adapterId,
      tool,
      verdict: 'uncovered',
      kind: login.reason,
      details: { reason: login.reason },
    }))
  }

  const tools = await loadTools(adapterId)
  const baseline = loadBaseline(REPO_ROOT, adapterId)
  const list = buildPatrolList({ adapterId, tools, samples, baseline })

  return runWithConcurrency(list, options.concurrency, async (row) => {
    if (row.skipReason) {
      return { adapterId, tool: row.tool, verdict: 'uncovered', kind: row.skipReason, details: { reason: row.skipReason } }
    }

    const raw = await probeTool({ tool: row.tool, args: row.sample?.args }, { env, timeoutMs: options.timeoutMs })
    const result = summarizeProbe(raw)
    const connectivity = classifyConnectivity(result)

    const baselineEntry = baseline?.tools?.[row.tool]
    let shapeDiff = null
    let emptiedPaths = []
    if (connectivity.ok && baselineEntry && result.parsed !== null) {
      shapeDiff = diffShape(baselineEntry.shape, extractShape(result.parsed))
      emptiedPaths = shapeDiff.emptied
    }

    const verdict = evaluateTool({ connectivity, shapeDiff, emptiedPaths })
    return {
      adapterId,
      tool: row.tool,
      verdict: verdict.verdict,
      kind: verdict.kind,
      details: { ...verdict.details, durationMs: result.durationMs, baselineMissing: connectivity.ok && !baselineEntry },
      parsed: result.parsed,
      sampleSource: row.sample?.source ?? null,
    }
  })
}

async function main() {
  const options = parsePatrolArgs(process.argv.slice(2))
  const env = buildPatrolEnv()
  const manifests = loadSampleManifests()
  const samples = indexSamples(manifests)

  const { loadExtensionAdapters } = await import('../adapter-cli.js')
  const adapters = await loadExtensionAdapters()
  const targetIds = options.only ? [options.only] : adapters.map((adapter) => adapter.id)

  if (options.list) {
    for (const id of targetIds) {
      const tools = await loadTools(id)
      for (const { tool } of tools) console.log(`${id}\t${tool}`)
    }
    return
  }

  const ensureLogin = createDefaultEnsureLogin({
    sessionStore: null,
    probeStatus: async () => true, // 子项目 2 落地前：假定登录态可用，由连通层兜底
  })

  const runId = `patrol-${Date.now()}`
  const startedAt = new Date().toISOString()
  const rows = []
  for (const adapterId of targetIds) {
    rows.push(...(await patrolAdapter({ adapterId, samples, options, env, ensureLogin })))
  }
  const finishedAt = new Date().toISOString()

  const previousReport = loadPreviousReport()
  const report = buildReport({ runId, startedAt, finishedAt, rows, siteCount: targetIds.length, previousReport })

  persistRun(report, rows)
  console.log(options.json ? JSON.stringify(report, null, 2) : formatTextReport(report))
  process.exitCode = report.failed > 0 ? 1 : 0
}

function loadPreviousReport() {
  const file = join(REPO_ROOT, 'webcli', 'patrol', 'latest.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function persistRun(report, rows) {
  mkdirSync(RUNS_DIR, { recursive: true })
  writeFileSync(join(RUNS_DIR, `${report.runId}.json`), `${JSON.stringify(rows, null, 2)}\n`, 'utf8')
  writeFileSync(join(REPO_ROOT, 'webcli', 'patrol', 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[patrol] 异常: ${error?.stack ?? error}`)
    process.exitCode = 2
  })
}
```

- [ ] **Step 4: 运行确认通过**

```bash
npx vitest --run __tests__/patrol-cli.test.js
```

Expected: PASS —— 4 passed。

- [ ] **Step 5: 端到端验证（真实跑一次，只跑一个站）**

```bash
node patrol/index.js --only jd.com --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log('覆盖率:',r.coverage.tools,'| 通过',r.passed,'| 失败',r.failed,'| 未覆盖',r.uncovered.length)})"
```

Expected: 输出覆盖率与三类计数；**未覆盖里应能看到大量 `needs-sample`/`needs-baseline`**（这是首跑的正常状态）。若出现 `site_changed` 或 `content_degraded`，说明该站确实有问题或断言需核对——**先报告，不要改判定迁就**。

再确认没有污染本机统计：

```bash
wc -l ~/.webcli/metrics.jsonl 2>/dev/null || echo "无 metrics.jsonl"
```

Expected: 与运行前一致。

- [ ] **Step 6: 提交**

```bash
git add webcli/patrol/index.js webcli/__tests__/patrol-cli.test.js
git commit -m "feat(webcli): 巡检编排与 CLI 入口（覆盖率/未覆盖/需重新取证，可命令行单跑）"
```

---

## 完成标准

- `node webcli/patrol/index.js` 能枚举全部已装 adapter 的工具并产出报告
- 报告以**覆盖率**开头，未覆盖单独成块并带原因（`needs-sample` / `unsafe-write` / `login_required` / `no-account`）
- `site_changed` 进「需重新取证」；内容退化需连续两次才升级
- 基线只存形状、可入仓；`--update-baseline` 前先打印变更预览
- 巡检不写 `~/.webcli/metrics.jsonl`
- 各纯函数单测全绿；现有测试不新增失败

## 已知偏差（实现时必须补齐，不要静默跳过）

写计划时对照 spec 发现两处本计划未完全覆盖，**实现时按 spec 补齐**：

1. **基线来源的"fixture 优先"未实现**。spec 要求「已有 `verificationFixture` 的命令优先用它推导 shape，没有的首跑自建」；本计划 Task 5 只实现了首跑自建。补齐方式：`buildBaseline` 增加可选的 `fixture` 入参（`{ requiredPaths, types, notEmpty }` → 直接映射成 `shape` + `requiredNonEmpty`，`source: 'verificationFixture'`），并在 Task 8 编排里从站点记忆读取 fixture 传入。**fixture 位于后端站点记忆存储**，webcli 侧读取路径需要实现时确认。

2. **`ensureLogin` 的默认实现目前是"假定登录态可用"**（由连通层兜底把登录失败归为 `login_required` → 未覆盖）。spec 要求默认实现应「查 session-store + 探一次 `check_login_status`，能力不足时如实返回 `no-account`」。补齐方式：Task 6 的 `createDefaultEnsureLogin` 接收 `sessionStore` 与"可用的 `check_login_status` 工具名"，真的探一次再返回；适配器没有该工具时才回退到"假定可用 + 连通层兜底"。

## 后续

客户端集成（`scheduled_tasks.kind`、`task-executor` 分派、`patrol_runs` 表、通知、「立即跑一次」）见下一份计划。
