# 智能路由配置目录

本目录是智能路由各层的**随包默认配置**。

- 现行架构说明（分层、闸门、失败走向、红线）：[`docs/intelligent_routing_architecture.md`](../../docs/intelligent_routing_architecture.md)
- 实施历史与各阶段交付记录：[`docs/intelligent_routing_design.md`](../../docs/intelligent_routing_design.md)
- 本目录的作业流程（skill）：[`.claude/skills/router-config-authoring/SKILL.md`](../../.claude/skills/router-config-authoring/SKILL.md)

一个层一个文件，路由规则全部是数据；新增、删除、修改一条路由＝改这里的一行配置，保存后下次取配置即生效（按文件 mtime + size 判定热重载，无需重启进程）。**引擎代码不需要动。**

## 文件清单

| 文件 | 层 / 命中位 | 分节方式 | 作用 |
| --- | --- | --- | --- |
| `manifest.json` | — | — | 逐层开关（`layers.<层名> = false` 关闭该层）与 schema 版本 |
| `routes.json` | 层 P / 命中位 ① | 按 adapter | 别名（全等）/关键词（包含）直接命中的单工具路由 |
| `aliases.json` | 第 11 层 / ⑥ | 按 adapter | 形如 `!repos` 的显式短路入口 |
| `shortcuts.json` | 第 11 层 / ⑥ | 按 adapter | 正则/关键词命中 + 从消息里抽参（需 adapter 词门） |
| `patterns.json` | Tier -1 / ④ | 按 adapter（内层 key 为完整工具名） | 按工具配置正向/负向正则、参数抽取器 |
| `plans.json` | 层 9 / ⑤ | 按 adapter | 锚点 DAG：resolver 产出锚点，terminal 落地调用 |
| `renderers.json` | —（纯渲染） | 按 `schemaId`（可跨工具复用） | 声明式表格列定义，不写脚本 |
| `plan-terminals.json` | 层 9 白名单 | 按 adapter | 允许 plan 落地的工具及其入参声明（编译期/测试期校验用） |
| `scenario-routes.json` | 第 0 层 / ② | — | Adapter manifest 场景声明的**编译产物**，由 `npm run gen:routes` 生成，勿手改 |

## 注释与 `examples`

配置文件是 **JSONC**：支持 `//`、`/* */` 注释与尾逗号（`jsonc.ts` 剥离注释后再 `JSON.parse`，字符串内的 `//` 如 URL 不会被误删）。

> ### ⚠️ 注释能用，但只对「走 JSONC 读入口」的程序能用
>
> 这些文件**扩展名仍是 `.json`，内容却不是严格 JSON**。事实是：
>
> | 谁 | 能不能读带注释的文件 |
> | --- | --- |
> | 平台运行时（`router-config/loader.ts`） | ✅ 走 `parseJsonc` |
> | CLI 与编译链（`scenario-route-cli.ts`、`gen-routes`） | ✅ 走 `parseJsonc` |
> | 编辑器 / `jq` / `python -m json.tool` / 任何裸 `JSON.parse` | ❌ **会报错** |
>
> 所以：**改配置时若编辑器给红线，不用管**（那是它在按严格 JSON 校验）；但**代码里要读这些文件，必须用 `parseJsonc`，不能用 `JSON.parse`**。
>
> 历史教训：回归套件（`route-eval`）里曾用裸 `JSON.parse` 读 `plan-terminals.json`，抛错被 `catch` 吞成 `null`，白名单静默变空——`--check` 于是拿空白名单编译，与产物悄悄分叉却一直报绿（公开基线恰好没有 `route.plan` 卡片，掩盖了这个洞）。现已改走 `parseJsonc`，并加了一条「白名单必须非空」的断言防复发。
>
> 加载器侧也已收紧：**文件读不懂**现在与「校验不过」同权处理——写进 `sources[].rejected`（带 `解析失败` 字样），并**保留上一份可用配置**，而不是只打一行 WARN 就让整层静默变空。症状是「所有层同时不命中」时，先看这条。

两类「示例」分工不同，**都要写，不能互相替代**：

