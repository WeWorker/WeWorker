# 巡检执行器 · 客户端集成实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** 巡检内核接入桌面端定时任务体系——每日自动巡检、结果落库 patrol_runs、通知到桌面(含 HTML 报告路径)、聊天可手动触发。

**Architecture:** 复用既有 scheduler/task-executor/works-store/notifier 四件套,新增 `kind='adapter-patrol'` 任务类型与 `adapter-patrol.ts` 执行封装(spawn 巡检内核 CLI)。巡检报告经 `tasksFromPatrolReport`(已实现)转 RepairTask 接修复管线。

**Tech Stack:** backend-ts TypeScript、node:sqlite(works-store)、node-cron(既有)、vitest(vitest.config.ts 已含 backend-ts 测试)。

**设计依据:** docs/superpowers/specs/2026-10-10-adapter-daily-patrol-design.md(架构表);内核已交付(webcli/patrol/ 八模块);客户端同步任务创建入口(聊天)与执行分派(task-executor)为既有能力,复用。

---

## 前置事实(实现者必读)

- `ScheduledTask` 接口在 `works-store.ts:69`;`scheduled_tasks` 表 CREATE 有**两处**(:141 新库模板、:996 迁移/兼容路径)——kind 列两处都要加,且 SELECT 列清单与行映射函数同步
- `executeTask(task)` 在 `task-executor.ts:200`;**空 prompt 校验在 :206**——patrol 任务无 prompt_template,kind 分派必须放在该校验**之前**
- 通知:task-executor.ts 的 `safeNotify(payload, task.notify_channels)` → notifier.ts `notify()`(SSE 系统通知 + 通道);payload 形状 {taskId, taskTitle, status, summary, fullText, error, executionId, workId}
- 巡检内核:`webcli/patrol/index.js`(ESM,`--json --html --timeout N`),报告 JSON={runId, coverage{sites,tools}, passed, failed, uncovered[], results[], reEvidence[], newlyFailed[], recovered[]},HTML 落 `~/.webcli/patrol/reports/<runId>.html`
- 内核定位:打包后 `resources/webcli/patrol/index.js`;开发态 repo `webcli/patrol/index.js`——backend-ts 侧用 `app.getWebcliPatrolEntry()` 或资源路径解析(实现时以 backend-ts 既有资源路径 helper 为准,如WEWORKER_RESOURCES_PATH)
- `tasksFromPatrolReport(report)` 在 `webcli/repair/task-source.js`(已导出,消费原生报告形状,产出 buildTask 契约 RepairTask[])
- repair 管线侧 `saveTask` 落 `~/.webcli/repair-tasks/`;巡检任务转 RepairTask 后沿用同日去重守卫

---

## Task 1: works-store — kind 列 + patrol_runs 表 + 存取

**Files:**
- Modify: `weworker/backend-ts/src/works-store.ts`
- Test: 既有 works-store 测试文件追加(定位:`ls weworker/backend-ts/src/__tests__/ | grep -i works`)

**Steps:**
1. 测试先行:kind 缺省为 'prompt'(旧任务读取不炸);保存 kind='adapter-patrol' 的任务可读回;savePatrolRun/listPatrolRuns 落盘读回;任务执行失败也记录
2. 实现:
   - `ScheduledTask` 接口加 `kind?: 'prompt' | 'adapter-patrol'`
   - 两处 scheduled_tasks CREATE 模板加 `kind TEXT NOT NULL DEFAULT 'prompt'`;SELECT 列清单与行映射同步
   - 新表:
     ```sql
     CREATE TABLE IF NOT EXISTS patrol_runs (
       id TEXT PRIMARY KEY,
       task_id TEXT NOT NULL,
       run_id TEXT NOT NULL,
       started_at TEXT NOT NULL,
       finished_at TEXT,
       status TEXT NOT NULL DEFAULT 'running',
       report_json TEXT,
       html_path TEXT,
       pass INTEGER DEFAULT 0,
       failed INTEGER DEFAULT 0,
       uncovered INTEGER DEFAULT 0,
       error_message TEXT
     );
     ```
   - 新函数:`savePatrolRun(run)`,`listPatrolRuns(taskId)`(时间倒序,上限 100),`updatePatrolRun(id, patch)`
3. 跑测确认通过 + 既有 works-store 测试无回归
4. 提交 `feat(backend): 定时任务 kind 列与 patrol_runs 存储`

---

## Task 2: adapter-patrol.ts — 内核 spawn 封装

**Files:**
- Create: `weworker/backend-ts/src/adapter-patrol.ts`
- Test: `weworker/backend-ts/src/__tests__/adapter-patrol.test.ts`

