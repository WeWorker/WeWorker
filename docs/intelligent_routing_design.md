# 智能路由与网站探索agent分层设计

> **本文是实施记录，不是规范。** 现行架构说明见 [`intelligent_routing_architecture.md`](./intelligent_routing_architecture.md)；
> 配置怎么写见 [`../weworker/router-config/README.md`](../weworker/router-config/README.md)。
> 两边冲突时以架构说明为准。
>
> 文中「验证」段落引用的回归测试文件（`*.test.ts`）位于内部回归套件，不在本开源仓库；本仓库只保留被测代码与配置。

状态：设计稿（待实施）。范围：把内部超集中的「智能路由级联 + 网站探索agent（第 3/4 层）」引擎移植到公开基线，**内容与配置完全解耦**，全部路由规则由配置文件承载并支持热重载。

交叉引用：`docs/adapter_api_acceleration_design.md`（T5 确定性短路上位设计）、`docs/task_speed_optimization_design.md`（耗时优化）、`docs/webwright_integration_design.md`（网站探索agent 客户端整合）、`docs/ADAPTERS.md`。

---

## 0. 目标与非目标

**目标**

1. 在 `/chat` 进入 LLM 之前增加一个**统一路由层**：任意用户消息若能由某个只读 API 工具直接回答，则由该层决策出「工具 + 参数」、直调、渲染成 markdown、按既有 SSE 序列推回客户端（`llmMs=0`），不再走大模型。
2. 分层能力、开关、边界**逐层明确**（§2）。
3. 所有路由规则住在**配置文件**里：新增、删除、修改一条路由＝改一行配置，引擎代码不动；改完**及时生效**，不重启后端（§3、§4）。
4. 网站探索agent（第 3/4 层）后端接线一并移植：siteGate 分流 → 未知站点 URL 转交探索任务 → 毕业管线（§5）。

**非目标**

- 不做 HTTP 配置 CRUD API、不做 Renderer 路由管理界面（本批只做「改文件 → 及时生效」）。
- 不移植任何内部业务规则内容（内部域工具名、内部提示词、内部 adapter）。
- 不改 Adapter 生成器，不改 WebCLI 协议，不改 Extension。

**精度红线（贯穿全层）**：漏判免费、误判致命。任何一层不自信一律 `return false` 落回 LLM——落回即今天的行为，损失只有速度；而误判会用错误的答案短路掉模型。

---

## 1. 现状与差距

公开基线当前只有一个**扁平配置路由**：`weworker/backend-ts/src/query-router/configurable-query-route.ts`
（别名全等 / 关键词包含 → 直调 → 通用渲染），配置来源 `weworker/query-routes.public.json`（当前为空），
经 `profile-query-route.ts` 挂在 `server.ts` 的 `POST /works/:id/chat` 之前。

缺口：

| 能力 | 公开基线现状 |
|---|---|
| 第 0 层：manifest 话术/模板确定性匹配 | 无（manifest 已有 `scenarios`/`route_templates` 字段与解析，无编译与引擎） |
| Tier -1：正则/关键词提示词配置 | 无 |
| Tier 0/1：守卫正则 override、`!` 显式别名 | 无 |
| plan：多跳锚点 DAG | 无 |
| 兜底层：词法召回 → 一次性 LLM 分类 | 无（`api-router.md` 提示词已存在） |
| 第 3 层：siteGate 分流与工具清单预注入 | 无 |
| 第 4 层：网站探索agent 即时执行 | 无（`components/webwright`、Electron `webwright-manager`、8766 代理、状态栏均已存在且同源） |
| 评测与埋点 | 无 |

---

## 2. 分层总表（每层支持什么）

生产实际执行顺序如下（自上而下，命中即返回、`llmMs=0`；任一环失败即落回下一层）：

