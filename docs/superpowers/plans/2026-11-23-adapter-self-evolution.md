# Adapter 自进化一期实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 wewright(Python)adapter 的报错驱动自动修复管线(触发→修复→验证→草稿)+ 本地经验沉淀 + adapterhub 更新静默感知。

**Architecture:** 三层管线(触发解耦 / 执行统一 / 产物复用):errdetail→RepairTask→agent 修复循环(注入经验库)→分层验证→digest 守护草稿;adapterhub check/upgrade 静默感知做分发收敛。详见 `docs/superpowers/specs/2026-11-23-adapter-self-evolution-design.md`。

**Tech Stack:** Node ESM(webcli/ 既有零框架风格)、vitest、Webwright 运行时实跑(运行时门控)、node:test 不涉及。

---

## 执行前置

```bash
cd D:/github/WeWorker-fork
git fetch upstream dev-1.1.2 -q
git switch -c feat/adapter-self-evolution-dev112 upstream/dev-1.1.2
```

- 单测命令统一:`cd webcli && npx vitest run __tests__/<file>.test.js`
- 涉及 Webwright 实跑的用例必须带运行时门控(`resolveToolkitRuntime` 抛错即 `it.skip`),CI 无运行时自动跳过
- 所有新文件放 `webcli/repair/`,测试放 `webcli/__tests__/repair-*.test.js`

---

### Task 1: RepairTask 结构 + 状态机 + 持久化

**Files:**
- Create: `webcli/repair/task.js`
- Test: `webcli/__tests__/repair-task.test.js`

- [ ] **Step 1: 写失败测试**

```js
// webcli/__tests__/repair-task.test.js
import { describe, it, expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTask, transition, saveTask, loadTask, listTasks, tasksDir, TASK_STATUSES } from '../repair/task.js'

describe('buildTask', () => {
  it('正常构建:id 含日期、status=open、runtime=null', () => {
    const t = buildTask({ source: 'errdetail', adapterId: 'wekm', failures: [{ tool: 'wekm.get-article', count: 27, lastErr: 'exited code 1' }], now: Date.parse('2026-11-23T00:00:00Z') })
    expect(t.id).toBe('rt-2026-11-23-wekm')
    expect(t.status).toBe('open')
    expect(t.runtime).toBe(null)
    expect(t.createdAt).toBe('2026-11-23T00:00:00.000Z')
  })
  it('非法 source / 缺 adapterId / 空 failures 抛错', () => {
    expect(() => buildTask({ source: 'bogus', adapterId: 'x', failures: [{ tool: 't', count: 1 }] })).toThrow(/来源/)
    expect(() => buildTask({ source: 'manual', adapterId: '', failures: [{ tool: 't', count: 1 }] })).toThrow(/adapterId/)
    expect(() => buildTask({ source: 'manual', adapterId: 'x', failures: [] })).toThrow(/failures/)
    expect(() => buildTask({ source: 'manual', adapterId: 'x', failures: [{ tool: 't', count: 0 }] })).toThrow(/count/)
  })
})

describe('transition 状态机', () => {
  it('合法迁移 open→diagnosing→draft-ready→published', () => {
    let t = { status: 'open' }
    t = transition(t, 'diagnosing'); t = transition(t, 'draft-ready'); t = transition(t, 'published')
    expect(t.status).toBe('published')
  })
  it('非法迁移抛错(open→published 禁止;published 终态)', () => {
    expect(() => transition({ status: 'open' }, 'published')).toThrow(/非法状态迁移/)
    expect(() => transition({ status: 'published' }, 'open')).toThrow(/非法状态迁移/)
  })
  it('TASK_STATUSES 覆盖 7 个状态', () => {
    expect(TASK_STATUSES).toEqual(['open', 'diagnosing', 'draft-ready', 'published', 'archived', 'needs-login', 'needs-regeneration'])
  })
})

describe('持久化 round-trip', () => {
  it('save→load→list 一致(tmpdir 隔离)', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'repair-tasks-')), 'tasks')
    expect(tasksDir('/h')).toBe(join('/h', '.webcli', 'repair-tasks'))
    const t = buildTask({ source: 'manual', adapterId: 'wekm', failures: [{ tool: 'wekm.get-article', count: 5, lastErr: 'x' }] })
    saveTask(t, dir)
    expect(loadTask(t.id, dir).adapterId).toBe('wekm')
    expect(listTasks(dir)).toHaveLength(1)
  })
})
```

- [ ] **Step 2: 跑测确认失败**

Run: `cd webcli && npx vitest run __tests__/repair-task.test.js`
Expected: FAIL(Cannot find module '../repair/task.js')

- [ ] **Step 3: 实现 `webcli/repair/task.js`**

```js
/**
 * 修复任务结构与状态机(纯逻辑 + 持久化)。
 * 状态机:open → diagnosing → draft-ready → published;diagnosing/draft-ready 可转
 * needs-login / needs-regeneration / archived;needs-login 可重开;published/archived 受限。
 */
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

export const TASK_STATUSES = ["open", "diagnosing", "draft-ready", "published", "archived", "needs-login", "needs-regeneration"];

const TRANSITIONS = {
  open: ["diagnosing", "archived"],
  diagnosing: ["draft-ready", "needs-login", "needs-regeneration", "archived", "open"],
  "draft-ready": ["published", "archived"],
  published: [],
  archived: ["open"],
  "needs-login": ["open", "archived"],
  "needs-regeneration": ["archived"],
};

export function buildTask({ source, adapterId, failures = [], repro = null, now = Date.now() }) {
  if (!["errdetail", "patrol", "manual"].includes(source)) throw new Error(`未知任务来源: ${source}`);
  if (typeof adapterId !== "string" || !adapterId) throw new Error("adapterId 必填");
  if (!Array.isArray(failures) || !failures.length) throw new Error("failures 至少一条");
  for (const f of failures) {
    if (typeof f.tool !== "string" || !f.tool) throw new Error("failure.tool 必填");
    if (!Number.isFinite(f.count) || f.count < 1) throw new Error("failure.count 必须为正数");
  }
  const iso = new Date(now).toISOString();
  return {
    id: `rt-${iso.slice(0, 10)}-${adapterId}`,
    source, adapterId, runtime: null, failures, repro,
    status: "open", createdAt: iso, updatedAt: iso,
  };
}

export function transition(task, to) {
  if (!TASK_STATUSES.includes(to)) throw new Error(`未知状态: ${to}`);
  const allowed = TRANSITIONS[task.status] || [];
  if (!allowed.includes(to)) throw new Error(`非法状态迁移: ${task.status} → ${to}(允许: ${allowed.join(", ") || "无"})`);
  return { ...task, status: to, updatedAt: new Date().toISOString() };
}

export function tasksDir(home = homedir()) {
  return path.join(home, ".webcli", "repair-tasks");
}

export function saveTask(task, dir = tasksDir()) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${task.id}.json`);
  fs.writeFileSync(file, JSON.stringify(task, null, 2) + "\n");
  return file;
}

export function loadTask(id, dir = tasksDir()) {
  return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8"));
}

export function listTasks(dir = tasksDir()) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
}
```

- [ ] **Step 4: 跑测确认通过**

Run: `cd webcli && npx vitest run __tests__/repair-task.test.js`
Expected: PASS(全部用例)

- [ ] **Step 5: 提交**

```bash
git add webcli/repair/task.js webcli/__tests__/repair-task.test.js
git commit -m "feat(repair): RepairTask 结构 + 状态机 + 持久化"
```

---

### Task 2: errdetail → 修复任务生成

**Files:**
- Create: `webcli/repair/task-source.js`
- Test: `webcli/__tests__/repair-task-source.test.js`

- [ ] **Step 1: 写失败测试**

```js
// webcli/__tests__/repair-task-source.test.js
import { describe, it, expect } from 'vitest'
import { adapterIdOfTool, tasksFromErrDetail, fetchErrDetail } from '../repair/task-source.js'

