# Adapter 自进化二期实现计划(集成层)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 二期集成层——playbook 化经验库、巡检清单接入、hub 经验共享(服务端+客户端)、修复 stats 与升级埋点。提交进 PR #457(与一期同分支同 PR)。

**Architecture:** 在一期七模块上加增量:knowledge.js 加 playbook/meta;task-source.js 加 tasksFromPatrol(巡检报告契约,见下);adapterhub/server 加 experiences 表与 GET/POST;客户端 hub-sync(上报/回源,5s 超时静默);executor 注入 playbook 与成本元数据;CLI 加 stats。

**Tech Stack:** 同一期(ESM、vitest、node:sqlite 服务端)。

**明确延后(不在本计划):** P0 巡检执行器本体(按 Int 仓 2026-10-13 计划单独开发);P2 safeSample 生成管线改造(依赖 P0);web 看板(先 CLI stats)。

---

## 巡检报告输入契约(Task B 定义;巡检执行器将来按此产出)

```json
{
  "reportVersion": 1,
  "generatedAt": "2026-11-26T08:00:00Z",
  "runId": "patrol-20261126-0800",
  "adapters": [
    { "adapterId": "costplus.weoa.com", "runtime": "extension",
      "entries": [
        { "tool": "costplus.weoa.com.list-subsidy-ledgers", "verdict": "degraded", "diff": "types.amount: number→string", "sample": {} },
        { "tool": "costplus.weoa.com.get-document-detail", "verdict": "needs-regeneration", "diff": "页面重构:表单容器不存在" }
      ] }
  ]
}
```

verdict 枚举:`ok | degraded(结构退化→修复管线) | needs-regeneration(站点改版→生成链路) | login-blocked(整站跳过,不计)`。

---

### Task A: playbook 化经验库 + 成本元数据

**Files:**
- Modify: `webcli/repair/knowledge.js`
- Modify: `webcli/repair/executor.js`
- Test: `webcli/__tests__/repair-knowledge.test.js`(追加)、`webcli/__tests__/repair-executor.test.js`(追加)

- [ ] **Step 1: 追加失败测试(knowledge)**

在 repair-knowledge.test.js 追加:

```js
import { pickPlaybooks, injectContext as injectCtx2 } from '../repair/knowledge.js'

describe('playbook', () => {
  const PB = { detect: '页面 URL 含 /login 即登录态失效', detectSnippet: "if ('/login' in page.url) return NEEDS_LOGIN", fixTemplate: 'goto 后先探登录重定向,失效返回 {ok:false, code:NEEDS_LOGIN, needs_user:true}' }
  it('recordExperience 存 playbook;merge failed 时 playbook 保留', () => {
    const f = join(tmpdir(), `rk-pb-${Math.random().toString(36).slice(2)}.json`)
    recordExperience(f, { ...ENTRY, rootCause: 'login-expired', playbook: PB }, '2026-11-26T00:00:00Z')
    recordExperience(f, { ...ENTRY, rootCause: 'login-expired', symptom: ENTRY.symptom, outcome: 'failed' }, '2026-11-26T01:00:00Z')
    const { entries } = loadKnowledge(f)
    expect(entries[0].playbook.detectSnippet).toBe(PB.detectSnippet)
  })
  it('pickPlaybooks 按 rootCause 过滤且有 playbook 的条目', () => {
    const f = join(tmpdir(), `rk-pb2-${Math.random().toString(36).slice(2)}.json`)
    recordExperience(f, { ...ENTRY, rootCause: 'login-expired', playbook: PB })
    recordExperience(f, { ...ENTRY, site: 'other', symptom: 's2', rootCause: 'logic-bug' })
    const hits = pickPlaybooks(loadKnowledge(f).entries, 'login-expired')
    expect(hits).toHaveLength(1)
    expect(hits[0].playbook.fixTemplate).toContain('NEEDS_LOGIN')
  })
  it('injectContext 渲染 playbook 块与 failed 警示', () => {
    const text = injectContext([{ site: 'wekm', runtime: 'wewright', symptom: 's', rootCause: 'r', fixStrategy: 'f', outcome: 'fixed', hits: 1, lastOutcome: 'failed', playbook: PB }])
    expect(text).toContain('检测片段')
    expect(text).toContain('修复模板')
    expect(text).toContain('最近一次复现失败')
  })
  it('meta(rounds/llmCalls/usedPlaybook)随条目存储', () => {
    const f = join(tmpdir(), `rk-meta-${Math.random().toString(36).slice(2)}.json`)
    recordExperience(f, { ...ENTRY }, '2026-11-26T00:00:00Z', { rounds: 2, llmCalls: 2, durationMs: 45000, usedPlaybook: false })
    expect(loadKnowledge(f).entries[0].meta).toEqual({ rounds: 2, llmCalls: 2, durationMs: 45000, usedPlaybook: false })
  })
})
```