| 序 | 层 | 触发条件 | 数据来源 | 参数抽取 | 渲染 | 急停开关 | **明确不支持** |
|---|---|---|---|---|---|---|---|
| P | **配置路由** | 消息**全等**别名 / **包含**关键词 | `routes.json` | ❌（仅静态 `args`） | 通用 | 常开 | 正则、槽位、多跳、从文本抽参 |
| 1 | **第 0 层形态 A · 单工具** | `/chat` body 携带 `scenario{adapterId, scenarioId, slots}` | `scenario-routes.json`（编译自 manifest）+ 客户端 payload | 槽位 coerce/enum；**重建比对门**（去空白后与模板逐字相等） | 通用 / 声明式覆写 | `WEWORKER_SCENARIO_ROUTE=0` | 文本被编辑（漂移）；v1 产物（无 `slotNames`/`promptTemplates`）；槽位 coerce 失败 |
| 2 | **第 0 层形态 A · 多跳** | 同上 + manifest `route.plan` 卡片 | `plan-terminals.json` 白名单 + `plans.json` DAG | 槽位 | terminal 渲染 | 同上 | terminal 未登记；无对应 plan 定义 |
| 3 | **Tier -2 manifest 模板直达** | 消息 `trim` 后与模板**锚定全等** `^(?:…)$`（区分大小写） | adapter `manifest.route_templates[]` | 枚举槽 `${A\|B\|C}` / 自由槽 `${名}` + `validate` | 通用 | 条目 `enabled:false`；工具被禁用 | 模糊匹配、大小写不敏感、>4 槽、模板 >120 字符、无槽模板、非 directCapable 工具；**`!` 前缀让位显式别名** |
| 4 | **硬门① 讨论态** | 命中「是否正常 / 失败 / 习惯 / …吗」类标记 | 代码正则 | — | — | `!` 前缀豁免 | 只识别枚举出的标记 |
| 5 | **硬门①b 追问态** | 回指词 **且** 最近 3 条 agent 消息内有 fast-path 命中记录 | 代码正则 + 会话历史 | — | — | `!` 前缀豁免 | 历史读库失败即降级为不生效 |
| 6 | **第 0 层形态 B · 话术** | manifest `scenarios[].route` 编译出的锚定正则 | `scenario-routes.json` | 槽位 + `guardNegative` | 通用 / 声明式覆写 | `WEWORKER_SCENARIO_ROUTE=0` | 自由措辞（只认卡片话术 ± 槽位填充）；dispatch 鉴权失败后**不降级**到 Tier -1 |
| 7 | **第 0 层形态三 · 显式不直连** | 卡片声明 `direct:false` | `scenario-routes.json` | — | — | — | 只抑制**宽泛层**（Tier -1 / Tier 2），不抑制 plan / override / alias |
| 8 | **Tier -1 提示词配置** | 正则或关键词命中 **且** confidence ≥ 0.8 | `patterns.json` | `arg_extractors` + `default_args` | 通用 / 声明式覆写 | 条目 `enabled:false` | `semantic` / `hybrid` 模式（未实现，配置里声明会被忽略） |
| 9 | **plan · 锚点 DAG** | 入口正则命中 + 锚点解析链走通 | `plans.json` + `plan-terminals.json` | Anchor Resolver 产出/依赖 | terminal 渲染 | 条目 `enabled:false` | 任一跳歧义 / 未命中 / 鉴权失败 / 用户取消 → 整条落回；候选超过 5 个 → 落回 |
| 10 | **硬门② adapter 关键词门** | Tier 0 命中但消息不含该 adapter 词 | 代码 | — | — | `!` 前缀豁免 | — |
| 11 | **Tier 0/1 · 守卫短路 + `!` 别名** | `!全名 [args]` 显式点名（confidence=1，绕过守卫）/ override 正则命中 | `shortcuts.json` / `aliases.json` | 条目自带 `extract` | 声明式覆写 | 条目 `enabled:false` | 别名只支持 JSON 对象参数或「单个必填字符串」启发式 |
| 12 | **Tier 2 · 词法召回 → LLM 分类** | 词法召回 top-8 且 overlap ≥ 0.08 → 一次 `/v1/messages`（12s、256 tokens） | 设置项 `api_query_llm_route` / `WEWORKER_LLM_ROUTE=1` | 由 LLM 抽取 | 通用 | **默认关** | 多工具、多跳、工具链；LLM 返回的 tool 不在候选内一律判 null（严禁臆造） |
| 13 | **落回 `streamChat`** | 以上全不命中 | — | — | — | — | — |
| 14 | **第 3 层 · siteGate 分流** | 消息命中 adapter 域名 / `gate_aliases` / 已毕业 toolkit skill | adapter manifest + toolkit skill 目录 | — | — | `WEWORKER_SITE_GATE=0` | 多站点同命中一律按 ambiguous 保守处理 |
| 15 | **第 4 层 · 网站探索agent** | siteGate 未命中 **且** 消息含未注册站点 URL | 纯函数判定 | — | 探索任务 `final_response` | `WEWORKER_TIER4=0`、`WEWORKER_TIER4_TIMEOUT_MS`、`WEWORKER_TIER4_ALLOW_WRITES=1` | 无 URL 信号的普通对话；host 已注册（含被禁用站点）；站点判定为已知但未启用 |
| 16 | **毕业管线（第 4 → 3 层）** | 同一 host 第 4 层任务成功 N 次（默认 3） | `CONFIG_DIR/tier4-usage.json` | — | 提示文案 | `WEWORKER_TIER4_GRADUATE_AFTER=0` | — |
| 17 | **page-prep 编排** | 命中工具声明了 `execution.navigate_before` | adapter manifest | — | — | `WEWORKER_PAGE_PREP=0`、`WEWORKER_PAGE_PREP_WAIT_MS`（默认 5000） | 无 URL 的工具零调用；`tools_ready` 信号缺失/超时节用固定等待上限（向后兼容旧 Bridge） |