**实现:**

```ts
export interface PatrolRunResult {
  runId: string
  report: PatrolReport        // 与内核 JSON 同构(coverage/passed/failed/uncovered/results/reEvidence/...)
  htmlPath: string | null
  durationMs: number
}

export async function runAdapterPatrol(opts: {
  kernelEntry: string          // patrol/index.js 绝对路径(调用方按环境解析)
  timeoutMin?: number          // 整轮看门狗,默认 60
  extraArgs?: string[]         // 如 ['--only', 'a.com']
  env?: Record<string, string>
  cwd?: string
  spawnImpl?: typeof spawn
}): Promise<PatrolRunResult>
```

- spawn `node <kernelEntry> --json --html [--only ...] --timeout 30`,cwd=内核目录,timeoutMs=看门狗(`AbortSignal.timeout` + kill),超时返回 status='failed' error='巡检超时'
- stdout 收集完整 JSON(parse 前 trim);stderr 收集尾部 2000 字节(诊断)
- 内核定位 helper:`resolvePatrolKernelEntry({ resourcesPath })`——打包后 `join(resourcesPath, 'webcli', 'patrol', 'index.js')`;开发态回退 repo `webcli/patrol/index.js`(existsSync 探测顺序,与 host-cli 资源解析同模式)
- 测试:注入 spawnImpl(假子进程:输出 JSON 报告/超时/非零退出三用例);resolvePatrolKernelEntry 的 existsSync 探测顺序用 tmp 目录桩

- [ ] TDD 四用例 → 实现 → 提交 `feat(backend): 巡检内核 spawn 封装(看门狗/资源定位)`

---

## Task 3: task-executor kind 分派 + patrol_runs 落库 + 通知

**Files:**
- Modify: `weworker/backend-ts/src/task-executor.ts`
- Test: 既有 task-executor 测试文件追加

**实现:**

1. executeTask 入口(空 prompt 校验**之前**)加:

```ts
  if (task.kind === 'adapter-patrol') {
    return executeAdapterPatrolTask(task, taskProject.id, taskWorkspace)
  }
```

2. 新增 `executeAdapterPatrolTask(task, projectId, workspace)`:
   - createWork(`[巡检] ${task.title} · 运行中`)+ createTaskExecution
   - kernelEntry = resolvePatrolKernelEntry(资源解析)
   - `runAdapterPatrol({ kernelEntry, timeoutMin: 60 })`
   - 成功:savePatrolRun({report}) → updateTaskExecution completed → safeNotify(summary=`覆盖率 ${sites} 站 ${tools} 命令;通过 X 失败 Y 未覆盖 Z;需重新取证 N 条`, fullText=文本报告, htmlPath 进 payload 扩展字段)
   - 失败/超时:updateTaskExecution failed + safeNotify(status failed)
   - 全程 try/catch,失败也要落 patrol_runs(status failed + error)
3. NotificationPayload 扩展可选 `htmlPath?: string`(notifier 侧透传,前端可给「打开报告」入口)
4. 通知阈值:summary 按实际状态;v1 每次巡检都通知(报告本身就是交付物)

- [ ] 测试:假 spawnImpl 的 patrol 全链路(成功→patrol_runs 落行+通知 payload 断言;超时→failed 通知);既有 executeTask 用例无回归
- [ ] 提交 `feat(backend): task-executor 接入 adapter-patrol 任务类型(落库+通知)`

---

## Task 4: 聊天创建巡检任务入口(轻量)

聊天里说「帮我加个每天巡检 XX 的任务」→ agent 建ScheduledTask(kind='adapter-patrol', cron 自选)。**agent 侧工具面本期不做**——先用既有定时任务创建流(用户在设置里建任务,kind 手选或默认)。
- [ ] 确认既有定时任务创建 UI/API 对未知 kind 的容忍(默认 prompt 不覆盖)——若 UI 强依赖 prompt_template,给 adapter-patrol 任务置 prompt_template='[巡检任务]' 占位
- [ ] 验收:建任务 → scheduler 触发 → 通知到达 → patrol_runs 有记录

---

## 完成标准

1. 设置里可建 kind='adapter-patrol' 的每日任务;到点自动执行
2. patrol_runs 有记录;通知到桌面(summary+HTML 路径)
3. 既有 prompt 任务零回归
4. 巡检 spawn 失败/超时有 failed 记录与通知

## 已知边界

- 巡检质量依赖工作台浏览器登录态(站点未登录 → uncovered,如实)
- HTML 报告在桌面端的通知点击打开:本期以路径形式给出,前端「打开报告」按钮后续迭代