| 位置 | 给谁读 | 作用 |
| --- | --- | --- |
| **文件头部注释** | 人 | 模板、一个完整成功示例、该层常见的写坏方式。解决「怎么填」 |
| **条目的 `examples` 数据字段** | 机器 | **必填**。写「应当命中本条」的完整原文，被测试直接当正例实跑 |

`examples` 的三重作用：

1. 加一条配置时不用去别处翻「这条怎么用」；
2. 写错的关键词/正则**当场红**，而不是上线后静默不命中；
3. **写不出示例往往说明这条配置本来就不该加**——这就是「防止添加污染路由层」的第一道自律。

> 注释里的示例机器读不到，等于写了但没验证。缺 `examples` 的条目校验失败，**整个用户层回退**。

**分节必须嵌在该层自己的字段里面**（少一层嵌套 = 整层静默失效）。数组型层的分节值是条目数组；记录型的 `patterns` 分节值是「工具名 → 配置」：

```jsonc
// 数组型：routes / aliases / shortcuts / plans
{ "routes": { "wikipedia.org": [ { "id": "wiki-random", "tool": "wikipedia.org.random", "examples": ["维基百科随机"] } ] } }

// 记录型：patterns
{ "configs": { "wikipedia.org": { "wikipedia.org.search": { "patterns": [ /* … */ ] } } } }
```

写成 `{ "wikipedia.org": [...] }`（把分节提到顶层）会被加载器**大声报错**并回退该层——这个形态曾经静默通过，整层条目被丢弃且没有任何日志。`patterns` 的旧形态（`configs` 直接以完整工具名为 key）继续可用，两种形态还能逐条混写；分节里的工具名与分节 key 不符（或同一工具被配了两遍）同样当场报错。


## 覆盖层

用户级覆盖放在 `~/.weworker/router/`，文件名与本目录一致：

- 数组型层（`routes` / `aliases` / `shortcuts` / `plans` / `scenario-routes`）按 `id` 逐条合并：同 id 覆盖，新 id 追加；
- 记录型层（`patterns.configs` / `renderers.schemas` / `plan-terminals.adapters`）按 key 逐项合并，值为 `null` 表示删除该项；
- `manifest.json` 只覆盖显式给出的开关。

条目级开关用 `"enabled": false`，不必删行。

## 两条硬约束

1. **只对当前存在的 Adapter 生效。** 条目引用的工具必须属于当前配置里的某个 Adapter（`工具名 === Adapter id` 或以 `Adapter id.` 开头），否则整条被丢弃并在 `sources.dropped` 里给出原因。这样一份通用配置在缺 Adapter 的环境里不会被误当作可用路由。
2. **坏配置不影响其他层。** 每个文件独立校验（含正则可编译性）；校验失败的层回退到上一份可用配置，最差退化为「该层不命中」，也就是回到模型兜底，不会答错。

## 生效范围如何对外可见

改完配置「是否已生效」不用靠猜，客户端有两个只读出口直接读同一份配置：

| 出口 | 内容 | 口径 |
| --- | --- | --- |
| `GET /sites` 的 `routable` / `routeEntryCount` | 该站点是否被当前配置覆盖、覆盖了几条 | `routable: true` ⇔ 该 Adapter 已启用，且其名下工具被本目录（含用户覆盖层）里**至少一条启用的**条目引用（`routes` / `aliases` / `shortcuts` / `patterns.configs` / `plans` / `scenario-routes`）。`enabled: false` 的条目、`direct: false` 的卡片、被作用域丢弃的条目都不算。站点列表据此显示「路由直达」徽标 |
| `GET /router/aliases` | 当前生效的全部 `!别名` | 输入框据此判断 `!xxx` 是路由命令还是 shell 命令；取值与后端 `aliases.json` 完全同源，改配置后下次取配置即同步。接口异常时返回空数组，输入框回退到随包静态清单 |

两个出口都按**当前启用的 Adapter** 求值：禁用的站点既不参与 `routable`，它的别名也不会出现在输入框里——与上面第 1 条硬约束是同一件事的两种说法。

## 增删改示例

新增一条 `!inbox` 别名（工具属于 `example.com` 这个 Adapter）：

