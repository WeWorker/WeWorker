# Adapter 每日巡检执行器设计

日期：2026-10-10
状态：已确认设计，待实现
范围：本文只覆盖「巡检执行器」这一个子项目

## 背景

仓库里已有三块相邻能力，但拼不出"常态化知道 adapter 还好不好用"这条线：

- `webcli/scripts/run-real-e2e.js`：真实调用跑测，带 `safety` / `safetyMode` 安全跑法与历史基线回放，但**由人显式触发**，且结果散落在 `e2e-results/*.jsonl`
- `weworker/backend-ts/src/scheduler.ts` + `task-executor.ts`：cron 定时任务 + 通知渠道，但 `task-executor` 目前只会把 `prompt_template` 当用户消息跑一遍 agent
- `webcli/generation-harness/` + `adapter-scaffold.js`：探索 → 取证 → 生成 → 校验 → 人工审批 → 发布的完整链路，但**只能显式触发**，没有任何东西告诉它"该重新生成了"

于是"网站静默改版"这类问题无人发现：接口仍返回 200，字段却改名、变空、类型变了。证据里的 `replayStatus` / `replayRequired` 是"该重验"的信号，但没人自动触发，也没有时间维度的过期概念。

本子项目的目标：**把"每条命令是否仍然有效"做成每日自动、判定确定、可与基线对比的巡检**，产出报告与「需重新取证」清单，交给后续的自愈子项目消费。

### 探查结论（避免后续误判可复用性）

- `webcli/api-adapter-certification.js`、`api-adapter-certification-matrix.js`、`api-adapter-test-evidence.js`、`scripts/run-api-adapter-live-reads.js` **在仓库中都不存在**，不要按这些名字去找或假设可复用
- 真正存在的对应物：`weworker/backend-ts/src/api-exploration-evidence.ts`（`verificationFixture` 定义在此）、`webcli/generation-harness/source-evidence.js`（接口指纹与风险分级）、`webcli/generation-harness/runtime-test-policy.js`（能否安全跑测的门控）
- 已知技术债：读写风险分级的正则**重复了 4-5 份**（`source-evidence.js` / `runtime-test-policy.js` / `adapter-generation-workflow.js` / `api-exploration-evidence.ts` / `api-candidate-replay.ts`）。本设计**不新增第 6 份**：巡检需要的安全判定一律通过调用既有门控得到，不自己写正则

### 与既有设计的关系

`docs/superpowers/specs/2026-07-21-generated-adapter-lifecycle-design.md` 定义了 adapter 的目录归属与文件所有权（程序发布目录 vs 用户级数据目录；机器生成层 vs 人工维护层）。本设计的**基线文件遵循同一套归属规则**：随包发布的 adapter 的基线入仓，用户自己生成的 adapter 的基线落在用户级目录。不新造第二套位置概念。

## 目标

1. 每日自动巡检：枚举已装 adapter 的全部工具，逐条判断"是否仍然有效"
2. 判定分层且确定：连通 → 结构 → 内容，三层分别出结论
3. 与基线对比，把"结构退化"具体到字段（哪个字段缺了 / 类型变了）
4. 失效自动归类，其中「疑似站点变化」进「需重新取证」清单，供后续自愈子项目消费
5. 默认只读、不产生真实写操作；登录态失效的站点整站跳过且不计失败
6. 结果落库并通知，客户端可看历史
7. 提供"立即跑一次"入口

## 非目标

- **不自动修改 adapter 代码**。自愈（重新取证 → 重新生成 → 重跑直到通过）是下一个子项目，本设计只产出它需要的清单
- **不做根因分析**。只报 diff 与归类，判断留给人
- **不替代 `test:e2e:real`**。那是人工/CI 用的完整跑测；巡检是它的"常态化、只读、带基线"形态，复用其样本与 `safetyMode`
- 不做跨机器结果聚合（本机跑本机看；要汇总后续接 `metrics-server`）

## 关键约束

1. **必须在装了客户端、且有可用登录态的机器上跑**。真实调用依赖 Chrome + 扩展 + Bridge，无头环境做不了。这是选择"挂在客户端 scheduler"而非 CI 的根本原因。
2. **写操作不能真跑**。只跑样本里带安全模式的写命令；没有安全样本的一律跳过。
3. **判定必须是确定性代码**。要对基线做精确 diff，不能交给 LLM 判断——这也是排除"写个 prompt 让 agent 自己跑"方案的原因。
4. **并发要克制**。同一 adapter 串行，跨 adapter 并发默认 4，避免打爆站点与 Bridge。