**顺序上的两条硬约束**（改动时不可交换）：

- 第 0 层（形态 A/B）必须早于 Tier -1：后者是宽泛正则，会遮蔽具体话术卡片（历史上出现过卡片句被提示词层抢走、丢掉模式参数的问题）。
- Tier -2 全等模板放在硬门之前：逐字全等的策划句没有推断成分，再过守卫没有意义；但它**让位** `!` 显式别名。

**两道硬门防的是什么**：硬门①（讨论态）防「谈论系统/任务本身」的消息被当成查询；硬门②（adapter 关键词门）防宽泛的 override 正则吃掉没有指向任何站点的口语。两者对 `!` 显式点名豁免——用户主动点名工具是更高优先级的指令。

---

## 3. 配置文件

### 3.1 目录布局

```
weworker/router-config/          # 随包分发的默认配置（进 git，公开示例）
  manifest.json        # schemaVersion / 启用的层 / 注释
  routes.json          # 层 P：配置路由（沿用既有 QueryRouteConfig 结构，向后兼容）
  aliases.json         # 层 11：! 别名 → 工具（+ 固定参数）
  shortcuts.json       # 层 11：守卫式短路（正/负向正则 + 抽参 + 渲染引用）
  patterns.json        # 层 -1：正则/关键词 + 负向 + 参数抽取器
  plans.json           # 层 9：多跳锚点 DAG（声明式 resolver / terminal）
  renderers.json       # 声明式渲染（列 / 分组 / 状态着色）
  plan-terminals.json  # 层 9：manifest 入口白名单（编译期与测试期校验）
  scenario-routes.json # 层 1/6/7：**编译产物**，勿手改（由 gen:routes 生成，进 git）

~/.weworker/router/              # 用户/运维覆盖层（env WEWORKER_ROUTER_CONFIG_DIR）
  同名文件，按条目 id 合并，用户层优先；文件缺失即使用内置默认
```

- 每个文件都可用目录形式按 adapter 拆分（如 `shortcuts/github.com.json`），同目录 `*.json` 合并。
- 未出现在本目录的层＝空实现，行为与今天完全一致（零配置＝零行为变化）。
- 覆盖层仅做**条目级合并**（同 `id` 覆盖、新 `id` 追加、`enabled:false` 关闭），不做深度合并，避免歧义。

### 3.2 各文件 schema（要点）

`routes.json`（层 P，沿用既有结构）：

```json
{ "routes": [
  { "id": "repo-list", "tool": "example.com.list-repos", "enabled": true,
    "match": { "aliases": ["/repos"], "keywords": ["仓库列表"] },
    "args": { "sort": "updated" },
    "title": "仓库列表", "render": { "type": "generic" } }
] }
```

`aliases.json` / `shortcuts.json`（层 11）：

```json
{ "shortcuts": [
  { "id": "repo-list", "tool": "example.com.list-repos", "enabled": true, "priority": 10,
    "patterns": { "positive": ["仓库列表", "我的仓库"], "negative": ["详情", "\\d{6,}", "创建|新增|删除"] },
    "args": { "sort": "updated" },
    "extract": [{ "from": "message", "regex": "(\\d+)\\s*页", "arg": "page", "type": "integer" }],
    "render": { "type": "schema", "schemaId": "repo-list" } }
] }
```

`patterns.json`（层 -1）：

```json
{ "version": "1.0.0",
  "global": { "case_sensitive": false, "min_confidence_for_match": 0.8 },
  "configs": {
    "example.com.list-repos": {
      "enabled": true, "priority": 10,
      "patterns": [{ "type": "regex", "expression": "(我的|所有)?\\s*仓库(列表|一览)?", "flags": "i", "weight": 1.0,
                     "examples": ["仓库列表", "我的仓库"] }],
      "negative_patterns": ["详情|明细|流转|审批"],
      "arg_extractors": [{ "regex": "第\\s*(\\d+)\\s*页", "arg": "page", "type": "integer" }],
      "default_args": { "sort": "updated" }
    }
  } }
```

`plans.json`（层 9，声明式 DAG）：

```json
{ "plans": [
  { "id": "demo-release-content", "enabled": true, "adapterId": "example.com",
    "entry": { "positive": ["的发布内容"], "negative": ["详情", "创建"] },
    "resolvers": [
      { "produces": "productId", "needs": [], "tool": "example.com.list-products",
        "extract": { "source": "rows", "pick": "name", "equals": "$productName", "value": "id", "onAmbiguous": "ask" } }
    ],
    "terminals": [
      { "key": "release-content", "needs": ["productId"], "tool": "example.com.release-content",
        "args": { "product-id": "$productId" }, "render": { "type": "schema", "schemaId": "release-content" } }
    ] }
] }
```