注:`injectContext` 直接改原函数输出(含 lastOutcome failed 警示 + playbook 块),`injectCtx2` 别名仅为本用例可读,实现后与原 injectContext 为同一函数——测试写法上用 `import { injectContext }` 单一导入即可,追加用例直接调 `injectContext`。

- [ ] **Step 2: 跑测确认失败**(pickPlaybooks 未导出/meta 未存储)

- [ ] **Step 3: 实现**

knowledge.js 改动点:
1. `recordExperience(file, entry, now, meta = null)`:clean 增加 `playbook`(entry.playbook 为对象时逐字段 String 截断 detect 300/detectSnippet 1500/fixTemplate 2000,否则保留旧条目 playbook);合并 failed 时 playbook 与 rootCause/fixStrategy 一样保留;新增 `meta`(对象原样存,非法则 null)。
2. 新导出 `pickPlaybooks(entries, rootCause)`:返回 `entries.filter(e => e.playbook && e.rootCause === rootCause)`。
3. `injectContext` 条目渲染追加:有 playbook → `\n  检测片段: ${playbook.detectSnippet}\n  修复模板: ${playbook.fixTemplate}`;`lastOutcome === 'failed'` → 行尾追加 `(注意:最近一次复现失败)`。

executor.js 改动点:
1. 循环前 `const hits = searchExperience(...)` 后增加 `const playbooks = pickPlaybooks(...)` 不需要——`pickPlaybooks(hits.map 转条目)` 直接从 hits 取;`ctx.playbookHint = injectContext(hits.filter(h => h.playbook).map(...))` 或并入 experienceHint:实现为 experienceHint 渲染函数自然含 playbook(hits 即条目)——**executor 只需把 hits 传给 injectContext 时保持条目对象完整**(现实现已是),确认无字段丢失即可。
2. 成功/耗尽两处 recordExperience 增加 `meta: { rounds, llmCalls: round, durationMs: Date.now() - startedAt, usedPlaybook: Boolean(命中 playbook 的条目) }`(入口记 `const startedAt = Date.now()`、`let llmCalls = 0` 每次 LLM 调用 ++、命中判定:experienceHint 含「检测片段」)。
3. `recordExperience` 增加第 4 参传 meta。

- [ ] **Step 4: 跑测确认通过**(knowledge + executor 全绿)

- [ ] **Step 5: 提交**

```bash
git add webcli/repair/knowledge.js webcli/repair/executor.js webcli/__tests__/repair-knowledge.test.js webcli/__tests__/repair-executor.test.js
git commit -m "feat(repair): 经验库 playbook 化 + 修复成本元数据"
```

---

### Task B: tasksFromPatrol + CLI --from patrol

**Files:**
- Modify: `webcli/repair/task-source.js`
- Modify: `webcli/repair/cli.js`(task 分支支持 `--from patrol --report <file>`)
- Test: `webcli/__tests__/repair-task-source.test.js`(追加)、fixture `webcli/__tests__/fixtures/patrol-report.json`

- [ ] **Step 1: fixture + 失败测试**

fixture `webcli/__tests__/fixtures/patrol-report.json`(本文件头部「巡检报告输入契约」示例的完整版,含 we123 一条 degraded + costplus 一条 needs-regeneration + 一条 login-blocked)。