```jsonc
// weworker/router-config/aliases.json
{
  "aliases": {
    "example.com": [
      {
        "id": "inbox",
        "alias": "!inbox",
        "tool": "example.com.list-messages",
        "args": { "limit": 20 },
        "examples": ["!inbox"]   // 必填：这条配置应当被哪句话命中，测试会拿它实跑
      }
    ]
  }
}
```

删除：直接删掉该条数组元素；临时下线：加 `"enabled": false`。

修改后无需重启客户端；如果改了 `scenario-routes.json`，应改 Adapter manifest 并重新生成，避免手改内容被下次生成覆盖。

**旧形态仍兼容**：`{ "aliases": [ … ] }`（扁平数组，无分节）继续可用，外部注入配置与历史覆盖层不受影响；但新增配置请用分节形态，便于回答「这个 Adapter 配了什么」。

## 新增一个 Adapter 的作业流程

五步，全程不改引擎代码：

1. **确认工具进得了路由面**：必须是**可直调 + 显式只读**（`safety: 'read'`，不要求二次确认）。**写操作到此为止**，不要往下走。
2. **从最钝的一层开始**：先在 `routes.json` 里加复合关键词条目（带 `examples`）。**不要一上来就写 `patterns.json` 正则**——那一层没有 adapter 关键词硬门，写宽了会越过所有层吃掉别人的话术。
3. **跑三条命令**（见下），红了就改配置，不要改断言。
4. **按需升级到强层**：需要抽参 → `shortcuts.json`；需要从消息里查库 → `patterns.json`；需要两跳 → `plans.json`（并在 `plan-terminals.json` 登记）。
5. **补卡片话术（可选）**：想让客户端卡片点击直达，写进 adapter `manifest.scenarios[].route`，跑 `npm run gen:routes`。

**每一步的准入门槛都是同一条**：能写出一条「应当命中本条」的真实原文。写不出来，就说明这条配置的边界还不清楚——**此时正确的动作是不加，让它落回 LLM**（漏判免费，误判致命）。

### 提交前必跑

```bash
# 在 weworker/backend-ts 下
npx vitest --run src/api-query-router/__tests__/   # 结构自洽 + 正例全覆盖 + 负例零误判
npx tsc --noEmit
npm run route:replay                               # 按 docs/router-config-manual-testcases.md 端到端回放

# 在 weworker 下
npm run gen:routes:check                           # 编译产物与 manifest 源一致
```

`route:replay` 把 [`docs/router-config-manual-testcases.md`](../../docs/router-config-manual-testcases.md) 当**唯一事实来源**解析，逐条给出**是否命中路由**、命中第几层、命中的工具与渲染方式、结果是否正常（行数/字段数/工具报错/落盘指针/空结果）与**耗时**，并附实际输出原文与派发轨迹。**新增的配置要同步把用例加进那份文档**，否则回放覆盖不到。

想看「用户实际拿到什么回答、整轮多少秒」，用端到端那一层——同一个清单，真实 HTTP+SSE：

```bash
cd weworker
node scripts/chat-bench/bench.mjs --router-cases --no-test-prompts --out ./bench-out
```

它按 `turn_end` 有没有带 `routeTool` 判定「走没走路由」，并汇总「走路由 N 条 vs 落回 LLM M 条、各平均多少毫秒」。详见 [`scripts/chat-bench/README.md`](../scripts/chat-bench/README.md)。

## 随包基线覆盖了什么

只有**同时满足「可直调」与「显式只读」**的工具才进路由面：`execution.type === 'api' && execution.runtime === 'background'`（或 `directCapable` / `executionMode: 'direct'`），且 `safety === 'read'` 且不要求二次确认。33 个公开 Adapter 里满足这一条的只有 10 个、共 38 个工具；本基线把其中 **27 个**写进了配置：