- `extract.pick`：`name`（按字段等值）/ `latest`（取最新）/ `contains`（包含）。
- `extract.onAmbiguous`：`ask`（走确认门问用户）/ `abort`（直接落回 LLM）。候选超过 5 个一律落回，不问。
- `$anchorId` 引用已解析锚点；任何一跳失败 → 整条 plan 落回。

`renderers.json`（声明式渲染，复用既有 markdown schema 渲染器）：

```json
{ "schemas": {
  "repo-list": { "columns": [
    { "type": "text", "key": "name", "title": "仓库" },
    { "type": "status", "key": "visibility", "title": "可见性" },
    { "type": "date", "key": "updated_at", "title": "更新时间" }
  ], "maxRows": 30 }
} }
```

**渲染能力边界（必须明确）**：声明式渲染支持 `text` / `number` / `date` / `status` / `link` 五类列、列分组、分节、行数截断与「仅显示前 N」尾注。它**不支持**任意脚本、跨行计算、条件分支渲染——需要这些的工具应走通用渲染或落回 LLM，不允许在渲染层写代码。

### 3.3 逐层「增删改」操作手册

| 想做的事 | 改哪里 | 引擎改动 |
|---|---|---|
| 加一条「点名词 → 工具」 | `routes.json` 或 `aliases.json` | 无 |
| 加一条守卫式短路 | `shortcuts.json` 加一条 | 无 |
| 提升某工具召回 | `patterns.json` 该条加 `examples` 或调 `weight` | 无 |
| 给某工具定制表格渲染 | `renderers.json` 加 schema | 无 |
| 加一条多跳 | `plans.json` 加 resolver/terminal，并在 `plan-terminals.json` 登记入口（若从 manifest 进入） | 无 |
| 加一条话术卡片直连 | adapter `manifest.scenarios[].route`，跑编译 | 无 |
| 加一条逐字模板 | adapter `manifest.route_templates[]` | 无 |
| 临时下线某条（可逆） | 该条 `enabled: false` | 无 |
| 彻底退出路由面 | 去掉工具 `directCapable`（退出工具目录） | 无 |
| 急停整条级联 | `WEWORKER_API_QUERY_ROUTE=0` | 无 |

**加一条路由前的自检（编译脚本硬门，规则 ①~⑥）**：① 工具可直调且为只读（写操作不得进路由面）；② `args` 键必须是工具 schema 的子集且必填参数全覆盖；③ 占位符双向闭合；④ 与手写层冲突告警；⑤ 含 `${}` 的话术卡片必须显式声明 `tool` / `plan` / `direct:false` 三者之一（把「装饰性卡片」变成构建错误）；⑥ 同一 adapter 内两条路由的样本句不得互相吃掉。

---

## 4. 热重载语义（「改完及时生效」）

今天有 5 处是**进程级一次性快照**，必须改造：

| 快照 | 现状 | 改造后 |
|---|---|---|
| 配置路由 | 进程内加载一次 | 按文件 mtime 比对重载 |
| `patterns.json` | 加载一次 | 同上 |
| `scenario-routes.json` | 模块旁编译产物，加载一次 | 见下 |
| manifest 模板索引 | 进程级缓存，改 manifest 需重启 | 按 manifest mtime 失效重建 |
| 工具目录（catalog） | 进程级缓存 | 按 adapter 目录 mtime 失效重建 |

**编译产物的热重载**：`scenario-routes.json` 由 adapter manifest 编译而来，只改 manifest 不会自动生效。为此把编译逻辑抽成**共享函数** `compileScenarioRoutes(adaptersDir)`：

- CLI（`npm run gen:routes`）调用它写盘 → 产出进 git 的默认配置，并可 `--check` 作为 CI 硬门；
- 运行时加载器调用它**在内存中重建**，按 manifest 目录 mtime 失效；

两条路径共用同一份编译代码，**不存在双实现漂移**。打包态读不到 adapters 目录时回退到随包分发的 `scenario-routes.json`。

**重载时机**：默认「每次路由决策前按 mtime 惰性检查」（成本是一次 `stat`，远低于一次工具调用）；同时提供 `POST /router/reload` 之外**不额外提供**任何运维接口。解析失败（JSON 语法错、schema 校验失败）时**保留上一份可用配置并记日志**，绝不因配置错误导致路由层整体失效——最坏情况是退化为「不命中」，即落回 LLM。

---

## 5. 网站探索agent（第 3/4 层）

客户端侧已就绪（`components/webwright`、Electron `webwright-manager`、8766 loobpack 代理、设置页状态、`docs/webwright_integration_design.md`）。本批只补后端接线：