const ERRDETAIL = {
  rows: [
    { err: 'Toolkit Adapter exited with code 1', tools: [
      { tool: 'wekm.get-article', calls: 27 }, { tool: 'wekm.list-articles', calls: 19 }, { tool: 'wekm.probe-charset', calls: 3 } ] },
    { err: 'Toolkit Adapter exited with code 1', tools: [ { tool: 'lowpkg.one', calls: 2 } ] },
  ],
}

describe('adapterIdOfTool', () => {
  it('取最后一个点之前;无点返回 null', () => {
    expect(adapterIdOfTool('wekm.get-article')).toBe('wekm')
    expect(adapterIdOfTool('auto-weoa-cnc-portal-tools.check-subsys-process')).toBe('auto-weoa-cnc-portal-tools')
    expect(adapterIdOfTool('open_browser')).toBe(null)
  })
})

describe('tasksFromErrDetail', () => {
  it('按 adapter 聚合、阈值过滤(minCalls=3)、failures 降序', () => {
    const tasks = tasksFromErrDetail(ERRDETAIL, { minCalls: 3, now: Date.parse('2026-11-23T00:00:00Z') })
    expect(tasks).toHaveLength(1)
    expect(tasks[0].adapterId).toBe('wekm')
    expect(tasks[0].source).toBe('errdetail')
    expect(tasks[0].failures.map((f) => f.tool)).toEqual(['wekm.get-article', 'wekm.list-articles', 'wekm.probe-charset'])
    expect(tasks[0].failures[0].count).toBe(27)
    expect(tasks[0].failures[0].lastErr).toContain('exited code 1')
  })
})

describe('fetchErrDetail', () => {
  it('缺 token 抛错;带 Bearer 请求正确 URL 并返回 JSON', async () => {
    await expect(fetchErrDetail({ token: null })).rejects.toThrow(/METRICS_STATS_TOKEN/)
    let called = null
    const fetchImpl = async (url, opts) => {
      called = { url, opts }
      return { ok: true, json: async () => ({ rows: [] }) }
    }
    const data = await fetchErrDetail({ token: 't', since: '7d', fetchImpl })
    expect(called.url).toBe('http://weworker.weoa.com/v1/stats?by=errdetail&kind=adapter&since=7d')
    expect(called.opts.headers.authorization).toBe('Bearer t')
    expect(data).toEqual({ rows: [] })
  })
})
```

- [ ] **Step 2: 跑测确认失败**

Run: `cd webcli && npx vitest run __tests__/repair-task-source.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 `webcli/repair/task-source.js`**

```js
/** 报错源:metrics-server errdetail → 统一修复任务。 */
import { buildTask } from "./task.js";

export function adapterIdOfTool(tool) {
  const i = String(tool).lastIndexOf(".");
  return i > 0 ? String(tool).slice(0, i) : null;
}

export function tasksFromErrDetail(errdetail, { minCalls = 3, now = Date.now() } = {}) {
  const byAdapter = new Map();
  for (const row of errdetail.rows || []) {
    for (const t of row.tools || []) {
      const adapterId = adapterIdOfTool(t.tool);
      if (!adapterId) continue;
      if (!byAdapter.has(adapterId)) byAdapter.set(adapterId, []);
      byAdapter.get(adapterId).push({ tool: t.tool, count: t.calls, lastErr: String(row.err || "").slice(0, 200) });
    }
  }
  const tasks = [];
  for (const [adapterId, failures] of byAdapter) {
    const total = failures.reduce((s, f) => s + f.count, 0);
    if (total < minCalls) continue;
    failures.sort((a, b) => b.count - a.count);
    tasks.push(buildTask({ source: "errdetail", adapterId, failures, now }));
  }
  return tasks;
}

export async function fetchErrDetail({ registry = process.env.METRICS_STATS_ENDPOINT || "http://weworker.weoa.com", token = process.env.METRICS_STATS_TOKEN, since = "7d", fetchImpl = fetch } = {}) {
  if (!token) throw new Error("缺少 METRICS_STATS_TOKEN 环境变量(工作台机器配置 errdetail 查询令牌)");
  const url = `${String(registry).replace(/\/$/, "")}/v1/stats?by=errdetail&kind=adapter&since=${encodeURIComponent(since)}`;
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`errdetail 拉取失败: ${res.status}`);
  return res.json();
}
```

- [ ] **Step 4: 跑测确认通过**

Run: `cd webcli && npx vitest run __tests__/repair-task-source.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add webcli/repair/task-source.js webcli/__tests__/repair-task-source.test.js
git commit -m "feat(repair): errdetail → RepairTask 任务生成"
```

---

### Task 3: wewright 包草稿读写(digest 守护)

**Files:**
- Create: `webcli/repair/wewright-draft.js`
- Test: `webcli/__tests__/repair-wewright-draft.test.js`

- [ ] **Step 1: 写失败测试**

```js
// webcli/__tests__/repair-wewright-draft.test.js
import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readWewrightTarget, writeRepairDraftWewright, patchVersion } from '../repair/wewright-draft.js'

const MANIFEST = {
  schema_version: 2, name: 'demo-fixture', version: '1.0.0',
  description: 'repair fixture', runtime_allowed_hosts: ['demo.example.com'],
  commands: [{ id: 'get-article', runtime: 'wewright', module: 'wewright/commands/get-article.py',
    description: 'get article', schema: { type: 'object', properties: { keyword: { type: 'string' } } } }],
}
const BROKEN_PY = "import json\nraise TypeError('title digit check missing')\n"

let env, adapterRoot
beforeAll(async () => {
  const home = await mkdtemp(join(tmpdir(), 'repair-draft-home-'))
  adapterRoot = join(home, 'adapters', 'demo-fixture')
  await mkdir(join(adapterRoot, 'wewright', 'commands'), { recursive: true })
  await writeFile(join(adapterRoot, 'manifest.json'), JSON.stringify(MANIFEST, null, 2))
  await writeFile(join(adapterRoot, 'wewright', 'commands', 'get-article.py'), BROKEN_PY)
  // 同一目录双写,规避 host/cli 覆盖冲突检查
  env = { WEWORKER_USER_ADAPTERS_DIR: join(home, 'adapters'), WEBCLI_ADAPTERS_DIR: join(home, 'adapters'), HOME: home }
})

describe('readWewrightTarget', () => {
  it('读取已装包并校验 wewright runtime', () => {
    const { adapterId, pkg } = readWewrightTarget('demo-fixture', { env })
    expect(adapterId).toBe('demo-fixture')
    expect(pkg.digest).toMatch(/^sha256:/)
    expect(pkg.commands[0].runtime).toBe('wewright')
  })
  it('包不存在 / 非 wewright 包报错', async () => {
    expect(() => readWewrightTarget('nope', { env })).toThrow(/未找到已装 adapter/)
  })
})

describe('patchVersion', () => {
  it('patch+1;缺段补 0', () => {
    expect(patchVersion('1.0.0')).toBe('1.0.1')
    expect(patchVersion('1.0')).toBe('1.0.1')
  })
})

describe('writeRepairDraftWewright', () => {
  it('digest 守护 + 补丁叠加 + 版本 bump + 草稿落盘', async () => {
    const { pkg } = readWewrightTarget('demo-fixture', { env })
    const FIXED_PY = "import json\nprint(json.dumps({'ok': True, 'title': 'ok'}))\n"
    const draft = writeRepairDraftWewright({
      adapterId: 'demo-fixture', expectedDigest: pkg.digest,
      patchedFiles: { 'wewright/commands/get-article.py': FIXED_PY },
      env, now: Date.parse('2026-11-23T00:00:00Z'),
    })
    expect(draft.version).toBe('1.0.1')
    expect(draft.digest).not.toBe(pkg.digest)
    const written = await readFile(join(draft.draftDir, 'wewright', 'commands', 'get-article.py'), 'utf8')
    expect(written).toContain("'ok': True")
    const manifest = JSON.parse(await readFile(join(draft.draftDir, 'manifest.json'), 'utf8'))
    expect(manifest.version).toBe('1.0.1')
  })
  it('基线变化拒绝(ADAPTER_BASE_CHANGED)与包外文件拒绝', async () => {
    expect(() => writeRepairDraftWewright({
      adapterId: 'demo-fixture', expectedDigest: 'sha256:stale', patchedFiles: { 'wewright/commands/get-article.py': 'x' }, env,
    })).toThrow(/ADAPTER_BASE_CHANGED/)
    const { pkg } = readWewrightTarget('demo-fixture', { env })
    expect(() => writeRepairDraftWewright({
      adapterId: 'demo-fixture', expectedDigest: pkg.digest, patchedFiles: { 'nope.py': 'x' }, env,
    })).toThrow(/补丁文件不在包内/)
  })
})
```