追加测试:

```js
import { tasksFromPatrol } from '../repair/task-source.js'
import { readFileSync } from 'node:fs'

describe('tasksFromPatrol', () => {
  const report = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'patrol-report.json'), 'utf8'))
  it('degraded → 修复任务;needs-regeneration 记入 task.patrol;login-blocked/ok 跳过', () => {
    const tasks = tasksFromPatrol(report, { now: Date.parse('2026-11-26T00:00:00Z') })
    expect(tasks).toHaveLength(1)
    expect(tasks[0].source).toBe('patrol')
    expect(tasks[0].failures[0].lastErr).toContain('degraded')
    expect(tasks[0].patrol.needsRegenerationTools).toEqual(['costplus.weoa.com.get-document-detail'])
  })
  it('空 entries / 非法报告 → 空数组', () => {
    expect(tasksFromPatrol({})).toEqual([])
    expect(tasksFromPatrol(null)).toEqual([])
  })
})
```

- [ ] **Step 2: 确认失败 → Step 3: 实现**

task-source.js 追加:

```js
const PATROL_VERDICTS = new Set(['degraded', 'needs-regeneration']);

export function tasksFromPatrol(report, { minEntries = 1, now = Date.now() } = {}) {
  const adapters = report?.adapters || [];
  const tasks = [];
  for (const a of adapters) {
    if (!a.adapterId || !SAFE_ADAPTER_ID.test(a.adapterId)) continue;
    const entries = (a.entries || []).filter((e) => PATROL_VERDICTS.has(e.verdict));
    if (entries.length < minEntries) continue;
    const degraded = entries.filter((e) => e.verdict === 'degraded');
    const needsRegen = entries.filter((e) => e.verdict === 'needs-regeneration').map((e) => e.tool);
    if (!degraded.length && !needsRegen.length) continue;
    const failures = degraded.map((e) => ({
      tool: e.tool, count: 1, lastErr: `[patrol:${e.verdict}] ${String(e.diff || '').slice(0, 180)}`,
    }));
    for (const e of needsRegen) {
      failures.push({ tool: e, count: 1, lastErr: '[patrol:needs-regeneration] 站点结构改版,需重新取证' });
    }
    const task = buildTask({ source: 'patrol', adapterId: a.adapterId, failures, now });
    task.runtime = a.runtime || null;
    task.patrol = { runId: String(report.runId || '').slice(0, 64), needsRegenerationTools: needsRegen };
    tasks.push(task);
  }
  return tasks;
}
```

注意:`needs-regeneration` 条目进 failures 是为了让诊断上下文可见;executor 对此类条目按既有 rootCause 提前终止路径处理。

cli.js task 分支扩展:

```js
    if (sub === "task" && rest.includes("--from")) {
      const opt = (name, dflt) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : dflt; };
      const since = opt("--since", "7d");
      const minCalls = parseInt(opt("--min-calls", "3"), 10);
      const reportFile = opt("--report", null);
      let tasks;
      if (rest[rest.indexOf("--from") + 1] === "patrol") {
        if (!reportFile) return fail("用法: --from patrol 需要 --report <巡检报告.json>", 2);
        const { tasksFromPatrol } = await import("./task-source.js");
        tasks = tasksFromPatrol(JSON.parse(readFileSync(reportFile, "utf8")));
      } else {
        const detail = await fetchErrDetail({ since });
        tasks = tasksFromErrDetail(detail, { minCalls });
      }
      ...
```

(顶部加 `import { readFileSync } from "node:fs";`;fail 2 的「用法:」前缀约定保持。)

- [ ] **Step 4: 跑测确认通过**(task-source 全绿 + CLI 冒烟 `--from patrol --report fixture` 生成 1 任务)

- [ ] **Step 5: 提交**

```bash
git add webcli/repair/task-source.js webcli/repair/cli.js webcli/__tests__/repair-task-source.test.js webcli/__tests__/fixtures/patrol-report.json
git commit -m "feat(repair): 巡检清单接入(任务生成 + CLI --from patrol)"
```

---

### Task C: hub experiences 服务端