## 架构

| 模块 | 职责 |
|---|---|
| `webcli/patrol/enumerate.js` | 枚举巡检清单：已装 adapter × 全部工具 → `[{adapterId, tool, sample?, hasBaseline}]`；样本按 `publicName` 从 `e2e-cases/*.json` 匹配 |
| `webcli/patrol/probe.js` | 执行单条：spawn `webcli call <tool> … -v`，拿 `{exitCode, stdout, stderr, durationMs, traceId}`；并发池 + 单条超时 |
| `webcli/patrol/classify.js` | 三层判定 + 失效归类（纯函数） |
| `webcli/patrol/shape.js` | shape 提取与 diff（纯函数） |
| `webcli/patrol/baseline.js` | 基线读写、首跑自建、`--update-baseline` 变更预览 |
| `webcli/patrol/report.js` | 汇总报告（文本 + JSON）、「需重新取证」清单、与上次运行对比 |
| `webcli/patrol/index.js` | 编排 + CLI 入口 |
| `weworker/backend-ts/src/adapter-patrol.ts` | 客户端侧：spawn 内核、读回 JSON 报告、落库、通知 |
| `weworker/backend-ts/src/task-executor.ts` | 新增按 `kind` 分派的执行分支（`prompt` 走原逻辑，`adapter-patrol` 走专用 handler） |
| `weworker/backend-ts/src/works-store.ts` | `scheduled_tasks` 加 `kind` 列（默认 `prompt`）；新增 `patrol_runs` 表 |

## 数据流

```text
每日 cron（默认 09:07，可配）
  → scheduler 触发 task（kind = adapter-patrol）
  → task-executor 走专用 handler
  → spawn: node webcli/patrol/index.js --json
       ├ 枚举清单（adapter × tool）
       ├ 取样本（e2e-cases 匹配；无样本标 needs-sample）
       ├ 按站点探登录态（失效站点整站标 skipped-login）
       ├ 并发执行（默认 4，同 adapter 串行；写操作按既有门控过滤）
       ├ 三层判定 → 基线 diff → 归类
       ├ 落 ~/.webcli/patrol/runs/<stamp>.jsonl
       └ 输出 JSON 报告到 stdout
  → 客户端读报告 → 写 patrol_runs → 通知（失败摘要 + 需重新取证清单）
```

## 判定规则

判定自上而下，**上一层不通过就不再往下判**：

**第一层 · 连通**
- 退出码 0 且输出不含登录/权限/超时特征 → 通过
- 否则归类：`login_required` / `permission_denied` / `timeout` / `error`

**第二层 · 结构**
- 把返回 JSON 提取为 shape：字段路径 → 类型（数组取首元素形状，空数组记 `unknown[]`）
- 与基线比：**缺失字段、类型变化 = 退化**；**新增字段 = drift 信号**（不算失败，但记录并在报告中列出）
- 无基线的命令：只判连通，标 `needs-baseline`。**首跑不算这种情况**——首跑会为所有能成功执行且有样本的命令自建基线；`needs-baseline` 只出现在"有样本、但首跑也没跑成功（连通失败）因而建不出基线，之后仍未建成"的命令上

**第三层 · 内容**
- 基线中标记 `requiredNonEmpty` 的路径必须持续非空；列表不得归零
- 内容退化单独记一类（`content_degraded`），与结构退化区分——前者可能是数据波动，后者大概率是站点改版

**归类产出**

| 现象 | 归类 | 去向 |
|---|---|---|
| 登录态相关报错 | `login_required` | 该站整站转**未覆盖**（见下节），不算失败、但**必须告警** |
| 权限相关报错 | `permission_denied` | 报告 + 提示检查账号权限 |
| 结构退化（缺字段/类型变化） | `site_changed` | **进「需重新取证」清单** |
| 内容退化（应为非空却空了） | `content_degraded` | 报告；**连续 2 次运行**（当天 + 次日）都退化才升级进「需重新取证」清单，单次波动不升级 |
| 参数类报错（缺参/参数无效） | `param_error` | 报告 + 提示样本过期 |
| 其余 | `unknown` | 报告 |