- `webwright-client.ts`：8766 最小客户端（健康检查 / 建任务 / 查任务 / 取消 / SSE 事件流）。
- `site-gate.ts`：站点判定（域名子串、拉丁别名词边界、CJK 子串、多站点 ambiguous、禁用视同未命中）。
- `tier4-dispatch.ts`：第 4 层分流与即时执行（未注册站点 URL 提取、只读护栏段、超时取消、事件流中断恢复、用户中止静默取消）。
- `tier4-graduation.ts` + `toolkit-skills.ts`：毕业计数与已毕业站点并入 siteGate。
- `server.ts`：仅在 `POST /works/:id/chat` 增加第 4 层接线块；**不得覆盖**本仓较新的模型配置逻辑。

必须一并带上内部仓库工作区里**尚未提交**的三项修复：事件流连接超时只覆盖建连（避免分钟级 SSE 被 10 秒截断）、任务入口链接的中文污染致 404、worker 启动期停滞（`stdin=DEVNULL`）。

**生命周期验证要求**（项目规范强制）：启动、端口冲突、健康检查、正常停止、异常退出重启、应用退出清理；`8766` 被占用时不得终止、接管或复用未知进程；只清理本次 `webwrightManager` 启动的进程。

---

## 6. 实施阶段与验证

| 阶段 | 内容 | 验证 |
|---|---|---|
| P0 ✅ | 配置加载器 + 校验器 + 空引擎骨架（零配置 ⇒ 行为与今天一致） | 单测 + `tsc --noEmit` + 全量回归零变化 |
| P1 ✅ | 层 P / 0A / 0B / -2 / -1 + 编译脚本适配根 `adapters/` + 路由评测 | 评测 match 模式负例零误判（CI 硬门）；`gen:routes --check` 通过 |
| P2 ✅ | `shortcuts` / `aliases` / `plans` 配置化 + 全层热重载 | 增删改各自单测；改文件不重启即生效；坏配置不导致路由层失效 |
| P3 ✅ | 第 3/4 层 + 毕业 + page-prep | 第 4 层判定矩阵单测 + SSE 帧解析单测 + 生命周期验证 |
| P4 ✅ | 文档 + `ROADMAP.md` + Renderer `/sites` 的 `routable` 徽标 + 输入框别名对齐 | `npm run build` + 语法检查 |

**P0 交付状态（2026-10-14 已完成）**：`weworker/backend-ts/src/router-config/`（`types.ts` 类型 / `validate.ts` 逐层校验与 Adapter 作用域过滤 / `loader.ts` 覆盖层合并与 mtime 热重载 / `index.ts` 出口）＋ `weworker/router-config/` 九个空白配置文件与维护说明；`scripts/bundle-backend-ts.cjs` 复制配置到 `build/backend-ts-dist/router-config/`，`package.json` extraResources 增补 `router-config/**`。P0 阶段**生产代码零引用**，故「零配置 ⇒ 行为与今天一致」由构造保证。验证：`tsc --noEmit` 通过；Backend `npm run test:ci` 756 项通过（2 文件 4 项跳过），含新增 `router-config` 回归 20 项。未执行安装包构建与真实 Adapter 联网验证。

**评测集要求**：每条进入 `shortcuts` / `patterns` / `plans` 的规则必须随附正例集与**对抗性负例集**（「查看问题单 12345 详情」「7 天内到期的工单」「创建一个工单」「我的待办然后发邮件」这类近邻），负例精度必须 100% 才允许合入。

**P1 + P2 交付状态（2026-10-14 已完成）**：`weworker/backend-ts/src/api-query-router/` 落地级联引擎（`cascade.ts` 按文档顺序编排 `route` → `scenario-a` → `scenario-a-plan` → `template` → `scenario` → `pattern` → `plan` → `alias` → `shortcut` → `llm-classify` 十层；`routes-layer.ts` / `manifest-templates.ts` / `patterns.ts` / `shortcuts.ts` / `aliases.ts` / `plan-dag.ts` / `anchor-plan.ts` / `recall.ts` / `gates.ts` / `scenario-routes.ts` / `declarative-renderer.ts` / `generic-renderer.ts` / `tool-catalog.ts` 各自纯函数化，`index.ts` 出口为 `planRouteDecision` / `executeRoutePlan` / `tryIntelligentQueryRoute`）。卡片话术编译器 `scenario-route-compiler.ts` 由 CLI 与运行时**共用同一实现**，`scenario-route-cli.ts` 只做参数与 IO；`weworker/scripts/gen-routes.mjs` 用 esbuild 打包该 CLI 后调用，`package.json` 新增 `gen:routes` / `gen:routes:check`。公开基线编译产物为 **11 条 opt-out**（公开仓库的卡片均为写操作或纯展示，无内部规则，符合「内部规则只存在于内部仓库」）。评测硬门（`route-eval`）以 35 条对抗性负例 + `positiveChecked === routeCount` 断言防「引擎未加载导致的假绿」。P2 的 `shortcuts` / `aliases` / `plans` 三层支持配置增删改、改文件后下次读取即生效（mtime 热重载，无需重启），坏配置只回退该层、整条链路仍降级落回 LLM。验证：`tsc --noEmit` 无输出；`npm run test:ci` → **7 文件 / 148 项通过**（其中 `api-query-router` 5 文件 / 124 项）；`npm run gen:routes:check` → `check ok`。**P1/P2 未改动 `server.ts` 的 `POST /works/:id/chat`**：引擎已可调用但尚未接入真实对话请求，接入属 P3。未执行安装包构建与真实 Adapter 联网验证。