**Files:**
- Modify: `adapterhub/server/db.js`(experiences 表 + upsert/list)
- Modify: `adapterhub/server/app.js`(GET/POST /api/v1/experiences)
- Test: `adapterhub/server/experiences.test.mjs`(镜像 db-v4.test.mjs 风格)

- [ ] **Step 1: 失败测试**(node:test,镜像既有 server 测试风格:内存库 + 路由 invoke)

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, upsertExperience, listExperiences } from '../db.js'

const E = { id: 'k1', site: 'wekm', runtime: 'wewright', root_cause: 'login-expired',
  symptom: 'exited code 1', fix_strategy: '探登录态', playbook: JSON.stringify({ detect: 'd' }),
  outcome: 'fixed', reporter: 'rickhuang' }

test('upsert 去重 hits+1;failed 保留旧策略', () => {
  const db = openDb(':memory:')
  upsertExperience(db, E)
  upsertExperience(db, { ...E, outcome: 'failed', fix_strategy: '' })
  const rows = listExperiences(db, {})
  assert.equal(rows.length, 1)
  assert.equal(rows[0].hits, 2)
  assert.equal(rows[0].fix_strategy, '探登录态')
  assert.equal(rows[0].last_outcome, 'failed')
})

test('list 按 site/runtime/root_cause 过滤,hits 降序', () => {
  const db = openDb(':memory:')
  upsertExperience(db, E)
  upsertExperience(db, { ...E, id: 'k2', site: 'other' })
  assert.equal(listExperiences(db, { site: 'wekm' })[0].id, 'k1')
  assert.equal(listExperiences(db, { site: 'nomatch' }).length, 0)
})
```

- [ ] **Step 2: 确认失败 → Step 3: 实现**

db.js 追加(表定义进 openDb 的 exec 模板,函数按 listFavorites 风格):

```sql
CREATE TABLE IF NOT EXISTS experiences (
  id TEXT PRIMARY KEY,
  site TEXT NOT NULL,
  runtime TEXT,
  root_cause TEXT,
  symptom TEXT,
  fix_strategy TEXT,
  playbook TEXT,
  outcome TEXT,
  last_outcome TEXT,
  hits INTEGER DEFAULT 1,
  reporter TEXT,
  created_at INTEGER,
  updated_at INTEGER
);
```

```js
// ── 修复经验(自进化二期;读匿名,写需 PAT)──

export function upsertExperience(db, e) {
  const now = Date.now();
  const prev = db.prepare('SELECT * FROM experiences WHERE id = ?').get(e.id);
  if (prev) {
    const failed = e.outcome === 'failed';
    db.prepare(`UPDATE experiences SET hits = hits + 1, last_outcome = ?, updated_at = ?,
                playbook = COALESCE(?, playbook),
                fix_strategy = CASE WHEN ? = 'failed' THEN fix_strategy ELSE ? END,
                root_cause = CASE WHEN ? = 'failed' THEN root_cause ELSE ? END
                WHERE id = ?`)
      .run(e.outcome ?? 'fixed', now, e.playbook ?? null, e.outcome ?? 'fixed', e.fix_strategy ?? '', e.outcome ?? 'fixed', e.root_cause ?? '', e.id);
    void prev;
  } else {
    db.prepare(`INSERT INTO experiences (id, site, runtime, root_cause, symptom, fix_strategy, playbook, outcome, last_outcome, hits, reporter, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
      .run(e.id, e.site, e.runtime ?? '', e.root_cause ?? '', e.symptom ?? '', e.fix_strategy ?? '',
           e.playbook ?? null, e.outcome ?? 'fixed', e.outcome ?? 'fixed', e.reporter ?? '', now, now);
  }
}

export function listExperiences(db, { site = '', runtime = '', root_cause = '', k = 20 } = {}) {
  const clauses = [], params = [];
  if (site) { clauses.push('site = ?'); params.push(site); }
  if (runtime) { clauses.push('runtime = ?'); params.push(runtime); }
  if (root_cause) { clauses.push('root_cause = ?'); params.push(root_cause); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM experiences ${where} ORDER BY hits DESC, updated_at DESC LIMIT ?`)
    .all(...params, Math.max(1, Math.min(50, k)));
}
```

app.js 在 `/api/v1/sites` 路由前追加:

```js
      // ── 修复经验(自进化二期;GET 匿名,POST 需 PAT)──
      if (url.pathname === '/api/v1/experiences' && req.method === 'GET') {
        return sendJson(res, 200, { items: listExperiences(db, {
          site: queryOptions(url).site || '', runtime: queryOptions(url).runtime || '',
          root_cause: queryOptions(url).root_cause || '', k: parseInt(queryOptions(url).k || '20', 10) || 20,
        }) });
      }
      if (url.pathname === '/api/v1/experiences' && req.method === 'POST') {
        if (!auth.configured) return sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: '发布经验需要访问令牌' } });
        const me = await auth.requireMe(req, res);   // 与既有 PAT 校验同款;若实现名不同,对照 /api/v1/adapters POST 分支
        if (!me) return;
        const body = await readJsonBody(req);       // 对照既有 POST 分支的 body 读取方式
        for (const field of ['id', 'site', 'symptom']) {
          if (!body?.[field]) return sendJson(res, 400, { error: { code: 'INVALID', message: `缺少 ${field}` } });
        }
        upsertExperience(db, { ...body, reporter: me.userid ?? me.name ?? '' });
        return sendJson(res, 200, { ok: true, id: body.id });
      }