## 登录保障与「未覆盖」语义

**这是本设计最容易出错的地方**：把"没跑到"当成"没问题"，巡检会给出虚假的安全感。因此：

### 报告分三类，未覆盖绝不混进"通过"

| 类别 | 含义 | 报告位置 |
|---|---|---|
| **已覆盖 · 通过** | 真的调通了，且结构与内容都对 | 才算通过 |
| **已覆盖 · 失败** | 调通了但退化/报错 | 失败 + 归类 |
| **未覆盖** | 登录失效 / 无账号 / 无样本 / 写操作无安全样本 / 无基线 | **单独一块并标注原因** |

- **覆盖率是报告的头号指标**（如 `覆盖 12/35 站 · 43/210 条命令`），排在通过率之前
- **连续 3 天未覆盖的站点单独告警**——它意味着巡检在那站形同虚设
- 未覆盖**不计入失败**（不冤枉 adapter），但也**绝不计入通过**

### 巡检只依赖 `ensureLogin(adapterId)` 接口，自己不管账号

巡检在跑某站之前调用一次：

```js
const login = await ensureLogin(adapterId)
// → { ok: true, source: 'session' | 'account' }
//  | { ok: false, reason: 'no-account' | 'login-failed' | 'login-blocked' }
```

- **本子项目（1）**：只定义接口与降级——`ok: false` → 该站全部命令标**未覆盖**（记 `reason`）并参与覆盖率统计；**不静默通过**
- **子项目 2**：实现接口——按站点维护多套账密账号，自动登录复用既有 `passport.weoa.com.login_with_password` / `check_login_status`，登录态落 `session-store`
- 接口在子项目 2 落地前，默认实现是"查 `session-store` + 探一次 `check_login_status`"，能力不足时如实返回 `no-account`

### 登录态健康本身也算巡检项

每日额外产出一条「各站登录态可用性」检查结果，与命令巡检并列出现在报告与通知里——登录态批量过期应当**先于**命令失败被发现。

## 安全与噪声控制

- **写操作默认不执行**：只跑样本里 `safetyMode` 属于安全集合（`dry-run` / `confirmation-guard` / `nonexistent-resource` / `schema-guard` / `safe-negative` / `mutating-noop`）的写命令；其余写命令跳过并标 `needs-sample`
- **安全判定复用既有门控**（`generation-harness/runtime-test-policy.js` 与既有 `safetyMode` 语义），不新增风险分级实现
- **登录态**：巡检前按站点探一次；失效站点整站标 `skipped-login`，**不计入失败**（与既有 SKIP 语义一致）
- **并发**：跨 adapter 默认 4，同一 adapter 内串行
- **不污染统计**：子进程强制 `WEBCLI_METRICS=off`，沿用自检工具的做法
- **不做真实写操作是硬约束**：巡检在任何情况下都不得产生业务侧可见的写

## 基线

位置遵循 `2026-07-21` 生命周期设计的归属规则：

- 随包发布的 adapter → 基线入仓，路径 `webcli/patrol/baselines/<adapterId>.json`
- 用户自己生成的 adapter → 基线落在用户级目录 `<configDir>/patrol/baselines/<adapterId>.json`

格式（**只存形状声明与"必须非空"的路径，绝不存具体业务值**）：

```json
{
  "adapterId": "example.com",
  "tools": {
    "example.com.search_items": {
      "source": "verificationFixture | first-run | manual",
      "shape": { "title": "string", "price": "number", "tags": "string[]" },
      "requiredNonEmpty": ["title", "price"],
      "sampleSource": "e2e-cases/new-commands.json#example-search",
      "updatedAt": "2026-10-10",
      "updatedBy": "<提交者>"
    }
  }
}
```

- **来源优先级**：`verificationFixture`（已有取证）> 首跑自建（`source: first-run`）
- 默认巡检**只读基线**；`--update-baseline` 是显式开关，且**先打印将要变更的条目**再写
- 基线变更走 PR 评审——adapter 的期望契约变化应当被人看见

## 报告与落库

**文本报告**（人读）：**覆盖率**（`覆盖 N/35 站 · M/210 条命令`）→ 已覆盖通过/失败 → **未覆盖清单（按原因分组）** → 失效分类计数 → 结构 drift 明细（逐字段）→ 「需重新取证」清单 → 登录态可用性一览

