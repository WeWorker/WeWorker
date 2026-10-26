# 智能路由配置 · 人工逐条测试清单

配套自动断言位于内部回归套件（不在开源仓库；16 项测试 / 90 条样例，均已通过）。
本清单是同一批样例的「人肉版」：用于在客户端里一条一条发、肉眼看结果。

配置本体在 `weworker/router-config/`，设计说明见 [`intelligent_routing_design.md`](./intelligent_routing_design.md)。

---

## 一、怎么跑

### 1.1 自动跑（推荐，不需要手输）

本清单是**唯一事实来源**：自动化脚本直接解析下面这张表，文档改了脚本跟着变，不会出现「清单和脚本两张皮」。

```bash
cd weworker/backend-ts
npm run route:replay        # 纯规划：毫秒级，验「命中哪一层 / 命中哪个工具 / 参数对不对 / 用不用声明式表格」，不碰网络
npm run route:replay:live   # 真派发：每条走一次 webcli（数秒），验「工具跑不跑得通、结果正不正常」
```

常用参数：`--only 3.1`（只跑某节）、`--only 4,17`（只跑某几条）、`--json`（另存机器可读结果）。

每条都会打印并落进报告的是四件事：

```
[PASS] #  4 今日头条热榜  命中：层 P 关键词直连  toutiao.com.hot  声明式表格 toutiao-hot-list ｜ 结果：正常（20 行数据）
          第 1 跳 toutiao.com.hot {"limit":20} → 落盘指针（count=20）
          输出首行：### 今日头条热榜（20 条）
```

| 列 | 含义 |
| --- | --- |
| `命中：<层>` | **命中的第几层**（层 P / Tier -2 / 硬门 / 层 9 / 第 11 层 …） |
| 工具 | 该层认领的工具；`—` 表示没有任何层认领（负例的正确结局） |
| 渲染 | `声明式表格 <schemaId>` 或 `通用表格` |
| 结果 | **结果正不正常**：`正常（N 行数据）` / `正常（N 项字段）` / `工具报错：…` / `落盘指针：用户看不到数据` / `空结果` |
| 判定 | `PASS`（符合预期）/ `FAIL`（配置错：误判、漏判、工具不符、参数不符）/ `SKIP`（命中正确但外部原因拿不到数据，需人工确认） |

报告（**含每条的完整输出原文与逐跳返回，作为证据**）落在仓库根 `.scratch-router/`：

- `route-replay-dry.md`：纯规划全量结果
- `route-replay-live.md`：真派发全量结果（含逐条输出证据 + 派发轨迹）

### 1.2 人工跑（需要肉眼看客户端表现时）

1. 启动客户端：在 `weworker/` 目录执行 `npm run dev`（Electron 窗口 + vite 渲染层）。
2. 新建一个会话，把下面每条的「输入」**原样**粘进输入框发送，一次一条。
3. 不要连发、不要自己加前后缀或换标点——匹配是逐字面的，改写会得到不同结果。
4. 每条发完看两点：① 消息结尾的耗时行；② 回复内容的形态。

---

## 二、怎么判定通过

每条回复结尾有一行耗时：

```
⏱ 本轮 1.2s ｜ 思考 0ms ｜ 执行 980ms ｜ 1 步
```

| 观察到 | 含义 | 预期出现在 |
| --- | --- | --- |
| `思考` ≈ 0（<10ms）且 `执行` 有值 | **命中路由层**，模型没参与，配置直接短路 | 第三节全部正例 |
| `思考` 有正常模型耗时（几百 ms ~ 数秒） | **落回 LLM 兜底** | 第四节全部负例 |

命中时结果直接以列表/表格呈现（`v2ex` / `arxiv` 走声明式表格，其余为通用渲染），不会出现模型的自然语言分析过程。

**硬证据在日志里**（客户端每次启动覆盖写）：

```
%APPDATA%\weworker\logs\main.log
```

| 日志关键字 | 含义 |
| --- | --- |
| `route hit [<层>]: <工具>` | 命中并成功执行；`<层>` 就是命中的那一层 |
| `plan hit: <工具> (N steps)` | 两跳计划命中 |
| `route auth fallback: <工具>` | 命中了，但工具报「未登录」→ 按设计落回模型（**不是配置问题**，见第五节） |
| `route dispatch failed: <工具>` | 工具执行报错 → 落回模型 |
| `cascade stopped after <层>` | 该层判定「不再往下试」（失败策略为 stop） |
| `cascade blocked at <门> → fall back to LLM` | 被硬门拦住（讨论态/追问态/未命中别名） |
| `route execution skipped non-routable tool` | 工具被挡在路由面之外 |