```

⚠️ 实现时对照 app.js 既有 POST /api/v1/adapters 分支(161 行附近)的鉴权与 body 读取真实写法,不要臆造 `requireMe/readJsonBody` 的名字——以文件内既有 helper 为准。顶部 import 处补 `listExperiences, upsertExperience`。

- [ ] **Step 4: 跑测确认通过**(新测试 + 既有 server 测试无回归)

- [ ] **Step 5: 提交**

```bash
git add adapterhub/server/db.js adapterhub/server/app.js adapterhub/server/experiences.test.mjs
git commit -m "feat(adapterhub): 修复经验共享端点(GET 匿名/POST PAT,upsert 去重)"
```

---

### Task D: 客户端 hub 同步(上报/回源)

**Files:**
- Create: `webcli/repair/hub-sync.js`
- Modify: `webcli/repair/executor.js`(沉淀后异步上报;检索本地不足回源)
- Test: `webcli/__tests__/repair-hub-sync.test.js`

- [ ] **Step 1: 失败测试**

```js
import { describe, it, expect } from 'vitest'
import { reportExperienceToHub, fetchHubExperiences } from '../repair/hub-sync.js'

const HUB = 'http://hub.example.test/adapterhub'
const ENTRY = { id: 'k1', site: 'wekm', runtime: 'wewright', root_cause: 'login-expired', symptom: 's', fix_strategy: 'f', outcome: 'fixed' }

describe('reportExperienceToHub', () => {
  it('POST 到 experiences 端点,带 PAT;hub 不可达静默不抛', async () => {
    let called = null
    const ok = await reportExperienceToHub({ entry: ENTRY, registry: HUB, token: 'ahp_t',
      fetchImpl: async (url, opts) => { called = { url, opts }; return { ok: true, status: 200 } } })
    expect(ok).toBe(true)
    expect(called.url).toBe(`${HUB}/api/v1/experiences`)
    expect(called.opts.headers.authorization).toBe('Bearer ahp_t')
    await expect(reportExperienceToHub({ entry: ENTRY, registry: HUB, token: 'ahp_t',
      fetchImpl: async () => { throw new Error('network dead') } })).resolves.toBe(false)
  })
})