- [ ] **Step 2: 跑测确认失败**

Run: `cd webcli && npx vitest run __tests__/repair-wewright-draft.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 `webcli/repair/wewright-draft.js`**

```js
/**
 * wewright 包修复草稿:digest 守护读取 + 补丁叠加 + 版本 patch+1,落独立草稿目录。
 * 不动 live 安装;通过验证 + 人工确认后才是安装/发布。
 */
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { readPackageDirectory, writePackageDirectory } from "../adapter-package-files.js";
import { resolveUserAdaptersDir } from "../paths.js";

export function readWewrightTarget(adapterId, { env = process.env, home = homedir() } = {}) {
  const root = path.join(resolveUserAdaptersDir({ env, home }), adapterId);
  if (!fs.existsSync(root)) throw new Error(`未找到已装 adapter: ${adapterId}(路径 ${root})`);
  const pkg = readPackageDirectory(root);
  if (!pkg.commands.some((c) => c.runtime === "wewright")) {
    throw new Error(`adapter ${adapterId} 不含 wewright 命令,请走既有 extension/http 修复工作流`);
  }
  return { adapterId, pkg };
}

export function patchVersion(version) {
  const parts = String(version).split(".");
  const patch = (parseInt(parts[2] || "0", 10) || 0) + 1;
  return [parts[0] || "0", parts[1] || "0", String(patch)].join(".");
}

export function writeRepairDraftWewright({ adapterId, expectedDigest, patchedFiles, env = process.env, home = homedir(), draftsRoot = path.join(homedir(), ".webcli", "repair-drafts"), now = Date.now() }) {
  const { pkg } = readWewrightTarget(adapterId, { env, home });
  if (pkg.digest !== expectedDigest) {
    throw new Error(`ADAPTER_BASE_CHANGED: 包基线已变化(期望 ${String(expectedDigest).slice(0, 12)},实际 ${pkg.digest.slice(0, 12)}),请重新读取取证`);
  }
  const names = Object.keys(patchedFiles || {});
  if (!names.length) throw new Error("patchedFiles 至少一个文件");
  for (const name of names) {
    if (!pkg.files.has(name)) throw new Error(`补丁文件不在包内: ${name}`);
  }
  const manifest = { ...pkg.manifest, version: patchVersion(pkg.manifest.version) };
  const files = new Map(pkg.files);
  for (const [name, content] of Object.entries(patchedFiles)) {
    files.set(name, Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8"));
  }
  files.set("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8"));
  const stamp = new Date(now).toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const draftDir = path.join(draftsRoot, `${adapterId}-${stamp}`);
  writePackageDirectory(draftDir, files);
  const drafted = readPackageDirectory(draftDir);
  return { draftDir, digest: drafted.digest, version: manifest.version, files: [...files.keys()] };
}
```

- [ ] **Step 4: 跑测确认通过**

Run: `cd webcli && npx vitest run __tests__/repair-wewright-draft.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add webcli/repair/wewright-draft.js webcli/__tests__/repair-wewright-draft.test.js
git commit -m "feat(repair): wewright 包草稿读写(digest 守护 + 版本 bump)"
```

---

### Task 4: 验证器(静态 + 断言 + 重放 + 冒烟)

**Files:**
- Create: `webcli/repair/verify.js`
- Test: `webcli/__tests__/repair-verify.test.js`

- [ ] **Step 1: 写失败测试**

```js
// webcli/__tests__/repair-verify.test.js
import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertExpect, verifyStatically, verifyRepair } from '../repair/verify.js'

async function buildDraft({ version = '1.0.1', py = "import json\nprint(json.dumps({'ok': True}))\n" } = {}) {
  const dir = join(await mkdtemp(join(tmpdir(), 'repair-verify-')), 'demo-fixture')
  await mkdir(join(dir, 'wewright', 'commands'), { recursive: true })
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({
    schema_version: 2, name: 'demo-fixture', version, description: 'd', runtime_allowed_hosts: ['demo.example.com'],
    commands: [{ id: 'get-article', runtime: 'wewright', module: 'wewright/commands/get-article.py', description: 'd', schema: { type: 'object' } }],
  }, null, 2))
  await writeFile(join(dir, 'wewright', 'commands', 'get-article.py'), py)
  return dir
}

const TASK = { adapterId: 'demo-fixture', failures: [{ tool: 'demo-fixture.get-article', count: 3, lastErr: 'x' }] }

describe('assertExpect', () => {
  it('requiredPaths / notEmpty / equals / patterns / rowCount 各语义', () => {
    expect(assertExpect({ a: 1, b: 'x', rows: [1] }, { requiredPaths: ['a'], notEmpty: ['b'], equals: { a: 1 }, patterns: { b: '^x' }, rowCount: { rows: 1 } })).toEqual([])
  })
  it('违规逐条报错', () => {
    const errs = assertExpect({ a: null, rows: [] }, { requiredPaths: ['missing'], notEmpty: ['a'], rowCount: { rows: 2 } })
    expect(errs).toHaveLength(3)
  })
})

describe('verifyStatically', () => {
  it('manifest/模块检查;版本未 bump 记失败', async () => {
    const dir = await buildDraft({ version: '1.0.0' })
    const { checks } = verifyStatically(dir, { baseVersion: '1.0.0' })
    expect(checks.find((c) => c.name === 'version-bumped').passed).toBe(false)
    expect(checks.find((c) => c.name === 'module-exists:get-article').passed).toBe(true)
  })
})