---

## 三、正例：应命中，不应经过模型（54 条）

### 3.1 层 P · 关键词直连（`routes.json`，11 条）

整句去掉所有空白、转小写后**包含**配置关键词即命中；参数是静态的。

| # | 输入 | 期望工具 | 期望参数 |
| --- | --- | --- | --- |
| 1 | `维基百科随机` | `wikipedia.org.random` | `{"lang":"zh"}` |
| 2 | `维基百科热榜` | `wikipedia.org.trending` | `{"lang":"zh","limit":20}` |
| 3 | `微信读书排行榜` | `weread.qq.com.ranking` | `{"limit":20}` |
| 4 | `今日头条热榜` | `toutiao.com.hot` | `{"limit":20}` |
| 5 | `36氪资讯` | `36kr.com.news` | `{"limit":20}` |
| 6 | `hn头条` | `news.ycombinator.com.top` | `{"limit":20}` |
| 7 | `hn最佳帖子` | `news.ycombinator.com.best` | `{"limit":20}` |
| 8 | `hn最新话题` | `news.ycombinator.com.new` | `{"limit":20}` |
| 9 | `askhn` | `news.ycombinator.com.ask` | `{"limit":20}` |
| 10 | `showhn` | `news.ycombinator.com.show` | `{"limit":20}` |
| 11 | `hn招聘` | `news.ycombinator.com.jobs` | `{"limit":20}` |

### 3.2 `!` 别名（`aliases.json`，20 条）

必须以 `!` 开头，整串归一化后**完全相等**才命中；输入框应有补全提示。

| # | 输入 | 期望工具 | 期望参数 |
| --- | --- | --- | --- |
| 12 | `!hn` | `news.ycombinator.com.top` | `{"limit":20}` |
| 13 | `!hntop` | `news.ycombinator.com.top` | `{"limit":20}` |
| 14 | `!hnbest` | `news.ycombinator.com.best` | `{"limit":20}` |
| 15 | `!hnnew` | `news.ycombinator.com.new` | `{"limit":20}` |
| 16 | `!hnask` | `news.ycombinator.com.ask` | `{"limit":20}` |
| 17 | `!hnshow` | `news.ycombinator.com.show` | `{"limit":20}` |
| 18 | `!hnjobs` | `news.ycombinator.com.jobs` | `{"limit":20}` |
| 19 | `!v2ex` | `v2ex.com.hot` | `{"limit":20}` |
| 20 | `!v2exhot` | `v2ex.com.hot` | `{"limit":20}` |
| 21 | `!v2exlatest` | `v2ex.com.latest` | `{"limit":20}` |
| 22 | `!v2exnodes` | `v2ex.com.nodes` | `{"limit":50}` |
| 23 | `!github` | `github.com.repos` | `{"since":"daily","limit":25}` |
| 24 | `!repos` | `github.com.repos` | `{"since":"daily","limit":25}` |
| 25 | `!trending` | `github.com.repos` | `{"since":"daily","limit":25}` |
| 26 | `!36kr` | `36kr.com.news` | `{"limit":20}` |
| 27 | `!toutiao` | `toutiao.com.hot` | `{"limit":20}` |
| 28 | `!weread` | `weread.qq.com.ranking` | `{"limit":20}` |
| 29 | `!wiki` | `wikipedia.org.random` | `{"lang":"zh"}` |
| 30 | `!wikirandom` | `wikipedia.org.random` | `{"lang":"zh"}` |
| 31 | `!wikitrending` | `wikipedia.org.trending` | `{"lang":"zh","limit":20}` |

### 3.3 话术快捷（`shortcuts.json`，12 条样例 / 9 条规则）

正则命中 + 从消息里抽参；命中后仍需通过站点词校验。

| # | 输入 | 期望工具 | 期望参数 |
| --- | --- | --- | --- |
| 32 | `v2ex 热门` | `v2ex.com.hot` | `{"limit":20}` |
| 33 | `v2ex 最新` | `v2ex.com.latest` | `{"limit":20}` |
| 34 | `v2ex nodes` | `v2ex.com.nodes` | `{"limit":50}` |
| 35 | `v2ex 主题 12345` | `v2ex.com.topic` | `{"id":12345}` |
| 36 | `v2ex 987` | `v2ex.com.topic` | `{"id":987}` |
| 37 | `v2ex 用户 livid` | `v2ex.com.member` | `{"username":"livid"}` |
| 38 | `v2ex 节点 python` | `v2ex.com.node` | `{"name":"python","limit":20}` |
| 39 | `github trending` | `github.com.repos` | `{"since":"daily","limit":25}` |
| 40 | `github 热门仓库` | `github.com.repos` | `{"since":"daily","limit":25}` |
| 41 | `arxiv 搜索 transformer` | `arxiv.org.search` | `{"query":"transformer","limit":20}` |
| 42 | `帮我在 arxiv 上搜索 RAG 相关论文` | `arxiv.org.search` | `{"query":"RAG","limit":20}` |
| 43 | `arxiv 2401.12345` | `arxiv.org.paper` | `{"id":"2401.12345"}` |