| Adapter | 路由面内的工具 | 本基线覆盖 | 走哪一层 |
| --- | --- | --- | --- |
| `news.ycombinator.com` | 9（`top` `best` `new` `ask` `show` `jobs` `search` `read` `user`） | 9 | 层 P（7 个列表）、patterns（search / read / user） |
| `v2ex.com` | 8（`hot` `latest` `topic` `member` `node` `nodes` `replies` `user`） | 6 | shortcuts（含抽参）+ 声明式表格 |
| `wikipedia.org` | 5（`search` `summary` `random` `trending` `page`） | 4 | 层 P（random / trending）、patterns（search / summary）、plans（两跳：检索 → 摘要） |
| `weread.qq.com` | 3（`book-search` `ranking` `search`） | 3 | 层 P（ranking）、patterns（search）、plans（两跳：书名 → 书内搜索） |
| `arxiv.org` | 4（`search` `paper` `author` `recent`） | 2 | shortcuts（含抽参）+ 声明式表格 |
| `ctrip.com` | 4（`search` `destination-search` `hotel-suggest` `whoami`） | 0 | — |
| `github.com` | 1（`repos`） | 1 | shortcuts（`github trending` 类话术） |
| `toutiao.com` | 2（`hot` `recommend`） | 1 | 层 P（hot） |
| `36kr.com` | 1（`news`） | 1 | 层 P |
| `12306.cn` | 1（`stations`） | 0 | — |

**没进配置的 11 个工具都是有必填参数的**：`ctrip.com` 的 4 个（出发地/目的地/日期等槽位一多就无法用声明式正则零误判地填）、`12306.cn.stations`（站名抽取）、`arxiv.org.author` / `arxiv.org.recent`（作者名 / 分类串边界不可靠）、`toutiao.com.recommend`、`v2ex.com.replies` / `v2ex.com.user`（与同站其他工具的样本句互相吃字）、`wikipedia.org.page`（全文话术罕见）。它们一律**落回 LLM**——这正是「漏判免费」：模型照样会调到同一个工具，只是多一次模型往返。

另外，**写操作**（各站 `login` / 发帖 / 下单 / `v2ex.com.daily` 等）与**需要页面上下文**的工具（未声明 `execution.type=api` + `runtime=background`）根本不进路由面，`isRoutableTool` 会在派发前把它们挡掉。

> 卡片话术（各 Adapter manifest 里的 `scenarios`）不在这里配置——它们由 `scenario-routes.json` 那条编译链负责，重复写第二遍只会形成互相遮蔽的两个层。

## 本基线的精度约定

漏判免费（落回 LLM ＝ 今天的行为），**误判致命**（短路掉模型，用错的工具答用户）。因此：

- 层 P（`routes.json`）只用**复合关键词**，不用 `github`、`v2ex` 这种站名裸词——`帮我在 GitHub 搜索相关仓库` 这类消息绝不能被关键词层吃掉。
- `patterns.json` / `plans.json` 的正则要求站点词与动作词之间存在**显式分隔符**（空格或冒号）。`维基百科搜索 量子力学` 命中，`维基百科搜索引擎` 不命中（否则会把 `引擎` 当作检索词）。这类不命中的写法落回 LLM，结果相同、只是慢一点。
- `shortcuts.json` 的每条 `positive` 都是正则；配套的 `negative` 用来挡住同站点的另一种意图（如 `v2ex 节点列表` 不被「单节点」规则吃掉）。

每条进入 `routes` / `aliases` / `shortcuts` / `patterns` / `plans` 的条目（`patterns` 精确到每条规则）都必须自带 `examples`，内部回归套件（不在开源仓库）**直接从配置里把它们抽出来当正例实跑**，并断言「配置里的每条启用条目都被覆盖」（`positiveChecked === routeCount`，防止引擎未加载导致的假绿）；对抗性负例集与「负例精度必须 100%」的硬门也在该套件里（`route-eval`）。示例与条目同处一份文件，不会漂移。同一批样例的人肉版（在客户端里一条一条发的清单 + 判定口径）见 [`docs/router-config-manual-testcases.md`](../../docs/router-config-manual-testcases.md)。

```bash
# 回归套件在内部环境
cd weworker/backend-ts && npx vitest --run src/api-query-router
```

## 红线

内部业务规则（内部系统名称、内部工具名、内部话术）不进入本目录，只通过构建 Profile Overlay 与 `WEWORKER_QUERY_ROUTES_CONFIG` 注入；本目录只放随公开基线发布的通用配置。