describe('verifyRepair(无运行时,注入 replayImpl)', () => {
  it('全绿 → passed;重放失败 → passed=false 且 fixture 跳过', async () => {
    const dir = await buildDraft({})
    const good = { exitCode: 0, result: { ok: true, title: 'ok', rows: [1, 2] } }
    const fixtures = [{ id: 'f1', commandId: 'get-article', expect: { equals: { ok: true }, rowCount: { rows: 2 } } }]
    const pass = await verifyRepair({ task: TASK, draftDir: dir, baseVersion: '1.0.0', fixtures, replayImpl: async () => good, log: () => {} })
    expect(pass.passed).toBe(true)
    const bad = await verifyRepair({ task: TASK, draftDir: dir, baseVersion: '1.0.0', fixtures, replayImpl: async () => ({ exitCode: 1, result: null, stderrTail: 'boom' }), log: () => {} })
    expect(bad.passed).toBe(false)
    expect(bad.checks.find((c) => c.name === 'replay:get-article').passed).toBe(false)
    expect(bad.checks.find((c) => c.name === 'fixture:f1')).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测确认失败**

Run: `cd webcli && npx vitest run __tests__/repair-verify.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 `webcli/repair/verify.js`**

```js
/**
 * 分层验证(确定性判定):静态 → 复现重放 → fixture 断言 → 回归冒烟。
 * 实跑依赖 Webwright 运行时,仅工作台机器可用;测试注入 replayImpl。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readPackageDirectory } from "../adapter-package-files.js";

export function assertExpect(result, expect = {}) {
  const errors = [];
  const dig = (obj, p) => String(p).split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
  for (const p of expect.requiredPaths || []) if (dig(result, p) === undefined) errors.push(`缺字段 ${p}`);
  for (const p of expect.notEmpty || []) {
    const v = dig(result, p);
    if (v == null || v === "" || (Array.isArray(v) && !v.length)) errors.push(`空值 ${p}`);
  }
  for (const [p, want] of Object.entries(expect.equals || {})) {
    if (JSON.stringify(dig(result, p)) !== JSON.stringify(want)) errors.push(`不等 ${p}`);
  }
  for (const [p, re] of Object.entries(expect.patterns || {})) {
    if (!new RegExp(re).test(String(dig(result, p) ?? ""))) errors.push(`不匹配 ${p}`);
  }
  for (const [p, n] of Object.entries(expect.rowCount || {})) {
    const v = dig(result, p);
    if (!Array.isArray(v) || v.length < n) errors.push(`行数 ${p} < ${n}`);
  }
  return errors;
}

export function verifyStatically(draftDir, { baseVersion } = {}) {
  const pkg = readPackageDirectory(draftDir);
  const checks = [{ name: "manifest-schema", passed: Boolean(pkg.manifest?.version && Array.isArray(pkg.commands) && pkg.commands.length) }];
  if (baseVersion !== undefined) {
    checks.push({ name: "version-bumped", passed: pkg.manifest.version !== baseVersion });
  }
  for (const command of pkg.commands.filter((c) => c.runtime === "wewright")) {
    const file = path.join(draftDir, command.module);
    const exists = existsSync(file);
    checks.push({ name: `module-exists:${command.id}`, passed: exists });
    if (exists) checks.push({ name: `module-nonempty:${command.id}`, passed: readFileSync(file).length > 0 });
  }
  return { pkg, checks };
}

export async function replayCommand({ pkg, commandId, args = {}, runtimePath, env }) {
  const { runToolkitTool } = await import("../toolkit-runner.js");
  const command = pkg.commands.find((c) => c.id === commandId);
  if (!command) throw new Error(`命令不存在: ${commandId}`);
  const match = {
    adapter: { root: pkg.root, entryPath: path.join(pkg.root, command.module) },
    tool: { id: command.id, name: `${pkg.manifest.name}.${command.id}` },
  };
  return runToolkitTool(match, args, { runtimePath, env });
}

export async function verifyRepair({ task, draftDir, baseVersion, fixtures = [], smoke = true, runtimePath, env, log = () => {}, replayImpl = replayCommand }) {
  const checks = [];
  const stat = verifyStatically(draftDir, { baseVersion });
  checks.push(...stat.checks);
  const pkg = stat.pkg;
  const primary = task.failures?.[0]?.tool?.split(".").pop();
  let replayOk = false;
  let replayResult = null;
  if (primary) {
    try {
      const completed = await replayImpl({ pkg, commandId: primary, args: task.repro?.sample || {}, runtimePath, env });
      replayOk = completed.exitCode === 0;
      replayResult = completed.result;
      checks.push({ name: `replay:${primary}`, passed: replayOk, exitCode: completed.exitCode, stderrTail: completed.stderrTail || null });
    } catch (e) {
      checks.push({ name: `replay:${primary}`, passed: false, error: e.message });
    }
  }
  if (replayOk) {
    for (const fixture of fixtures.filter((f) => f.commandId === primary)) {
      const errors = assertExpect(replayResult, fixture.expect);
      checks.push({ name: `fixture:${fixture.id}`, passed: !errors.length, errors });
    }
    if (smoke) {
      for (const command of pkg.commands.filter((c) => c.runtime === "wewright" && c.id !== primary)) {
        try {
          const completed = await replayImpl({ pkg, commandId: command.id, args: {}, runtimePath, env });
          checks.push({ name: `smoke:${command.id}`, passed: completed.exitCode === 0 });
        } catch (e) {
          checks.push({ name: `smoke:${command.id}`, passed: false, error: e.message });
        }
      }
    }
  }
  const passed = checks.length > 0 && checks.every((c) => c.passed);
  log(`[verify] ${checks.map((c) => `${c.passed ? "✓" : "✗"}${c.name}`).join(" ")}`);
  return { passed, checks };
}
```

- [ ] **Step 4: 跑测确认通过**

Run: `cd webcli && npx vitest run __tests__/repair-verify.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add webcli/repair/verify.js webcli/__tests__/repair-verify.test.js
git commit -m "feat(repair): 分层验证器(静态/断言/重放/冒烟)"
```

---

### Task 5: 本地经验库(沉淀/检索/注入)

**Files:**
- Create: `webcli/repair/knowledge.js`
- Test: `webcli/__tests__/repair-knowledge.test.js`

- [ ] **Step 1: 写失败测试**

```js
// webcli/__tests__/repair-knowledge.test.js
import { describe, it, expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadKnowledge, recordExperience, searchExperience, injectContext, KNOWLEDGE_LIMIT } from '../repair/knowledge.js'

const ENTRY = { site: 'wekm', runtime: 'wewright', symptom: 'exited code 1: TypeError title', rootCause: 'SSO 过期后 fetch 返回登录页', fixStrategy: '先探登录态,失效返回 needs-login 引导', outcome: 'fixed' }

describe('recordExperience', () => {
  it('新增 + 同 pattern 去重合并(hits+1)', () => {
    const f = join(tmpdir(), `rk-${Math.random().toString(36).slice(2)}.json`)
    recordExperience(f, ENTRY, '2026-11-23T00:00:00Z')
    recordExperience(f, ENTRY, '2026-11-24T00:00:00Z')
    const { entries } = loadKnowledge(f)
    expect(entries).toHaveLength(1)
    expect(entries[0].hits).toBe(2)
  })
  it('超限淘汰最旧(保留 LIMIT 条)', () => {
    const f = join(tmpdir(), `rk-${Math.random().toString(36).slice(2)}.json`)
    for (let i = 0; i < KNOWLEDGE_LIMIT + 5; i++) recordExperience(f, { ...ENTRY, symptom: `symptom-${i}` })
    expect(loadKnowledge(f).entries.length).toBe(KNOWLEDGE_LIMIT)
  })
  it('损坏文件备份重建,不抛错', () => {
    const f = join(tmpdir(), `rk-${Math.random().toString(36).slice(2)}.json`)
    require('node:fs').writeFileSync(f, '{broken')
    expect(loadKnowledge(f).entries).toEqual([])
    expect(loadKnowledge(f).entries).toEqual([])
  })
})

describe('searchExperience', () => {
  it('site 精确匹配权重最高;无命中返回空', () => {
    const f = join(tmpdir(), `rk-${Math.random().toString(36).slice(2)}.json`)
    recordExperience(f, ENTRY)
    recordExperience(f, { ...ENTRY, site: 'other', symptom: 'exited code 1: TypeError title' })
    const hits = searchExperience(f, { site: 'wekm', runtime: 'wewright', errSignature: 'TypeError title' }, 3)
    expect(hits[0].site).toBe('wekm')
    expect(hits).toHaveLength(2)
  })
})

describe('injectContext', () => {
  it('有条目输出格式化块;空库输出提示', () => {
    expect(injectContext([])).toContain('暂无相关条目')
    const text = injectContext([{ site: 'wekm', runtime: 'wewright', symptom: 's', rootCause: 'r', fixStrategy: 'f', outcome: 'fixed', hits: 2 }])
    expect(text).toContain('[wekm/wewright]')
    expect(text).toContain('策略: f')
  })
})
```

注意:`require` 在 ESM 测试里不可用,损坏文件用例改用:

```js
import { writeFileSync } from 'node:fs'
// ...
writeFileSync(f, '{broken')
```

- [ ] **Step 2: 跑测确认失败**

Run: `cd webcli && npx vitest run __tests__/repair-knowledge.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 `webcli/repair/knowledge.js`**

```js
/**
 * 本地跨 adapter 经验库(~/.webcli/repair-knowledge.json)。
 * 修复结束自动沉淀;修复/探索前按 site+runtime+错误签名检索 Top-K 注入。
 */
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

export const KNOWLEDGE_LIMIT = 200;

export function knowledgePath(home = homedir()) {
  return path.join(home, ".webcli", "repair-knowledge.json");
}

export function loadKnowledge(file = knowledgePath()) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return { entries: Array.isArray(data.entries) ? data.entries : [] };
  } catch {
    if (fs.existsSync(file)) {
      try { fs.copyFileSync(file, `${file}.corrupt.bak`); } catch { /* 备份失败不阻塞 */ }
    }
    return { entries: [] };
  }
}

export function entryKey(entry) {
  return createHash("sha1").update(`${entry.site}|${entry.runtime}|${entry.symptom}`).digest("hex").slice(0, 12);
}

export function recordExperience(file, entry, now = new Date().toISOString()) {
  const clean = {
    id: entryKey(entry),
    site: String(entry.site || ""), runtime: String(entry.runtime || ""),
    symptom: String(entry.symptom || "").slice(0, 500),
    rootCause: String(entry.rootCause || "").slice(0, 500),
    fixStrategy: String(entry.fixStrategy || "").slice(0, 1000),
    outcome: entry.outcome === "failed" ? "failed" : "fixed",
    evidenceRef: String(entry.evidenceRef || "").slice(0, 200), date: now,
  };
  const data = loadKnowledge(file);
  const idx = data.entries.findIndex((e) => e.id === clean.id);
  if (idx >= 0) data.entries[idx] = { ...data.entries[idx], ...clean, hits: (data.entries[idx].hits || 0) + 1 };
  else data.entries.push({ ...clean, hits: 1 });
  data.entries.sort((a, b) => (b.hits || 0) - (a.hits || 0) || String(b.date).localeCompare(String(a.date)));
  if (data.entries.length > KNOWLEDGE_LIMIT) data.entries = data.entries.slice(0, KNOWLEDGE_LIMIT);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  return clean;
}

export function searchExperience(home = homedir(), { site = "", runtime = "", errSignature = "" } = {}, k = 3, file = knowledgePath(home)) {
  const { entries } = loadKnowledge(file);
  const sigTokens = String(errSignature).toLowerCase().split(/\W+/).filter((t) => t.length > 3);
  return entries.map((e) => {
    let score = 0;
    if (site && e.site === site) score += 2;
    if (runtime && e.runtime === runtime) score += 1;
    const hay = `${e.symptom} ${e.rootCause}`.toLowerCase();
    score += sigTokens.filter((t) => hay.includes(t)).length;
    return { entry: e, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, k).map((x) => x.entry);
}

export function injectContext(entries) {
  if (!entries.length) return "经验库暂无相关条目。";
  return "相关修复经验:\n" + entries.map((e) =>
    `- [${e.site}/${e.runtime}] 症状: ${e.symptom}\n  根因: ${e.rootCause}\n  策略: ${e.fixStrategy}(${e.outcome},命中 ${e.hits || 1} 次)`,
  ).join("\n");
}
```

- [ ] **Step 4: 跑测确认通过**

Run: `cd webcli && npx vitest run __tests__/repair-knowledge.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add webcli/repair/knowledge.js webcli/__tests__/repair-knowledge.test.js
git commit -m "feat(repair): 本地经验库(沉淀/检索/注入)"
```

---

### Task 6: 修复执行循环 + repair CLI + 接线

**Files:**
- Create: `webcli/repair/executor.js`
- Create: `webcli/repair/cli.js`
- Modify: `webcli/index.js:1874`(adapterhub 分发块之后加 repair 分发)、`webcli/index.js:1387`(BUILTIN_HELP_EXEMPT 加 "repair")
- Test: `webcli/__tests__/repair-executor.test.js`

- [ ] **Step 1: 写失败测试**

```js
// webcli/__tests__/repair-executor.test.js
import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runRepairLoop } from '../repair/executor.js'
import { buildTask } from '../repair/task.js'

const FIXED_PY = "import json\nprint(json.dumps({'ok': True}))\n"
let env, home

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'repair-exec-'))
  const adapterRoot = join(home, 'adapters', 'demo-fixture')
  await mkdir(join(adapterRoot, 'wewright', 'commands'), { recursive: true })
  await writeFile(join(adapterRoot, 'manifest.json'), JSON.stringify({
    schema_version: 2, name: 'demo-fixture', version: '1.0.0', description: 'd', runtime_allowed_hosts: ['demo.example.com'],
    commands: [{ id: 'get-article', runtime: 'wewright', module: 'wewright/commands/get-article.py', description: 'd', schema: { type: 'object' } }],
  }, null, 2))
  await writeFile(join(adapterRoot, 'wewright', 'commands', 'get-article.py'), 'raise TypeError("broken")\n')
  env = { WEWORKER_USER_ADAPTERS_DIR: join(home, 'adapters'), WEBCLI_ADAPTERS_DIR: join(home, 'adapters'), HOME: home }
})