### 3.4 提示词配置（`patterns.json`，9 条样例 / 6 组 9 条规则）

站点词与动作词之间必须有**显式分隔符**（空格或冒号），否则不命中。

| # | 输入 | 期望工具 | 期望参数 |
| --- | --- | --- | --- |
| 44 | `维基百科搜索 量子力学` | `wikipedia.org.search` | `{"query":"量子力学","lang":"zh","limit":10}` |
| 45 | `wiki 搜索 rust` | `wikipedia.org.search` | `{"query":"rust","lang":"en","limit":10}` |
| 46 | `维基百科词条 量子力学` | `wikipedia.org.summary` | `{"title":"量子力学","lang":"zh"}` |
| 47 | `wiki summary rust` | `wikipedia.org.summary` | `{"title":"rust","lang":"en"}` |
| 48 | `微信读书搜索 人类简史` | `weread.qq.com.search` | `{"query":"人类简史","limit":20}` |
| 49 | `weread search for atomic habits` | `weread.qq.com.search` | `{"query":"atomic habits","limit":20}` |
| 50 | `hn 搜一下 playwright` | `news.ycombinator.com.search` | `{"query":"playwright","limit":20,"sort":"relevance"}` |
| 51 | `hn 用户 pg` | `news.ycombinator.com.user` | `{"username":"pg"}` |
| 52 | `hn 帖子 123456` | `news.ycombinator.com.read` | `{"id":123456,"limit":20}` |

### 3.5 多跳计划（`plans.json`，2 条）

先跑 resolver 拿锚点，再喂给 terminal 落地。表现上会有 **2 步**，且慢于单跳。

| # | 输入 | 期望计划 | 中间跳 → 落地 |
| --- | --- | --- | --- |
| 53 | `维基百科 量子力学` | `wikipedia-topic-summary` | `wikipedia.org.search` 取首条 `title` → `wikipedia.org.summary` |
| 54 | `微信读书《三体》里搜索 宇宙` | `weread-search-in-book` | `weread.qq.com.search` 取首条 `bookId` → `weread.qq.com.book-search` |

> 第 53、54 条对应的原书目/示例若换成 `原子习惯`，会因引擎硬门里的「习惯」二字被判成讨论态而不命中——这是**已知边界**，与配置无关；`人类简史` / `《三体》` 是安全样例。
>
> **选词要求（实测得出）**：站内搜索的词必须真的出现在**第一跳取到的那本书**的正文里。实测 `《三体全集（全三册）》`（`bookId 695233`）的检索索引只覆盖第一部——`黑暗森林` / `罗辑` / `面壁`（第二部内容）全部空返回，`宇宙` / `三体` 有命中；《三体2·黑暗森林》在站内是**独立条目**（`bookId 183526`）。故本条用 `宇宙`。
>
> 第 53 条依赖 `zh.wikipedia.org` 可达；本机连不上该域名时该条按设计落回模型（日志里有 `curl: (28) Failed to connect to zh.wikipedia.org port 443`），属**环境限制**而非配置问题。

---

## 四、负例：应落回模型，不得被任何层认领（36 条）

**这一节比正例更重要。** 误判会短路掉模型、用错的工具回答用户；漏判只是多一次模型往返。
以下每条都贴着某条规则改写，但语义上不该被认领——发出去应当**看到模型耗时**（`思考` 不为 0）。