**P3 交付状态（2026-10-14 已完成）**：新增 `weworker/backend-ts/src/webwright-client.ts`（8766 只读客户端：health 30 秒 TTL 含负缓存、任务 CRUD、`readWebwrightSse` 帧解析；地址只取自本模块常量与 `WEWORKER_WEBWRIGHT_URL`，不支持调用方传 URL，满足「Renderer 不得向主进程传入网站探索agent URL」的同向约束）、`site-gate.ts`（第 14 行）、`toolkit-skills.ts`（第 16 行识别侧）、`tier4-dispatch.ts`（第 15 行判定与事件流映射）、`tier4-graduation.ts`（第 16 行计数与提示）、`api-query-router/page-prep.ts`（第 17 行）。接线落点为 `server.ts`（`streamChat` 前的 siteGate／toolkit 候选与第 4 层转交、回合末毕业计数）、`agent.ts`（`siteToolkitPrompt` 经 `skillContextPrefix` 进入 `buildContextAssembly`）、`adapter-parser.ts`（`gateAliases`、`navigate_before`）、`tool-catalog.ts`（`navigateBefore`）、`webcli/adapter-desktop.d.ts`（`gate_aliases`）。八个新急停开关全部缺省保持既有行为；`page-prep` 只对声明了 `navigate_before` 的工具生效，其余工具零行为变化。同时补齐内部仓库工作区未提交的三项修复（SSE 建连超时只覆盖响应头、任务入口链接单独成行、worker `stdin=DEVNULL`）。验证：`tsc --noEmit` 无输出；Backend `npm run test:ci` → **105 文件 / 1003 项通过**（2 文件 / 4 项跳过），本批新增 6 文件 / 120 项；harness `uv run python -m pytest tests/unit` → 268 通过 / 3 跳过 / 1 项**既有环境性失败**（`test_local_cdp.py::test_default_user_data_dir_uses_webwright_home_on_windows` 在 Windows 上把 `Path("/tmp/...")` 当绝对路径，本批未改动该文件）；生命周期部分**未改动任何生命周期逻辑**，只新增只读 HTTP 客户端，且已核对「服务器以 `--exit-on-stdin-close` 拉起／正常停止关 stdin」与「worker `stdin=DEVNULL`」属不同进程层、worker 从不接收该参数，故既有停止、端口冲突与重启用例语义不变（`npm run test:webwright-integration` 23 项通过）。未执行安装包构建、桌面端构建与真实站点联网验收。

**P4 交付状态（2026-10-14 已完成）**：把「配置改完是否生效」做成可观测的只读出口，并让输入框别名与后端同源。新增 `weworker/backend-ts/src/router-config/routable.ts`（`computeRoutableSites`：站点可路由 ⇔ 已启用且其名下工具被至少一条**启用**条目引用；按最长前缀把工具归到 Adapter，覆盖 `routes` / `aliases` / `shortcuts` / `patterns.configs` / `plans`（resolver+terminal）/ `scenario-routes` 六类来源，跳过 `enabled:false`、`optout`／`direct:false` 与作用域外条目；空集/坏配置一律返回空报告而不抛）与 `computeRoutableSitesFromConfig`（`index.ts` 出口，读已按启用 Adapter 作用域过滤的配置束）。`server.ts`：`GET /sites` 每项追加 `routable` 与 `routeEntryCount`；新增 `GET /router/aliases`（复用既有 `listAliasTexts`，异常返回空数组而非 500，输入框据此回退随包清单）。Renderer：站点列表行加「路由直达」徽标（title 显示命中条数）、网格视图加角标；`store/sites.js` 在 `load()` 里并行拉 `/router/aliases`（失败即空数组），`InputBar.jsx` 的 `!` 命令识别从手维护静态清单改为读后端生效别名（静态清单降为兜底），并把配置别名一并列进 `!` 补全菜单。验证：`tsc --noEmit` 无输出；Backend `npm run test:ci` → **107 文件 / 1022 项通过**（2 文件 / 4 项跳过），本批新增 2 文件 / 19 项（`router-routable` 15、`router-aliases-endpoint` 4）；Renderer `npm run build` → 3439 模块 / 2.00s 通过，`node --test "src/__tests__/*.test.js"` → **248 项 / 24 套通过**（含新增 `sites-routable-badge` 回归 2 项与重写的 `router-bang-command` 3 项）。文档：`EXTENSION_DEV_GUIDE.md` §8.8 增补「可选 —— 智能路由字段」表（`scenarios[].route` 三形态、`route_templates` 枚举槽/自由槽、`gate_aliases`、`tool_execution` 是按工具名索引的**对象**）与只读+可直调准入硬门；`weworker/router-config/README.md` 增补两个只读出口的口径。同时订正三处把 `tool_execution` 写成数组的注释（`adapter-parser.ts` / `page-prep.ts` / `tool-catalog.ts`）。公开基线不填 `gate_aliases`、不声明 `tool_execution`，故这两项在公开仓库是显式空态；内部规则仍只经 Profile Overlay 与 `WEWORKER_QUERY_ROUTES_CONFIG` 注入。未执行安装包构建、桌面端构建与真实站点联网验收。