const TASK = () => buildTask({ source: 'manual', adapterId: 'demo-fixture', failures: [{ tool: 'demo-fixture.get-article', count: 3, lastErr: 'x' }] })

describe('runRepairLoop', () => {
  it('诊断→补丁→验证通过 → draft-ready', async () => {
    const llm = { async diagnose() { return { rootCause: 'logic-bug', reasoning: 'r', patchedFiles: { 'wewright/commands/get-article.py': FIXED_PY } } } }
    const verifyImpl = async () => ({ passed: true, checks: [{ name: 'fake', passed: true }] })
    const { task, outcome, draft } = await runRepairLoop({ task: TASK(), llm, env, home, verifyImpl, log: () => {} })
    expect(outcome).toBe('draft-ready')
    expect(task.status).toBe('draft-ready')
    expect(draft.version).toBe('1.0.1')
  })
  it('needs-regeneration 提前终止', async () => {
    const llm = { async diagnose() { return { rootCause: 'needs-regeneration', reasoning: '站点改版' } } }
    const { task, outcome } = await runRepairLoop({ task: TASK(), llm, env, home, verifyImpl: async () => ({ passed: true, checks: [] }), log: () => {} })
    expect(outcome).toBe('needs-regeneration')
    expect(task.status).toBe('needs-regeneration')
  })
  it('3 轮仍失败 → archived(exhausted)', async () => {
    const llm = { async diagnose() { return { rootCause: 'logic-bug', patchedFiles: { 'wewright/commands/get-article.py': FIXED_PY } } }, async revise() { return { rootCause: 'logic-bug', patchedFiles: {} } } }
    const { task, outcome } = await runRepairLoop({ task: TASK(), llm, env, home, verifyImpl: async () => ({ passed: false, checks: [{ name: 'x', passed: false }] }), log: () => {} })
    expect(outcome).toBe('exhausted')
    expect(task.status).toBe('archived')
  })
  it('修复结果回写经验库(固定 home)', async () => {
    const llm = { async diagnose() { return { rootCause: 'logic-bug', patchedFiles: { 'wewright/commands/get-article.py': FIXED_PY } } } }
    await runRepairLoop({ task: TASK(), llm, env, home, verifyImpl: async () => ({ passed: true, checks: [] }), log: () => {} })
    const { loadKnowledge } = await import('../repair/knowledge.js')
    const { entries } = loadKnowledge(join(home, '.webcli', 'repair-knowledge.json'))
    expect(entries.some((e) => e.site === 'demo-fixture' && e.outcome === 'fixed')).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测确认失败**

Run: `cd webcli && npx vitest run __tests__/repair-executor.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 `webcli/repair/executor.js`**

```js
/**
 * 修复执行循环:取证 → 诊断(LLM 注入)→ 补丁草稿 → 分层验证,有界 ≤maxRounds 轮。
 * rootCause: 'login-expired' | 'needs-regeneration' 提前终止;其余产出补丁走验证。
 */
import { readWewrightTarget, writeRepairDraftWewright } from "./wewright-draft.js";
import { verifyRepair } from "./verify.js";
import { searchExperience, injectContext, recordExperience, knowledgePath } from "./knowledge.js";
import { transition, saveTask } from "./task.js";

export async function runRepairLoop({ task, llm, env = process.env, home = homedir(), maxRounds = 3, log = () => {}, now = Date.now(), save = saveTask, verifyImpl = verifyRepair }) {
  task = transition(task, "diagnosing");
  save(task, join(home, ".webcli", "repair-tasks"));
  const { pkg } = readWewrightTarget(task.adapterId, { env, home });
  const experienceHint = injectContext(searchExperience(home, { site: task.adapterId, runtime: "wewright", errSignature: task.failures?.[0]?.lastErr || "" }, 3, knowledgePath(home)));
  const baseVersion = pkg.manifest.version;
  let feedback = null;
  for (let round = 1; round <= maxRounds; round++) {
    log(`[repair] 第 ${round}/${maxRounds} 轮`);
    const ctx = { task, failure: task.failures?.[0], experienceHint, feedback, round, baseVersion };
    const proposal = round === 1 ? await llm.diagnose(ctx) : await llm.revise(ctx);
    if (proposal.rootCause === "needs-regeneration" || proposal.rootCause === "login-expired") {
      const to = proposal.rootCause === "needs-regeneration" ? "needs-regeneration" : "needs-login";
      task = transition(task, to);
      save(task, join(home, ".webcli", "repair-tasks"));
      return { task, outcome: to, reasoning: proposal.reasoning || "" };
    }
    if (!proposal.patchedFiles || !Object.keys(proposal.patchedFiles).length) {
      feedback = "诊断未产出补丁";
      continue;
    }
    let draft;
    try {
      draft = writeRepairDraftWewright({ adapterId: task.adapterId, expectedDigest: pkg.digest, patchedFiles: proposal.patchedFiles, env, home, now });
    } catch (e) {
      feedback = `草稿失败: ${e.message}`;
      log(`[repair] ${feedback}`);
      continue;
    }
    const verification = await verifyImpl({ task, draftDir: draft.draftDir, baseVersion, env, home, log });
    if (verification.passed) {
      task = transition(task, "draft-ready");
      save(task, join(home, ".webcli", "repair-tasks"));
      recordExperience(join(home, ".webcli", "repair-knowledge.json"), {
        site: task.adapterId, runtime: "wewright",
        symptom: task.failures?.[0]?.lastErr || "",
        rootCause: proposal.rootCause, fixStrategy: proposal.reasoning || "",
        outcome: "fixed", evidenceRef: draft.draftDir,
      });
      return { task, outcome: "draft-ready", draft, verification };
    }
    feedback = `验证未通过: ${verification.checks.filter((c) => !c.passed).map((c) => c.name).join(", ")}`;
    log(`[repair] ${feedback}`);
  }
  task = transition(task, "archived");
  save(task, join(home, ".webcli", "repair-tasks"));
  recordExperience(join(home, ".webcli", "repair-knowledge.json"), {
    site: task.adapterId, runtime: "wewright",
    symptom: task.failures?.[0]?.lastErr || "",
    rootCause: "unresolved", fixStrategy: feedback || "", outcome: "failed",
    evidenceRef: "",
  });
  return { task, outcome: "exhausted" };
}

import { join } from "node:path";
```

- [ ] **Step 4: 实现 `webcli/repair/cli.js`**

```js
/**
 * webgo repair <task|run|list|show> —— 修复任务 CLI(工作台机器使用)。
 * 退出码:0 成功;2 参数错误;1 运行错误。--json 时 stdout 仅一个 JSON 对象。
 */
export async function runRepairCli(args, { outputFormat } = {}) {
  const [sub, ...rest] = args;
  const fail = (message, code = 1) => { console.error(`[repair] ${message}`); process.exitCode = code; };
  const emit = (value) => console.log(outputFormat === 'json' || rest.includes('--json') ? JSON.stringify(value, null, 2) : value);
  const { listTasks, loadTask, buildTask, saveTask } = await import("./task.js");
  const { tasksFromErrDetail, fetchErrDetail } = await import("./task-source.js");

  try {
    if (sub === "task" && rest.includes("--from")) {
      const opt = (name, dflt) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : dflt; };
      const since = opt("--since", "7d");
      const minCalls = parseInt(opt("--min-calls", "3"), 10);
      const detail = await fetchErrDetail({ since });
      const tasks = tasksFromErrDetail(detail, { minCalls });
      for (const t of tasks) saveTask(t);
      return emit(`生成 ${tasks.length} 个修复任务: ${tasks.map((t) => t.id).join(", ") || "(无)"}`);
    }
    if (sub === "run" && rest[0]) {
      const { runRepairLoop } = await import("./executor.js");
      const task = loadTask(rest[0]);
      const { task: done, outcome } = await runRepairLoop({ task, llm: await resolveLlm(), log: (m) => console.error(m) });
      return emit(`修复循环结束: ${done.id} → ${outcome}`);
    }
    if (sub === "list") return emit(listTasks().map((t) => `${t.id} [${t.status}] ${t.source} 失败:${t.failures.reduce((s, f) => s + f.count, 0)}`).join("\n") || "(无任务)");
    if (sub === "show" && rest[0]) return emit(JSON.stringify(loadTask(rest[0]), null, 2));
    throw new Error("用法: webgo repair task --from errors [--since 7d] [--min-calls 3] | repair run <taskId> | repair list | repair show <taskId>");
  } catch (e) {
    return fail(e.message);
  }

  async function resolveLlm() {
    // 一期:聊天 agent 担当 LLM——执行时由调用方注入;独立 CLI 跑需要配置
    // WEBCLI_REPAIR_LLM_CMD(可执行命令,stdin 收 JSON 上下文,stdout 回 JSON 提案)。
    const cmd = process.env.WEBCLI_REPAIR_LLM_CMD;
    if (!cmd) throw new Error("缺少 WEBCLI_REPAIR_LLM_CMD(或在聊天 agent 内直接调用 runRepairLoop 注入 llm)");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const make = (phase) => async (ctx) => {
      const out = await run(cmd, [], { input: JSON.stringify({ phase, ...ctx }), shell: process.platform === "win32", maxBuffer: 4 * 1024 * 1024 });
      return JSON.parse(out.stdout.trim().split(/\r?\n/).at(-1));
    };
    return { diagnose: make("diagnose"), revise: make("revise") };
  }
}
```

- [ ] **Step 5: 接线 index.js(两处)**

`webcli/index.js:1874` adapterhub 分发块之后追加:

```js
  // repair <...>
  if (cmd === "repair") {
    const { runRepairCli } = await import("./repair/cli.js");
    await runRepairCli(args.slice(1), { outputFormat });
    return;
  }
```

`webcli/index.js:1387` 改为:

```js
const BUILTIN_HELP_EXEMPT = new Set(["adapterhub", "stats", "repair"]);
```

并在 help 文案 adapterhub 段之后(`webcli/index.js:158` 附近)加一行:

```
  repair <task|run|list|show>               修复任务:报错生成 / 执行修复循环 / 查看
```

- [ ] **Step 6: 跑测确认通过**

Run: `cd webcli && npx vitest run __tests__/repair-executor.test.js __tests__/repair-task.test.js`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add webcli/repair/executor.js webcli/repair/cli.js webcli/__tests__/repair-executor.test.js webcli/index.js
git commit -m "feat(repair): 修复执行循环 + repair CLI + 接线"
```

---

### Task 7: 合成故障 fixture 端到端(运行时门控)

**Files:**
- Create: `webcli/__tests__/fixtures/repair-fixture/manifest.json`
- Create: `webcli/__tests__/fixtures/repair-fixture/wewright/commands/get-article.py`
- Create: `webcli/__tests__/fixtures/repair-fixture/wewright/commands/get-article.fixed.py`
- Test: `webcli/__tests__/repair-e2e.test.js`

- [ ] **Step 1: 落 fixture 文件**

`manifest.json`:

```json
{
  "schema_version": 2,
  "name": "demo-fixture",
  "version": "1.0.0",
  "description": "合成故障 adapter(自进化回归用):broken 版缺登录/参数分支直接抛 TypeError",
  "runtime_allowed_hosts": ["demo.example.com"],
  "commands": [
    { "id": "get-article", "runtime": "wewright", "module": "wewright/commands/get-article.py", "description": "get article", "schema": { "type": "object", "properties": { "keyword": { "type": "string" } } } }
  ]
}
```

`wewright/commands/get-article.py`(故障版):

```python
import json

async def get_article(ctx, keyword=None):
    """故障版:keyword 缺失直接抛 TypeError(模拟上游校验缺失)。"""
    if keyword is None:
        raise TypeError("article title expected str, got None")
    print(json.dumps({"ok": True, "title": "article:" + str(keyword), "rows": [1, 2]}))
```

`wewright/commands/get-article.fixed.py`(修复参考,测试断言 LLM 产出与之等价):

```python
import json

async def get_article(ctx, keyword=None):
    """修复版:参数缺失返回结构化错误,正常路径返回文章。"""
    if not keyword:
        print(json.dumps({"ok": False, "error": "keyword is required", "needs_user": True}))
        return
    print(json.dumps({"ok": True, "title": "article:" + str(keyword), "rows": [1, 2]}))
```

- [ ] **Step 2: 写端到端测试(运行时门控)**

```js
// webcli/__tests__/repair-e2e.test.js
import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtemp, cp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTask } from '../repair/task.js'
import { runRepairLoop } from '../repair/executor.js'
import { resolveToolkitRuntime } from '../toolkit-runner.js'

let runtimePath = null
try { runtimePath = resolveToolkitRuntime(); } catch { /* 无运行时环境:跳过 */ }

describe.runIf(runtimePath)('repair 端到端(Webwright 实跑)', () => {
  let env, home
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'repair-e2e-'))
    const adapters = join(home, 'adapters')
    await cp(join(import.meta.dirname, 'fixtures', 'repair-fixture'), join(adapters, 'demo-fixture'), { recursive: true })
    env = { ...process.env, WEWORKER_USER_ADAPTERS_DIR: adapters, WEBCLI_ADAPTERS_DIR: adapters, HOME: home, WEWORKER_TOOLKIT_RUNTIME: runtimePath }
  })

  it('故障 fixture:真实验证层跑通修复循环(假 LLM 按参考答案出补丁)', async () => {
    const FIXED_PY = await readFile(join(import.meta.dirname, 'fixtures', 'repair-fixture', 'wewright', 'commands', 'get-article.fixed.py'), 'utf8')
    const llm = { async diagnose() { return { rootCause: 'logic-bug', reasoning: '参数缺失需结构化返回', patchedFiles: { 'wewright/commands/get-article.py': FIXED_PY } } } }
    const task = buildTask({
      source: 'manual', adapterId: 'demo-fixture',
      failures: [{ tool: 'demo-fixture.get-article', count: 3, lastErr: 'TypeError' }],
      repro: { sample: { keyword: 'hello' } },
    })
    const { outcome, verification } = await runRepairLoop({ task, llm, env, home, runtimePath, log: (m) => console.error(m) })
    expect(outcome).toBe('draft-ready')
    expect(verification.passed).toBe(true)
    expect(verification.checks.find((c) => c.name === 'replay:get-article').passed).toBe(true)
    expect(verification.checks.find((c) => c.name === 'fixture:f1').passed).toBe(true)
  })
})
```

注意:`runRepairLoop` 需要把 `runtimePath` 透传给 verify —— 在 Task 6 的 executor `verifyImpl` 调用签名里加透传:

```js
const verification = await verifyImpl({ task, draftDir: draft.draftDir, baseVersion, env, home, log, runtimePath });
```

(Task 6 实现时直接带上该参数;本用例依赖它。)

fixture 断言需要注册:执行循环加 `fixtures` 透传参数(默认 []),端到端传入:

```js
const fixtures = [{ id: 'f1', commandId: 'get-article', expect: { equals: { ok: true }, patterns: { title: '^article:' }, rowCount: { rows: 2 } } }]
```

(Task 6 的 runRepairLoop 签名加 `fixtures = []`,`verifyImpl` 调用时透传;单测不传即默认空,不影响既有用例。)

- [ ] **Step 3: 跑测**

Run: `cd webcli && npx vitest run __tests__/repair-e2e.test.js`
Expected: 有运行时 → PASS;无运行时 → 整组 skip(0 ran 1 skipped)

- [ ] **Step 4: 提交**

```bash
git add webcli/__tests__/fixtures/repair-fixture webcli/__tests__/repair-e2e.test.js webcli/repair/executor.js
git commit -m "test(repair): 合成故障 fixture 端到端(运行时门控)"
```

---

### Task 8: 分发收敛(adapterhub 更新静默感知)

**Files:**
- Modify: `webcli/adapterhub-cli.js:624`(export collectLocalAdapters)、`:639`(export compareLocalWithHub)
- Create: `webcli/adapterhub-update-check.js`
- Modify: `webcli/index.js:1673`(版本自检块之后接入提示)
- Test: `webcli/__tests__/adapterhub-update-check.test.js`

- [ ] **Step 1: 写失败测试**

```js
// webcli/__tests__/adapterhub-update-check.test.js
import { describe, it, expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readUpdateCache, formatUpdateNotice, checkAdapterUpdates, CHECK_TTL_MS } from '../adapterhub-update-check.js'

describe('formatUpdateNotice', () => {
  it('空 → null;upgrade/install 各出对应命令', () => {
    expect(formatUpdateNotice([])).toBe(null)
    const text = formatUpdateNotice([
      { adapter: 'wekm', local: '1.0.9', hub: '1.1.0', action: 'upgrade' },
      { adapter: 'newone', local: null, hub: '1.0.0', action: 'install' },
    ])
    expect(text).toContain('wekm 1.0.9 → 1.1.0')
    expect(text).toContain('webgo adapterhub upgrade wekm')
    expect(text).toContain('webgo adapterhub install newone')
  })
})

describe('checkAdapterUpdates', () => {
  const ROWS = [{ adapter: 'wekm', local: '1.0.9', hub: '1.1.0', action: 'upgrade' }]
  it('缓存新鲜 → 不回源,直接返回缓存', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'ahc-')), 'c.json')
    const now = Date.now()
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, JSON.stringify({ checkedAt: now - 1000, updates: ROWS }))
    let compared = 0
    const updates = await checkAdapterUpdates({ compareImpl: async () => { compared++; return ROWS }, file, now })
    expect(updates).toEqual(ROWS)
    expect(compared).toBe(0)
  })
  it('缓存过期 → 立即返回旧缓存,后台刷新写新缓存', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'ahc-')), 'c.json')
    const now = Date.now()
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, JSON.stringify({ checkedAt: now - CHECK_TTL_MS - 1, updates: ROWS }))
    const updates = await checkAdapterUpdates({ compareImpl: async () => [{ adapter: 'x', local: '1', hub: '2', action: 'upgrade' }], file, now })
    expect(updates).toEqual(ROWS) // 本次仍用旧缓存
    await new Promise((r) => setTimeout(r, 30))
    expect(readUpdateCache(file).updates[0].adapter).toBe('x') // 后台已刷新
  })
  it('无缓存 → 返回空数组并后台刷新', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'ahc-')), 'c.json')
    const updates = await checkAdapterUpdates({ compareImpl: async () => ROWS, file, now: Date.now() })
    expect(updates).toEqual([])
    await new Promise((r) => setTimeout(r, 30))
    expect(readUpdateCache(file).updates).toEqual(ROWS)
  })
})
```

- [ ] **Step 2: 跑测确认失败**

Run: `cd webcli && npx vitest run __tests__/adapterhub-update-check.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 导出 adapterhub-cli 两个内部函数**

`webcli/adapterhub-cli.js:624`:

```js
export function collectLocalAdapters() {
```

`:639`:

```js
export async function compareLocalWithHub(local) {
```

- [ ] **Step 4: 实现 `webcli/adapterhub-update-check.js`**

```js
/**
 * adapterhub 更新静默感知(仿 version-check):24h TTL 后台刷新,缓存命中即提示。
 * 只提示不自动装;离线/超时完全静默,绝不阻塞命令。
 */
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

export const CHECK_TTL_MS = 24 * 60 * 60 * 1000;

function cacheFile(home = homedir()) {
  return path.join(home, ".webcli", "adapterhub-check.json");
}

export function readUpdateCache(file = cacheFile()) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data && Array.isArray(data.updates) ? data : null;
  } catch { return null; }
}

function writeUpdateCache(value, file = cacheFile()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  } catch { /* 静默 */ }
}

export function formatUpdateNotice(updates) {
  if (!updates || !updates.length) return null;
  return updates.map((u) => {
    const action = u.action === "install" ? `webgo adapterhub install ${u.adapter}` : `webgo adapterhub upgrade ${u.adapter}`;
    return `[webgo] adapter ${u.adapter} ${u.local ?? "(未装)"} → ${u.hub}——运行 ${action}`;
  }).join("\n");
}

async function defaultCompare() {
  const { collectLocalAdapters, compareLocalWithHub } = await import("./adapterhub-cli.js");
  return compareLocalWithHub(collectLocalAdapters());
}

async function refreshUpdates({ compareImpl, file, now }) {
  try {
    const results = await compareImpl();
    const updates = (results || [])
      .filter((r) => r.action === "upgrade" || r.action === "install")
      .map((r) => ({ adapter: r.adapter, local: r.local ?? null, hub: r.hub, action: r.action }));
    writeUpdateCache({ checkedAt: now, updates }, file);
  } catch { /* 静默 */ }
}

export async function checkAdapterUpdates({ compareImpl = defaultCompare, file = cacheFile(), now = Date.now(), ttl = CHECK_TTL_MS } = {}) {
  const cache = readUpdateCache(file);
  if (cache && now - cache.checkedAt < ttl) return cache.updates;
  refreshUpdates({ compareImpl, file, now }).catch(() => {}); // 后台静默,不 await
  return cache ? cache.updates : [];                          // 本次用旧缓存,下次生效
}
```

- [ ] **Step 5: 接线 index.js**

`webcli/index.js:1673`(版本自检 `} catch { /* 版本检查绝不影响命令 */ }` 块结束后、`if (hasHostConfiguration()...` 之前)插入:

```js
  // ── adapterhub 更新静默感知(只提示不自动装;24h TTL 后台刷新) ───────────
  if (!VERSION_CHECK_EXEMPT.has(process.argv[2])) {
    try {
      const { checkAdapterUpdates, formatUpdateNotice } = await import("./adapterhub-update-check.js");
      const updates = await checkAdapterUpdates({});
      const notice = formatUpdateNotice(updates);
      if (notice) process.stderr.write(notice + "\n");
    } catch { /* 更新感知绝不影响命令 */ }
  }
```

- [ ] **Step 6: 跑测确认通过 + 回归**

Run: `cd webcli && npx vitest run __tests__/adapterhub-update-check.test.js __tests__/repair-executor.test.js`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add webcli/adapterhub-cli.js webcli/adapterhub-update-check.js webcli/__tests__/adapterhub-update-check.test.js webcli/index.js
git commit -m "feat(adapterhub): 更新静默感知(24h TTL 后台刷新,只提示不自动装)"
```

---

### Task 9: 真实验收(wekm,人工主导)

**Files:** 无新代码;产出验收记录 `docs/superpowers/plans/2026-11-23-adapter-self-evolution-acceptance.md`

- [ ] **Step 1: 拉取 wekm 到工作台**

```bash
webgo adapterhub install wekm
webgo adapterhub info wekm --json
```

- [ ] **Step 2: 生成修复任务(真实 errdetail)**

```bash
export METRICS_STATS_TOKEN=<工作台 errdetail 查询令牌>
webgo repair task --from errors --since 7d --min-calls 3
webgo repair list
```

Expected: 列表含 `rt-<date>-wekm`(failures 含 get-article/list-articles,带真实 lastErr)

- [ ] **Step 3: 聊天内执行修复(agent 注入真实 LLM)**

在 WeWorker 对话中调用 `runRepairLoop`(agent 作为 llm 注入),人工观察:
- 诊断结论是否引用经验库/真实报错
- 补丁 diff 是否合理(如缺登录分支 → 需引导登录;字段漂移 → 修正映射)

- [ ] **Step 4: 人工确认后发布**

```bash
# 审阅草稿 diff 与验证记录后
webgo adapterhub publish <draftDir> --yes   # 或按既有 publish 流程打包 .adapt
```

- [ ] **Step 5: 验收标准(全部满足才算通过)**

1. 修复草稿通过四层验证(静态/重放/fixture/冒烟)
2. 原报错命令经 Webwright 实跑 exit 0
3. 经验库出现对应条目(outcome=fixed)
4. 发布后 errdetail 中该 adapter 失败数在后续窗口下降
5. 验收记录归档(诊断、diff 摘要、验证输出、发布版本号)

---

## Self-Review 记录

- **Spec 覆盖**:§14 路径 1→Task 1/2;2→Task 3;3→Task 6;4→Task 4;5→Task 5;6→Task 7;7→Task 9;8→Task 8。§7 RepairTask/状态机→Task 1;§8 循环→Task 6;§9 验证器→Task 4;§10 经验库→Task 5;§12 分发收敛→Task 8。无缺口。
- **占位符扫描**:无 TBD/TODO;Task 7 真实验收为人工步骤,步骤可执行。
- **类型一致性**:`readWewrightTarget(adapterId,{env,home})`、`writeRepairDraftWewright({adapterId,expectedDigest,patchedFiles,env,home,now})`、`verifyRepair({task,draftDir,baseVersion,fixtures,smoke,runtimePath,env,log,replayImpl})`、`runRepairLoop({task,llm,env,home,maxRounds,log,now,save,verifyImpl,fixtures,runtimePath})` 各 Task 间签名一致;Task 6/7 的 `fixtures`/`runtimePath` 透传已在两处注明。