describe('fetchHubExperiences', () => {
  it('GET 过滤参数,返回 items 并标 shared:true', async () => {
    const fetchImpl = async (url) => {
      expect(String(url)).toContain('/api/v1/experiences?site=wekm&k=3')
      return { ok: true, json: async () => ({ items: [ENTRY] }) }
    }
    const items = await fetchHubExperiences({ registry: HUB, site: 'wekm', k: 3, fetchImpl })
    expect(items[0].shared).toBe(true)
  })
  it('hub 失败 → 空数组(静默)', async () => {
    expect(await fetchHubExperiences({ registry: HUB, fetchImpl: async () => { throw new Error('x') } })).toEqual([])
  })
})
```

- [ ] **Step 2: 确认失败 → Step 3: 实现 `webcli/repair/hub-sync.js`**

```js
/**
 * 经验库 hub 同步(二期 §7):修复完成上报(可关)、本地命中不足回源合并。
 * 全部静默失败——hub 同步绝不影响修复主流程。
 */
const HUB_TIMEOUT_MS = 5000;

async function hubRequest(url, options = {}, fetchImpl = fetch) {
  const resp = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(HUB_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`hub ${resp.status}`);
  return resp;
}

export async function reportExperienceToHub({ entry, registry, token = process.env.ADAPTERHUB_TOKEN || '', fetchImpl = fetch } = {}) {
  if (!registry || !token) return false;
  try {
    await hubRequest(`${String(registry).replace(/\/$/, '')}/api/v1/experiences`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(entry),
    }, fetchImpl);
    return true;
  } catch { return false; }
}

export async function fetchHubExperiences({ registry, site = '', runtime = '', rootCause = '', k = 3, fetchImpl = fetch } = {}) {
  if (!registry) return [];
  try {
    const params = new URLSearchParams();
    if (site) params.set('site', site);
    if (runtime) params.set('runtime', runtime);
    if (rootCause) params.set('root_cause', rootCause);
    params.set('k', String(k));
    const resp = await hubRequest(`${String(registry).replace(/\/$/, '')}/api/v1/experiences?${params}`, {}, fetchImpl);
    const body = await resp.json();
    return (body?.items || []).map((e) => ({ ...e, shared: true }));
  } catch { return []; }
}
```

executor.js 沉淀后异步上报(降级包内):

```js
      try {
        recordExperience(...); // 既有
        if (process.env.WEBCLI_REPAIR_EXPERIENCE_UPLOAD !== 'off') {
          const { reportExperienceToHub } = await import('./hub-sync.js');
          reportExperienceToHub({ entry: { ...同 recordExperience 参数对象, id 需重算或由 hub 端生成 }, registry: process.env.METRICS_STATS_ENDPOINT?.replace('/api', '') ? process.env.WEBCLI_ADAPTERHUB_ENDPOINT : undefined })
            .catch(() => {});
        }
      } catch ...
```

⚠️ 简化落地:executor 里直接 `reportExperienceToHub({ entry, registry: process.env.WEBCLI_ADAPTERHUB_ENDPOINT })` fire-and-forget(与 recordExperience 相同 entry;id 字段缺失时服务端按 id 必填会 400——则 entry 带上 `id: entryKey(clean)` 同款算法或允许服务端生成:实现时让 POST 缺 id 时服务端生成 sha1(site|runtime|symptom) 作为 id,保持两端一致)。

检索回源:executor 的 `searchExperience(knowledgePath(home), ...)`,结果 < 3 时:

```js
    let experiences = searchExperience(knowledgePath(home), { site: task.adapterId, runtime: 'wewright', errSignature: task.failures?.[0]?.lastErr || '' }, 3);
    if (experiences.length < 3 && process.env.WEBCLI_REPAIR_EXPERIENCE_UPLOAD !== 'off') {
      const { fetchHubExperiences } = await import('./hub-sync.js');
      const shared = await fetchHubExperiences({ registry: process.env.WEBCLI_ADAPTERHUB_ENDPOINT, site: task.adapterId, runtime: 'wewright', k: 3 - experiences.length });
      experiences = [...experiences, ...shared];
    }