**P5 交付状态（2026-10-14 已完成）**：把第 0 层至 Tier 2（本节表格序 P–12）接入真实对话请求。此前 `tryIntelligentQueryRoute` 只有定义、无调用点，配置层的路由对真实用户消息完全不生效（现象：`维基百科随机` 仍由模型作答，`思考 27.9s`）。改动只在 `server.ts` 的 `POST /works/:id/chat`：在既有 `tryBackendProfileQueryRoute` 钩子之后新增一个调用块，返回 `true` 时按同一形态收尾（`finished = true` → `res.off('close', onClose)` → `broadcastSSE({ type: 'works_changed' })` → `res.end()`），返回 `false` 时原样继续进入 siteGate／第 4 层／`streamChat`——与本节表格「序 13 落回 `streamChat`、序 14/15 在其后」的顺序一致。回合历史取「当前用户消息之前」的消息（追问态硬门需要），`retryCompaction` 回合跳过（重试意图是重跑模型，不是重放同一条路由结果），急停沿用 `WEWORKER_API_QUERY_ROUTE=0`。验证：`tsc --noEmit` 无输出；`npx vitest --run src/api-query-router` → 7 文件 / 157 项通过；`npm run test:ci` → 108 文件 / 1038 项通过（另 2 文件 / 4 项为既有跳过）。

**P6 交付状态（2026-10-14 已完成）**：修 fast-path 回合一类「有路由也看不到数据」的缺陷。

1. **落盘指针在 fast-path 里是死路**（`webcli-result-cache.ts` / `generic-renderer.ts` / `api-query-router/index.ts`）。payload ≥ `LARGE_OUTPUT_THRESHOLD_CHARS`(16000) 时 `offloadIfLarge` 落盘并只回一个 `large_output` 指针。LLM 回合能拿 `webcli_result` 工具把它读回来，fast-path 回合零 LLM，指针就是终点——用户看到的是 `⚠️ 结果过大已落盘（count=20）` 加一串路径（现象：`今日头条热榜`，payload 23198 字符）。新增 `rehydratePointer(pointerText, rootDir?)`：解析指针 → `assertInsideRoot` 防目录穿越 → `isCacheFresh` 查 TTL → 读回落盘 JSON 原文；`renderGeneric` 的 `large_output` 分支先尝试回读并重渲染，读不回来／过期／越界／渲染后仍超 `SPILL_INLINE_MAX_CHARS`(12000) 就逐字退回原指针文案。回读是**注入式可选依赖**（`deps.rehydrate`），LLM 路径不传、行为不变。
2. **声明式链接列把整条 URL 写两遍**（`declarative-renderer.ts`）。`link` 列无 `xxx_label` 时用 URL 当标签，又原样拼进 `(...)`；今日头条的 url 单条 829 字符（其中 775 是 `log_pb` 埋点参数），20 行表格因此 **18124 字符 → 顶穿 12000 上限 → 反而退回落盘指针**（比不声明 schema 的通用渲染 5035 字符还差）。新增 `compactHref`：href 超 200 字符且去掉 query/hash 后路径仍带定位信息时保留规范链接，否则原样保留（那种「id 全在 query 里」的 URL 删了就是坏链接，宁可把体积交给上限兜底）。修复后同一份真实数据 **3013 字符 / 24 行**，链接仍可点开。
3. **标题重复**：渲染配置标题 + schema 标题 + 节标题三层常是同一个词，单个结果会印出两到三行一样的标题；抽出 `hasTitleHeading` 在两层各自去重。

