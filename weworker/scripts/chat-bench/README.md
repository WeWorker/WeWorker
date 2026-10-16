# WeWorker chat-bench

对话自动化测试 + 埋点采集 harness。**零侵入**：不改后端/前端，通过 HTTP+SSE 驱动真实的 `/works/:id/chat` 链路（含 支持工单示例 短路、webcli、MCP、Claude Agent SDK），采集每用例的 timing / token / cache / 每步明细，输出 **JSONL 逐事件明细 + Markdown 汇总报告**。

解决什么：手动在 UI 一条条点、埋点散落在 SSE 与 `works.db` 中、无法批量回归对比各场景耗时与 token 表现。

## 前置

1. 已在 WeWorker 应用内配置好 provider（`~/.weworker/settings.json` 有 api_key）。
2. `backend-ts` 目录已 `npm install`（self 模式会用其 `tsx` 与 Agent SDK）。
3. Node 18+（用内置 `fetch`）。

## 快速开始

```bash
cd weworker

# 1) 单个问答用例（self 模式：自动起独立 dev 后端，跑完自动清理）
node scripts/chat-bench/bench.mjs \
  --cases scripts/chat-bench/examples/qa.json \
  --no-test-prompts --out ./bench-out

# 2) 跑某站点内置测试词（来自 GET /health-check/test-prompts）
node scripts/chat-bench/bench.mjs --prompts --sites itsm.example.com

# 3) 驱动正在运行的客户端（remote）
node scripts/chat-bench/bench.mjs \
  --target remote --base http://127.0.0.1:8765 --token <X-WeWorker-Auth> \
  --cases scripts/chat-bench/examples/qa.json --no-test-prompts
```

## 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--target self\|remote` | `self` | self 自动起独立 dev 后端；remote 指向已运行客户端 |
| `--base <url>` | `http://127.0.0.1:8765` | 后端地址 |
| `--token <auth>` | 空 | `X-WeWorker-Auth`，remote 必填；self 留空（后端放行） |
| `--cases <file>` | 无 | 自定义用例（`.json` 数组 或 `.csv`） |
| `--router-cases [doc]` | 无 | 跑路由用例清单（默认 `docs/router-config-manual-testcases.md`），每条给出「是否命中路由 / 耗时 / 实际回答」 |
| `--sites <a,b>` | 无 | 仅跑这些 site 的 test-prompts |
| `--only <a,b>` | 无 | 只跑 id 含这些子串的用例（如 `--only router-pos-1,router-neg-88`） |
| `--prompts` | 否 | 仅跑 test-prompts，忽略自定义 |
| `--no-test-prompts` | 否 | 不拉 test-prompts，仅自定义用例 |
| `--concurrency <n>` | `1` | 并发 work 数 |
| `--timeout <ms>` | `180000` | 单用例 SSE 超时 |
| `--out <dir>` | `./bench-out` | 输出目录 |
| `--cleanup / --no-cleanup` | self 开 / remote 关 | 是否删除本次创建的 work |
| `--skip-preflight` | 否 | 跳过 provider 预检 |

## 自定义用例

JSON 数组：

```json
[
  { "id": "qa-1", "prompt": "你好" },
  { "id": "itsm-todo", "prompt": "查看我的待办工单", "siteId": "itsm.example.com",
    "expectTools": ["itsm.example.com.my_todo"], "expectMaxMs": 15000 }
]
```

CSV（首行表头，`expectTools` 用 `;` 分隔）：

```csv
id,prompt,siteId,category,expectTools,expectMaxMs
qa-1,你好,,,,
itsm-todo,查看我的待办工单,itsm.example.com,itsm,itsm.example.com.my_todo,15000
```

字段：`id`(可选) / `prompt`(必填) / `siteId` / `category` / `expectTools`(数组或`;`分隔) / `expectMaxMs` / `expectRoute`。声明了才会在报告「断言」列显示 ✓/✗。

`expectRoute: true` 表示这条**应当命中路由层**，`false` 表示应当落回 LLM。判据是后端 SSE 里 `turn_end` 有没有带 `routeTool` 自描述字段（`api-query-router/index.ts` 的 `emitRoutedAnswer` 才会带），不用猜。

## 路由回归：一条命令跑完整清单

`--router-cases` 直接读 `docs/router-config-manual-testcases.md`——**与 `npm run route:replay` 同一份来源**，所以「引擎级判定」与「端到端表现」永远跑同一批句子，不会两张皮。

```bash
cd weworker
node scripts/chat-bench/bench.mjs --router-cases --no-test-prompts --out ./bench-out
# 先试几条（负例会真的调模型，挑着跑）
node scripts/chat-bench/bench.mjs --router-cases --no-test-prompts --only router-pos-1,router-pos-2
```

报告里每条给出：**是否命中路由**（命中的话是哪一层 `routeSource`、哪个工具）｜ **耗时**（totalMs / llmMs / execMs）｜ **结果分类**｜ **实际回答原文**（`summary.md` 的「每个回答的实际结果」一节给原文，完整文本在 `cases.json` 的 `answer`），并额外汇总「走路由 N 条 vs 落回 LLM M 条、平均各多少毫秒、每条省多少」。