**JSON 报告**（机器读）：`{ runId, startedAt, finishedAt, coverage: { sites: 'N/M', tools: 'M/T' }, passed, failed, uncovered: [{ adapterId, tool, reason }], results[], reEvidence[], drift[], loginHealth[] }`，客户端消费

**落盘**：
- `~/.webcli/patrol/runs/<stamp>.jsonl`：逐条原始结果
- `~/.webcli/patrol/latest.json`：最新报告（客户端读它）
- 与上次对比：新增失败 / 已恢复（保留上一份报告即可，不引入历史数据库）

**客户端落库**：新表 `patrol_runs`（`run_id`, `started_at`, `finished_at`, `total`, `failed`, `skipped`, `summary_json`）

**通知**：把摘要（失败数 + 「需重新取证」前几条）发到该定时任务的 `notify_channels`，复用 `notifier.ts`

## 客户端集成

- `scheduled_tasks` 增加 `kind` 列，默认 `prompt`；既有任务不受影响
- `task-executor` 按 `kind` 分派：`prompt` 走现有 agent 逻辑，`adapter-patrol` 走专用 handler（spawn 内核 → 读报告 → 落库 → 通知）
- 提供「立即跑一次」入口：客户端上一个操作触发同一 handler；命令行 `node webcli/patrol/index.js` 也能单跑（内核本就独立）
- 默认每天 09:07 一次，cron 可配

## 测试策略

- **纯函数单测**：shape 提取与 diff、三层判定、归类、报告汇总——全部用 fixture 数据，不碰网络
- **集成测试**：起本地 mock adapter（沿用 `webcli/__tests__` 里 `http.createServer` 的先例），跑通「枚举 → 执行 → 判定 → 报告」全链路
- **基线往返测试**：首跑建基线 → 篡改返回形状 → 再跑 → 必须报出**具体是哪个字段**退化
- **安全测试**：断言无安全样本的写命令被跳过、巡检过程不产生写调用
- **客户端侧**：`task-executor` 的 `kind` 分派单测（`adapter-patrol` 走 handler 而非 prompt）

## 风险与边界

| 风险 | 处理 |
|---|---|
| 站点限流/封禁（每天全量打一遍 35 个站点） | 同 adapter 串行 + 跨 adapter 并发 4 + 单条超时；必要时按站点配置跳过 |
| 误报（内容波动被判成失败） | 内容退化与结构退化分开记；内容类需连续多次才升级为「需重新取证」 |
| 基线本身写错，导致长期误报 | 基线变更走 PR 评审；`--update-baseline` 前打印变更预览 |
| 巡检把业务数据写进仓库 | 基线只存形状声明，不存值；报告落用户级目录，不入仓 |
| 登录态失效被当成站点变化 | 整站 skip 且不计失败；只有连通成功但结构变了才归 `site_changed` |
| 与既有风险分级重复实现 | 复用既有门控，不新增实现（已知 4-5 份重复是既有债务，不扩大） |

## 验收标准

1. `node webcli/patrol/index.js --json` 能枚举出全部已装 adapter 的工具，并正确标注有/无样本、有/无基线
2. 本地 mock adapter 上跑通全链路，报告能分别报出 连通失败 / 结构退化 / 内容退化
3. 基线往返测试：篡改返回形状后，报告指出**具体字段**（缺失或类型变化）
4. 写操作默认不执行：无安全样本的写命令被跳过并标 `needs-sample`
5. 登录失效站点整站进**未覆盖**（带 `reason`），不计入失败、但**不计入通过**，且覆盖率统计如实下降；连续 3 天未覆盖触发独立告警
5b. `ensureLogin(adapterId)` 接口存在且被调用：返回 `ok:false` 时该站全部命令标未覆盖，巡检**不静默通过**
6. 巡检过程不产生真实写操作（mock 断言无写调用）
7. 客户端能以 `kind='adapter-patrol'` 注册每日任务并在到点触发；结果落 `patrol_runs` 并发通知
8. 客户端有「立即跑一次」入口，与定时任务走同一 handler
9. 巡检不写 `~/.webcli/metrics.jsonl`
10. 基线变更可通过 `--update-baseline` 显式触发，且会先打印变更预览
11. 现有测试不新增失败