```

- [ ] **Step 4: 跑测确认通过 → Step 5: 提交**

```bash
git add webcli/repair/hub-sync.js webcli/repair/executor.js webcli/__tests__/repair-hub-sync.test.js
git commit -m "feat(repair): 经验库 hub 同步(上报可关/回源合并/全程静默)"
```

---

### Task E: repair stats CLI + upgrade 埋点

**Files:**
- Modify: `webcli/repair/cli.js`(stats 分支)、`webcli/repair/executor.js`(meta 已在 Task A)
- Modify: `webcli/upgrade.js`(成功后埋点)
- Test: `webcli/__tests__/repair-cli.test.js`(追加 stats 用例)

- [ ] **Step 1: 失败测试(stats 聚合纯函数)**

knowledge.js 追加纯函数 + 测试:

```js
export function repairStats(entries) {
  const fixed = entries.filter((e) => e.outcome === 'fixed' && e.meta);
  const withMeta = entries.filter((e) => e.meta);
  const firstRound = withMeta.filter((e) => e.meta.rounds === 1);
  return {
    total: entries.length,
    fixed: fixed.length,
    firstRoundSuccessRate: withMeta.length ? Math.round((firstRound.length / withMeta.length) * 100) : 0,
    avgRounds: withMeta.length ? +(withMeta.reduce((s, e) => s + (e.meta.rounds || 0), 0) / withMeta.length).toFixed(1) : 0,
    playbookHitRate: withMeta.length ? Math.round((withMeta.filter((e) => e.meta.usedPlaybook).length / withMeta.length) * 100) : 0,
  };
}
```

测试:3 条(rounds 1/2/1,usedPlaybook true/false/true)→ {firstRoundSuccessRate: 67, avgRounds: 1.3, playbookHitRate: 67}。

cli.js `stats` 分支:

```js
    if (sub === 'stats') {
      const { loadKnowledge, repairStats } = await import('./repair/knowledge.js');
      const s = repairStats(loadKnowledge().entries);
      return emit(`修复经验统计:共 ${s.total} 条(fixed ${s.fixed});首轮成功率 ${s.firstRoundSuccessRate}%;平均轮数 ${s.avgRounds};playbook 命中 ${s.playbookHitRate}%`);
    }
```

help 文案 repair 行更新为 `repair <task|run|list|show|stats>`。

- [ ] **Step 2: upgrade 埋点**

upgrade.js 成功路径(`log('[webcli] 已升级到 ...')` 前)追加:

```js
  try {
    const { buildUploadConfig, reportMetric } = await import('./metrics.js');
    const metrics = await buildUploadConfig({ webcliVersion: version });
    reportMetric(metrics, 'install.upgrade', true, Date.now() - (upgradeStartedAt || Date.now()), undefined);
  } catch { /* 埋点静默 */ }
```

(`install` 首段在 metrics-server 噪音名单内,不污染 adapter 口径;`upgradeStartedAt` 在 runUpgrade 安装前赋值。)

- [ ] **Step 3: 跑测 → Step 4: 提交**

```bash
git add webcli/repair/cli.js webcli/repair/knowledge.js webcli/repair/executor.js webcli/upgrade.js webcli/__tests__/repair-cli.test.js webcli/__tests__/repair-knowledge.test.js
git commit -m "feat(repair): repair stats CLI + upgrade 埋点(噪音口径隔离)"
```

---

### Task F(收尾): PR #457 更新

- [ ] 全量 repair + adapterhub 套件回归
- [ ] PR 标题改为「Adapter 自进化一期+二期集成层」;正文追加二期改动清单与本计划链接
- [ ] 推送(fork)

---

## Self-Review 记录

- **Spec 覆盖**:二期 spec §5.4→Task B;§6→Task A;§7→Task C/D;§8→Task E(stats/埋点;看板延后如实注明);§9→机制预留不实现(如实)。P0/P2 延后已在计划头声明。
- **类型一致性**:`tasksFromPatrol(report, {now})`、`pickPlaybooks(entries, rootCause)`、`repairStats(entries)`、`recordExperience(file, entry, now, meta)`、`reportExperienceToHub({entry, registry, token, fetchImpl})`、`fetchHubExperiences({registry, site, runtime, rootCause, k, fetchImpl})` 各任务引用一致。
- **id 生成**:hub POST 缺 id 由服务端 sha1(site|runtime|symptom) 生成(与本地 entryKey 同算法)——Task C 实现时落实。