「结果分类」是刻意单列出来的一列，判据直接对渲染器模板（`api-query-router/generic-renderer.ts`）：

| 结果 | 含义 | 首行标记 |
|---|---|---|
| 数据 | 正常拿到数据（表格/文本） | — |
| 报错 | 工具调用失败，用户只看到失败提示 | `⚠️ 查询失败：` |
| 空结果 | 工具成功但没数据 | `⚠️ 查询返回为空。` |
| 落盘指针 | 结果太大已落盘，正文只给指针 | `⚠️ 结果过大已落盘` |
| 无输出 | 没有任何文本（超时/中断） | — |

**命中 ≠ 拿到数据**：单跳命中（`routes` / `aliases` / `shortcuts` / `patterns`）`onFailure: stop`，工具报错时**不回落 LLM**，用户拿到的就是那句失败提示——所以汇总里单独给出「命中且拿到数据 / 命中但没拿到数据」两行与具体 id 清单，避免被 ✓route 掩盖。典型触发原因是目标站点在这台机器上不可达（先用 `npm run route:replay --live --only <n>` 或直接 `curl` 复核，别当成路由 bug）。

两层工具的分工：

| 工具 | 层次 | 回答什么 | 代价 |
|---|---|---|---|
| `npm run route:replay` | 引擎级（不碰网络） | 命中第几层、哪个工具、参数对不对、渲染是什么 | 秒级，零 token |
| `bench.mjs --router-cases` | 端到端（真实 HTTP+SSE） | 用户**实际拿到什么回答**、整轮多少秒、有没有走路由 | 每条一次真实对话 |

## 输出

```
bench-out/<运行时间戳>/
  summary.md        # 分析报告：总览 + 用例对比表（按 totalMs 降序）+ 路由命中汇总 + 每个回答的实际结果（原文）+ 异常 + 按 site 汇总
  results.md        # 逐条结果速查台账：正/负例分开、id 升序一行一条（是否命中路由 / 结果 / 耗时 / 回答首行）+ 最慢 10 条
  cases.json        # 全量机读结果（含 answer 原文 / resultKind / steps / timing / usage / healthCheck）
  cases/<id>.jsonl  # 每用例逐 SSE 事件（含 think/exec/usage，带相对 ms 偏移）
```

**结论只落在文件里，不在对话里复述**：跑完看 `results.md` 扫「哪条没拿到数据 / 哪条最慢」，要细节再进 `summary.md`。已跑过的运行可只重生成台账（不重跑、不花钱）：

```bash
node scripts/chat-bench/report.mjs --from-cases ./bench-out/<时间戳>
```

## 两种靶子

**self 模式要求 8765 空闲**：它自己起一个后端并校验 `/status` 的 `backend_instance_id` 是不是自己刚起的那个——如果客户端正开着，既认不出自己的进程、又会因端口被占用而起不来，脚本会直接报错让你先关客户端（或改用 `--target remote`）。这是刻意的：打着打着测到了旧进程上，是这个 harness 最容易骗人的失败方式。

- **self（默认）**：用 `npx tsx` 起一份 `backend-ts` dev 后端，不设 token（`http-security.ts` 放行）。复用 `~/.weworker` 配置；`--cleanup` 默认开（删本次 work）。
- **remote**：指向已启动的客户端，请求带 `X-WeWorker-Auth`。token 获取：在客户端渲染进程 devtools 执行 `await window.electronAPI.getHttpAuthToken()`。`--cleanup` 默认关（避免误删真实 work）。

## 采集的埋点（均来自后端既有产出）

| 数据 | SSE 事件 | 后端来源 |
|---|---|---|
| turn 级 timing（totalMs/llmMs/execMs/steps） | `turn_end` | `server.ts` /chat finally |
| step 级 think/exec + 工具名/参数/结果 | `tool_call_start` / `tool_call_result` | `server.ts` /chat 循环 |
| token + cache_hit + cost + duration | `usage` | `agent.ts` result 分支 |

不依赖 `%APPDATA%\WeWorker\logs\main.log`（每次启动覆盖、且与 bridge 日志混合，不可靠）。

## 约束

- 网站/DOM 操作类 prompt 依赖浏览器扩展 bridge；独立后端无扩展时这类会失败（如实记为 error，不影响其他用例）。纯问答、文件、API 类（如 `itsm.example.com.my_todo`）可正常测。
- 目标站点在本机不可达时，走路由的条目会**命中但结果为「报错」**（约 30s 的 curl 超时后才返回，`⚠️ 查询失败：…`）；两跳计划则会在首跳失败后按设计落回 LLM，表现为「未命中(LLM)」且整轮很慢。两者都不是路由缺陷——先 `curl` 复核站点可达性。
- 并发：不同 workId 天然隔离；提高 `--concurrency` 可加速，但注意 provider 限流。

## 与现有功能的关系

- 复用 `GET /health-check/test-prompts`（按站点测试词）作为基准输入源，`POST /health-check/analyze` 做 tool 成败分析。
- 是耗时可视化（Phase A）与录制回放（Phase B，暂缓）之间的测试/基准层；未来录制脚本可直接作为 `--cases` 输入衔接。