| # | 输入 | 为什么不该命中 |
| --- | --- | --- |
| 55 | `维基百科的热门条目和随机条目的差别` | 关键词层：归一化后不含任何配置关键词 |
| 56 | `维基百科的随机条目功能怎么用` | 讨论态 + 关键词不成立 |
| 57 | `帮我看看有没有类似 36氪 的资讯站点` | 「36氪资讯」不成立 |
| 58 | `hn最新版本是哪一版` | 「hn最新」不再作为裸关键词 |
| 59 | `帮我在 GitHub 搜索相关仓库` | 站点裸词不得命中（github 只认 trending 类话术） |
| 60 | `帮我查看 GitHub 仓库的信息` | 站点裸词不得命中 |
| 61 | `github 上有什么热门仓库` | 「github 热门仓库」要求站点词与动作词相邻 |
| 62 | `github 仓库信息` | 缺动作词 |
| 63 | `v2ex 上有什么好玩的话题` | 无列表动作词 |
| 64 | `v2ex 节点列表里哪个节点最活跃` | 提问式用法：被负向词挡住 |
| 65 | `v2ex 主题列表` | 「主题」后必须有数字 id |
| 66 | `v2ex 用户功能有哪些` | 用户名必须是拉丁名字 |
| 67 | `arxiv 上有什么关于 RAG 的论文` | 缺动作词（「有什么」不是检索动词） |
| 68 | `arxiv 主页` | 缺动作词 |
| 69 | `arxiv 搜索功能怎么用` | 讨论态 |
| 70 | `维基百科搜索引擎` | 「搜索」后无分隔符，不得把「引擎」当检索词 |
| 71 | `维基百科搜索功能怎么用` | 负向词 + 讨论态 |
| 72 | `维基百科词条数量有多少` | 「词条」后无分隔符 + 负向词 |
| 73 | `维基百科条目和随机条目的区别` | 讨论态语义，非摘要请求 |
| 74 | `微信读书搜索引擎怎么优化` | 「搜索」后无分隔符 |
| 75 | `hn 用户功能有哪些` | 用户名必须是拉丁名字 |
| 76 | `hn 帖子` | 缺数字 id |
| 77 | `hn search 功能在哪` | 「search」缺 for / 冒号 |
| 78 | `维基百科` | 计划入口缺主题槽位 |
| 79 | `wikipedia` | 计划入口缺主题槽位 |
| 80 | `维基百科 简介` | 计划入口负向词命中 |
| 81 | `微信读书《三体》好看吗` | 计划入口要求检索动词 |
| 82 | `!nosuchcommand` | 别名未命中时整轮阻断，落到模型而不是被宽泛层猜走 |
| 83 | `搜索邮件` | 过短，无站点词 |
| 84 | `搜索最近收到的邮件` | 无站点词 |
| 85 | `search my inbox for invoices received this month` | 英文改写，无站点词 |
| 86 | `你能做什么` | 能力询问 |
| 87 | `帮我把 v2ex 的账单导出来` | 写操作意图不得进路由面 |
| 88 | `这个系统支持哪些适配器` | 讨论态 |
| 89 | `智能路由是怎么工作的` | 讨论态 |
| 90 | `那第二个呢`（先发一条让它有上文） | 追问态 |

---

## 五、常见疑问

**某条正例没命中，怎么回事？**

按顺序排查：

1. 看 `%APPDATA%\weworker\logs\main.log`：
   - 有 `route hit [...]` → 配置生效了，只是结果渲染/展示让你没看出来；
   - 有 `route auth fallback` / `route dispatch failed` → **命中是对的，站点没登录或工具报错**，按设计落回模型。去对应站点登录（浏览器扩展连着 bridge）后重试；
   - 有 `cascade blocked` → 命中了硬门（讨论态/追问态）；
   - 什么都没有 → 再看下面第 2 条。
2. 确认站点是启用的：站点被禁用时它的工具不进路由面，条目在加载期就被整条丢弃（`README.md` 的「两条硬约束」之一）。在客户端的站点能力页看该站点是否为启用态。
3. 确认消息是**原样**发的：多一个标点、少一个空格、换同义词都会改变结果。

**为什么有些工具没进配置？**

只看**同时满足「可直调」与「显式只读」**的工具：当前 33 个 Adapter / 331 个工具里，满足的只有 10 个 Adapter / 38 个工具，本基线覆盖其中 27 个。
没覆盖的 11 个都是**有必填参数**的（携程 4 个、12306 站名、arxiv 作者/最新、头条推荐、v2ex 回复/用户、维基全文），声明式正则无法零误判地填这些槽位，所以一律落回 LLM——模型照样会调到同一个工具，只是多一次模型往返。写操作与需要页面上下文的工具根本不进路由面。

**为什么层 P 不用 `github`、`v2ex` 这种裸站名？**

那是精度红线：`帮我在 GitHub 搜索相关仓库` 这类消息绝不能被关键词层吃掉。层 P 只用复合关键词，`patterns` / `plans` 的正则要求站点词与动作词之间有显式分隔符。

**改配置要重启客户端吗？**

不用。所有层按文件 mtime + size 判定热重载，保存后下一次发消息即生效。改完想复核，可以直接跑自动断言（回归套件在内部环境）：

```bash
cd weworker/backend-ts && npx vitest --run src/api-query-router
```

**用户级覆盖放哪？**

`~/.weworker/router/`，文件名与本目录一致；按 `id` / key 逐条合并，同 id 覆盖、新 id 追加。