验证：`tsc --noEmit` 无输出；`npx vitest --run src/api-query-router` → 9 文件 / 167 项通过；`npm run test:ci` → 110 文件 / 1052 项通过（另 2 文件 / 4 项为既有跳过）；用用户机器上真实落盘文件（`tool-results/<workId>/toutiao.com.hot-*.json`）端到端复跑，渲染结果内联展示、无指针文案。新 schema 的登记由内部回归套件的 `SCHEMA_SOURCE` 强制校验（新增 schema 不登记即失败）。

**P6 补（2026-10-15）**：

4. **层 P 的 `render` 在级联边界被丢掉**（`cascade.ts`）。`routes.json` 里写的 `render: {type:'schema', schemaId}` 解析正常、校验通过，但规划期构造 `route` 步骤时没有把它带进 `CascadeDecision.render`，于是**声明式表格对所有层 P 路由永不生效**——现象是「命中了但渲染出通用表格」，而且没有任何日志。修法与第 11 层 shortcut 对齐（`render: {title, schemaId: type==='schema' ? schemaId : undefined}`）。
5. **第 11 层别名不支持声明渲染**（`types.ts` / `validate.ts` / `aliases.ts` / `cascade.ts` / `index.ts` / `aliases.json`）。层 P 与快捷话术都能声明 schema，`!别名` 不能——同一个工具（如 `toutiao.com.hot`）经 `!toutiao` 进来渲染成 8 列通用表格（5013 字符），经层 P 进来是声明的 4 列（3011 字符）。给 `AliasEntry` 加 `render?: RouterRenderSpec`（校验、匹配、级联三层贯通），并给 `aliases.json` 里能对上既有 schema 的条目配上：`!v2ex` / `!v2exhot` / `!v2exlatest` → `v2ex-topic-list`，`!v2exnodes` → `v2ex-node-list`，`!toutiao` → `toutiao-hot-list`（v2ex 的 `hot` 与 `latest` 列声明相同，故共用一个 schema）。**注意与第 4 条同源**：仅加声明字段还不够，`index.ts` 构造引擎匹配器时也把 `hit.render` 丢了，必须一并带上，否则症状与第 4 条逐字相同。实测修复后 `!toutiao` 与层 P 的 `今日头条热榜` 渲染同一张表（均 3020 字符 / 20 行）。

   **回归守卫**（两处，防同一坑第三次）：
   - 内部回归套件（`config-layers`）「渲染声明（schemaId）必须一路带到规划结果」——经公开 API `planRouteDecision` 断言层 P / 别名 / 短路三层声明都落到 `decision.render.schemaId`，且**不声明时不得从别层漏过来**；
   - 内部回归套件（`shipped-router-config`）「同一个工具在各层的渲染声明必须一致」——某工具只要有任意一层声明了 schema，其余各层对它的条目必须声明同一个（本条直接就能拦住 `!toutiao` 那次漏配）。
6. **`RouteEntry.render` 的类型写窄了**（`types.ts`）：原为 `{type?: 'generic'}`，与运行时实际接受的 `{type:'schema', schemaId}` 不符，改为复用 `RouterRenderSpec`。

**自动回归工具（把「人工逐条测」变成一条命令）**：`weworker/backend-ts/scripts/route-replay.mts`（`npm run route:replay` / `route:replay:live`）。它把本清单 `docs/router-config-manual-testcases.md` 当作**唯一事实来源**解析，因此不存在「文档与脚本两张皮」。纯规划模式调 `planRouteDecision` 断言命中层/工具/参数/渲染方式；真派发模式调 `executeRoutePlan`（注入 `persistAssistantMessage: no-op` 避免写库、注入 `dispatch` 包装以记录**每一跳的原始返回**）。每条给出：命中第几层、命中的工具与渲染方式、结果是否正常（行数/字段数/工具报错/落盘指针/空结果），报告里附**实际输出原文**与派发轨迹作为证据。

已知环境限制（与配置无关，报告里判为需人工确认而非失败）：`zh.wikipedia.org` / `www.v2ex.com` 在本机网络下不可达（日志 `curl: (28)` / 22s 超时后 `Source request failed`）；`weread.qq.com.search` 对英文关键词返回 `Unexpected API redirect`；`hn 用户 <名>` 返回的是 kv 而非表格（正常结果，判定需认「字段数」）。

---

## 7. 红线

- 仓库不得包含真实密钥、Token、密码、账号、内部域名、私网 IP 或内部系统资料；示例地址一律 `example.com` / `example.org` / `localhost` / `127.0.0.1`。
- 内部业务路由规则**只存在于内部仓库**，通过 Profile Overlay 与 `WEWORKER_QUERY_ROUTES_CONFIG` 注入；本目录只放公开适配器示例。
- 对外界面与文档只使用「网站探索agent」，不出现内部组件名。
- 网站探索agent 持久数据固定写入 `~/.weworker/webwright/`，不读取、不迁移、不清理旧目录。
- 写操作、变更类工具**不得**进入路由面（只读是准入硬门）。
