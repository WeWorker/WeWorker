# OpenCLI 新闻类 wave2 迁移与验收记录（Hacker News + 36氪）

日期：2026-09-29（round 1），2026-09-29 审查 round 1 修复后冻结本文版本；2026-09-29 审查 round 2 修复（空榜误报与 RSS 信封结构校验）后再次冻结。本批迁移 Hacker News 全部 9 项与 36氪全部 4 项来源命令，共 13 项全部接入公开 v2 包。**“通过”仅指当次记录的真实调用路径与 fixture 覆盖**：13 项各自通过了一次真实 WebCLI → Bridge → Extension 只读调用（含 36kr 四类榜单、真实空搜索各一次），不代表所有 hot 类型 × 异常路径的组合或自然语言入口全部通过；后者未执行，不称整体完成。

## 来源与许可

- 来源固定为 `jackwener/OpenCLI` 提交 `24136945847afbfad266c6c46a8cd335377f9112`（本地参考目录已核验 `git rev-parse HEAD` 一致）的 `clis/hackernews/`（ask/best/new/top/show/jobs/search/read/user 及其测试）与 `clis/36kr/`（hot/news/search/article 及其测试）。来源仓库 `LICENSE` 与 `package.json` 均为 Apache-2.0（Copyright 2025 jackwener），两目录无文件级额外许可或第三方资源。
- 许可证沿用既有 `docs/third_party/OpenCLI-LICENSE.txt`，桌面包继续经 `weworker/package.json` 的 `extraResources` 复制为 `licenses/OpenCLI-LICENSE.txt`，无新增文件。每个派生文件头保留来源 SHA 与修改说明。
- 来源仅声明式依赖 `@jackwener/opencli/registry`、`@jackwener/opencli/errors`（注册与错误类型），未复制 OpenCLI 运行时、pipeline 引擎或其他依赖；未新增 npm 依赖，未新建 Runner。

## 包与命令

根 v2 包 `adapters/news.ycombinator.com`（0.1.0，9 命令，全 read）与 `adapters/36kr.com`（0.1.0，4 命令，全 read）。两包均加入 `weworker/build-profile.json` 公开 Profile（现 18 个 host-managed 包）。机器可读 13 项清单：`docs/opencli_news_wave2_inventory.json`（含参数、默认值、数据源、fixture/真实 trace/自然语言状态）。

| 命令 | 参数与默认值（=来源） | 执行方式 | 关键语义与限额 |
| --- | --- | --- | --- |
| `news.ycombinator.com.top/best/new/ask/show` | `limit=20` | 后台 API（backend_fetch，禁重定向、trace 脱敏） | 预取 `min(limit+10,50)` 个 id 再过滤 deleted/dead/无标题，实际返回 ≤50；空/全失效报 EMPTY_RESULT；缺 score/by 保持 null |
| `news.ycombinator.com.jobs` | `limit=20` | 同上 | 按来源无 score/comments 列 |
| `news.ycombinator.com.search` | `query`（必填）、`limit=20`、`sort=relevance\|date` | Algolia 公开接口 | tags=story、hitsPerPage=limit；query/tags 经 URLSearchParams 严格编码；id 来自 objectID |
| `news.ycombinator.com.read` | `id`（必填纯数字）、`limit=25`、`depth=2`、`replies=5`、`max-length=2000`（≥100） | 后台 API 树遍历 | POST 行 + L0/Ln 缩进评论；`[+N more replies]`/`[+N more top-level comments]` 截断标注；**单次调用条目请求预算 200**，耗尽输出明确标注行；deleted/dead/null 跳过；个别请求失败计数标注，不冒充完整；**POST/评论缺 author/score 输出 null（未知），真实 0 分保留，不补造 `[deleted]`** |
| `news.ycombinator.com.user` | `username`（必填） | 后台 API | 用户名 `^[A-Za-z0-9_-]{1,32}$` 校验后 encodeURIComponent；不存在报 EMPTY_RESULT；about 保留来源原始 HTML |
| `36kr.com.hot` | `limit=20`（≤50）、`type=catalog\|renqi\|zonghe\|shoucang` | 页面 DOM + 宿主导航续执行 | renqi/zonghe/shoucang 走 `/hot-list/<type>/<UTC+8 当日>/1` 官方榜单页；catalog 走 `/hot-list/catalog` 聚合页。结果**只取经真实 DOM 核验的榜单区域**（dated：非分区 `.article-list` 的 `.article-wrapper` 行；catalog：`.list-section-wrapper` 分区），并**轮询等待区域内出现可解析行**——容器先渲染、行后填充的动态页不会误判为空；页面标题必须含请求榜单名，否则按类别不一致失败；catalog 每行 board/board_url 为**真实所属分区**及其入口；全页其他 `/p/` 链接（导航/侧栏推荐）不算结果；榜单页面无已验证空态标记，**不支持空榜判定**——区域持续无条目按渲染/结构异常报错，不报空 |
| `36kr.com.news` | `limit=20`（≤50） | 后台 API（RSS `https://www.36kr.com/feed`） | summary=描述前 120 字符；title 解 CDATA/XML 实体；date 为标准 pubDate 解析的**完整 ISO 8601 时间**（缺失/非法为 null，不猜）；对 RSS 信封做**有界结构校验**（单遍扫描，CDATA/注释/PI 整体跳过）：根/通道/条目未闭合或结构异常、条目存在但均无可用标题、HTTP 200 HTML（按真实根元素/doctype 判定）均报接口/解析错误，**CDATA 内伪标记不算条目也不算错误信封**，仅结构合法且零条目才报空（来源返回 `[]` 的行为未保留）；UA 标识 `WeWorker-WebCLI/1.0` |
| `36kr.com.search` | `query`（必填）、`limit=20`（≤50） | 页面 DOM + 导航续执行 | 关键词严格编码；结果**只取 `kr-search-result-list-main` 文章卡标题链接，无全页回退**；以页面无结果提示（`.kr-search-nodata`）为唯一真实空态证据，区域未就绪/结构异常分别报错；当前卡片不暴露日期，date 为空串 |
| `36kr.com.article` | `id`（数字或官方 `/p/` URL） | 页面 DOM + 导航续执行 | 来源声明 INTERCEPT 但实际只读 DOM，未保留拦截器；**ID 严格校验**：仅 `36kr.com`/`www.36kr.com` 的 https 完整 `/p/<纯数字>` 路径（允许尾斜杠/查询/hash）或安全整数范围数字，`/p/123abc`、`/foo/p/123`、外域、非 https、超精度数字一律拒绝；正文按来源截断 **800 字符**，以 body_length/body_truncated/content_status 明确截断与完整性；url 规范化为 `https://www.36kr.com/p/<id>` |

域名声明：HN 包 `match=[news.ycombinator.com]`，API 域 `hacker-news.firebaseio.com`、`hn.algolia.com` 放在 `runtime_allowed_hosts`（仅限受限 backend_fetch，不作为导航目标）；36kr 包仅 `www.36kr.com`。数值/布尔/ID 均在包内校验（CLI 字符串数字接受，小数/越界/类型错误拒绝），未改全局 CLI。

### 与来源的有意偏差（均已记录在清单 data_source）

1. 36kr news：HTTP 失败从静默 `[]` 改为显式 `HTTP_ERROR`；UA 标识更名；round 1 修复起 HTTP 200 的 HTML/畸形文档报解析错误而非 EMPTY_RESULT，date 从 `pubDate.slice(0,10)` 改为完整 ISO 8601（避免丢年份），title 增加 CDATA/实体解码；round 2 修复起信封校验升级为有界结构扫描（未闭合/错配 rss/channel/item、多根、根非 rss、channel 外 item、条目存在但均无可用标题都是解析错误），条目字段取自扫描结果而非正则，CDATA 内伪标记不算条目/字段/错误信封。
2. 36kr article：不再从任意字符串剥离数字猜 ID（来源 `replace(/\D/g,'')` 行为移除），只接受严格官方路径/安全数字；url 输出规范化为 `https://www.36kr.com/p/<id>`。
3. HN 列表 limit 接受 1–100（来源无上限），但保留来源预取上限 50 的实际约束并在 manifest/guidance 说明。
4. HN read/列表的空结果从来源的空数组改为显式 EMPTY_RESULT 错误，避免"返回空数组即成功"。
5. 36kr hot/search（round 1 修复）：移除来源的全页 `a[href*="/p/"]` 抓取与无条件回退，改为可信区域绑定 + 榜单名核验 + 真实分区归属；hot 在 round 2 修复起进一步取消空榜判定（见偏差 7）：等待的是区域内可解析行而非容器本身，search 仍以 `.kr-search-nodata` 为唯一真实空态证据，其余报渲染/结构错误。
6. HN read（round 1 修复）：缺 by/score 不再补 `[deleted]`/0，输出 null；真实 0 分保留。
7. 36kr hot 空榜判定（round 2 修复）：榜单页面没有已验证的空态标记，原“区域渲染但无条目报空”会被“容器先行渲染、行尚未填充”的动态页误触发；改为轮询等待可信区域内出现可解析行，持续无行按渲染/结构异常报错，不支持空榜判定（不编造空态选择器）。

## 审查 round 2 修复记录（本次提交）

- A（hot 空榜误报，R1 遗留）：`waitFor` 由“容器存在”改为“可信区域内出现可解析行”（dated：非分区 `.article-list`；catalog：已识别 `.list-section-wrapper` 分区）。超时后区分：区域从未出现（含仅推荐链接/未渲染两种既有错误）、catalog 分区全部未识别、区域有行但全部不可解析、区域持续无行（新增“渲染/结构异常”错误，提示无已验证空态标记、不报空榜）。移除 hot 的 `EMPTY_RESULT` 空榜分支。新增 fixture：dated/catalog 各一例“延迟填充区域成功”（前两轮空容器、第三轮出行的动态 getter 模拟）与“持续空区域报错”；保留正常区域、侧栏隔离、仅推荐、类别不一致、验证码等反例。
- B（news RSS 信封校验不足，R6 遗留）：`common.js` 新增 `scanXmlElements`（单遍、有界、无新依赖；注释/CDATA/PI/声明整体跳过，引号与 DOCTYPE 方括号感知，记录元素父子与内文区间）与 `parseRssEnvelope`（isHtml 按真实根元素/doctype 判定；结构错误含未闭合 rss/channel/item、多根、根非 rss、channel 缺失或重复、channel 外 item；条目取 channel 真实子级 item 的首现子元素内文，键名小写）。`news.js`：HTML 检测不再对全文做字符串匹配（description CDATA 含 `<html>` 不再误判整文档为 HTML 错误页）；存在条目但均无可用标题报解析错误；仅结构合法零条目报 `EMPTY_RESULT`。新增 fixture：缺 `</rss>`、未闭合 item、仅 description 无 title 三反例，channel 外 item、双根、根非 rss，CDATA 内 `<html>` 正文与伪 `<item>`/`<title>` 文字（不算条目/字段/错误信封），合法空 channel 与正常 feed 回归保留。

## 审查 round 1 修复记录（本次提交）

- R1（36kr 结果与业务范围绑定）：hot/search 重写为经 2026-09-29 真实只读 DOM 核验的区域选择器（见上表）；新增反例 fixture：全页仅推荐、榜单区域+侧栏推荐、真实空态、区域未就绪、目标类别不一致（含 nodata+卡片并存的矛盾态）。真实复跑 catalog/renqi/zonghe/shoucang 与 search（命中+真实空态）并核对每行实际所属区域。
- R2（HN read 补造未知字段）：改为 null/未知语义并新增回归（含真实 0 分保留）。
- R3（36kr 身份与 URL 校验）：`parseArticleId` 锚定完整官方路径并做安全整数校验；`normalizeArticleUrl` 用 URL 解析限定官方 host/protocol/path，列表跳过无效链接；新增 `/p/123abc`、`/foo/p/123`、外域、协议相对、前导零、超精度等反例。
- R4（后续对齐分类）：以固定来源目录与实际根 adapters 重算，见 `docs/opencli_clis_alignment_map.json`（11+4+164=179，互斥可复算）；修正 github/gmail 无包的错误断言，未读实现仅按名称标注待核查。
- R5（占位与归因）：fixture 中真实账号名替换为虚构值；文档不保留真实账号与资料；瞬时错误归因改为"原因未确定"；"13 项均通过"改为仅当次路径口径。
- R6（36kr RSS 错误文档与空态区分）：见偏差 1；新增标准 RSS 日期+CDATA、合法空 RSS、200 HTML/畸形 XML 回归。

## 逐项验收状态（round 1 修复后重新冻结）

| 命令 | fixture（vm 内真实 v2 bootstrap） | 真实 CLI → Bridge → Extension trace（本次重跑） | 自然语言验收 |
| --- | --- | --- | --- |
| hn top | 通过（预取上限、过滤、请求计数 31） | `6aba460b5ba8` | 未执行 |
| hn best | 通过 | `8fed90066479` | 未执行 |
| hn new | 通过 | `d2b3f6f4a783` | 未执行 |
| hn ask | 通过 | `6f093a62dc79` | 未执行 |
| hn show | 通过 | `49bd76397a54` | 未执行 |
| hn jobs | 通过（无 score/comments 投影） | `d5a9d351a96b` | 未执行 |
| hn search | 通过（URL/参数/枚举/空/错误） | `90ae658ca8dc`（真实结果映射） | 未执行 |
| hn read | 通过（树/缩进/截断标注/预算 200/部分失败/参数校验/**未知字段 null**） | `581321959193`（POST+评论树；作者/分值来自真实返回） | 未执行 |
| hn user | 通过（资料映射/不存在/用户名校验） | `cb7645234c41`（公开账号资料字段映射；按边界本文不记录账号与资料内容）；占位不存在用户返回 EMPTY `7005aafd24fb` | 未执行 |
| 36kr hot | 通过（四类榜单各自路由/上海日期/**区域绑定/类别核验/分区归属**/去重/超时、仅推荐、**延迟填充成功与持续空区域报错（dated/catalog 各一）**、类别不一致、验证码；round 2 起无空榜判定） | round 2 复跑：renqi `39a18b5b7209`、catalog `8fcddec40e71`（行属真实分区，board_url 为分区 dated 路由）；round 1 历史：catalog `812a2b2e7d97`、renqi `f6e4538e7dbe`、zonghe `f2deefdbf036`、shoucang `07076a7735ea` | 未执行 |
| 36kr news | 通过（CDATA/实体/**完整 ISO 日期**/120 字符摘要/HTTP、HTML/畸形与空 feed 区分/**结构反例：缺 `</rss>`、未闭合 item、仅 description、channel 外 item、双根、根非 rss**/**CDATA 伪标记不算条目/字段/HTML 错误页**） | round 2 复跑 `b9a68ab6eaf7`（date 为完整 ISO 时间）；round 1 历史 `089dc616530e` | 未执行 |
| 36kr search | 通过（编码/**结果区域绑定/无回退/nodata 空态**/仅推荐反例/矛盾态/超时） | 命中 `486c6a944e00`（真实卡片，date 空串）；真实空态 `5c4bddd17ae2` | 未执行 |
| 36kr article | 通过（**严格 ID/URL 反例**/800 截断/长度语义/缺标题与缺正文区分/超时） | `412b913d2367`（body_truncated=true，content_status 明示 partial，url 规范化） | 未执行 |

注：round 1 版本（冻结 `9670b9d2`）与 round 1 修复版（冻结 `66d75a58`）的旧 trace 因 R1/R6 及本轮行为变更仅作历史记录，不再代表当前实现；round 2 未复跑的 zonghe/shoucang trace 沿用 round 1 记录（本轮未改 dated 榜单路由，仅改等待与空态判定，renqi/catalog 已按新行为复跑）。

真实调用命令形态（公开构建产物）：

```powershell
node weworker/build/webcli-dist/webcli.cjs call news.ycombinator.com.top --limit=3
node weworker/build/webcli-dist/webcli.cjs call news.ycombinator.com.read --id=<真实id> --limit=3 --depth=2 --replies=2
node weworker/build/webcli-dist/webcli.cjs call 36kr.com.hot --type=renqi --limit=3
node weworker/build/webcli-dist/webcli.cjs call 36kr.com.article --id=<真实文章id>
```

## 聚焦验证记录（2026-09-29，round 2 修复后）

- `webcli/__tests__/opencli-news-wave2-adapters.test.js`：**71 项通过**（契约/清单一致性/bootstrap 注册/确定性 Skill/只读声明/域名声明；HN 列表、搜索、read 树与预算、未知字段 null 回归、user；36kr 榜单路由与区域绑定/分区归属/类别核验/**延迟填充成功与持续空区域报错（dated/catalog）**/仅推荐/未就绪反例、RSS **有界结构校验（未闭合/多根/channel 外 item/条目无可用标题）/CDATA 伪标记反例**/实体/完整日期/HTML 与畸形区分、搜索区域绑定/无回退/nodata 空态、文章严格 ID/URL 反例/规范化）。
- 回归：`opencli-batch-adapters` + `ctrip-adapter` + 宿主/适配器宿主/Bridge 重载共 5 文件 **185 项通过**；打包/Skill/Profile 相关 8 文件 67 项中 66 项通过。
- `extension-v2-loader.test.js` 有 1 项**基线既有失败**（`requires_confirmation:false` 字段与旧断言不一致），与本批无关（基线 82b1df1c 即失败，round 2 已在冻结 HEAD 复核仍失败，本轮未改 v2-loader），按边界未修改通用框架，留待 Codex 安排。
- 公开 `prepare-build.cjs`：18 个 host-managed 包；WebCLI bundle 重建成功（既有可选列名映射缺失警告不变），`builtin-adapters`/`webcli-dist` 内 36kr 产物已确认包含本轮修复。
- 打包 CLI `adapter validate`：两包通过；`adapterhub pack` 生成 `.adapt` 并 `validate` 通过：news.ycombinator.com 12 文件 sha256 `c6aae45f…dc8f701f7`（与 round 1 一致，本包本轮未改动）、36kr.com 7 文件 sha256 `23c4804d…f0b1dfba`（产物在仓库外临时目录，不发布）。
- 确定性 Skill 生成由测试覆盖（guidance 原文包含、两次生成逐字节一致）。
- 真实复验（round 2 行为变更后）：`36kr.com.news --limit=3` `b9a68ab6eaf7`、`36kr.com.hot --type=renqi --limit=3` `39a18b5b7209`、`36kr.com.hot --limit=3`（catalog）`8fcddec40e71`；业务字段（board/board_url 分区归属、完整 ISO date、120 字符 summary、url 规范化）逐行核对。

### 已知限制（不算通过的事项）

1. 36kr search 真实页面卡片不暴露日期（2026-09-29 复核仍无日期元素），date 返回空串；不补造、不猜。若需要日期需后续按真实 DOM 调整并复验。
2. 36kr hot round 1 真实复跑覆盖 catalog/renqi/zonghe/shoucang 四类与真实空搜索；round 2 行为变更后复跑 renqi/catalog 两类（覆盖 dated 与分区两条代码路径），zonghe/shoucang 沿用 round 1 trace，其余异常路径仅 fixture 覆盖。round 1 首次 catalog 调用遇宿主 tab 通道错误一次（trace `dc2f9fec9a56`），原参数重试成功（`812a2b2e7d97`）；**错误原因未确定**（不排除实现或环境因素），不将其归类为环境瞬态或上游缺陷，不写成包缺陷。
3. **36kr hot 不支持空榜判定**：榜单页面无已验证空态标记，“区域持续无条目”报渲染/结构异常而非空结果；若未来站点出现已验证空态选择器，需按真实 DOM 核验后再引入空榜判定。
4. 客户端聊天入口的自然语言验收（参数追问、ID 保留、截断口径说明）未执行。
5. `extension-v2-loader` 基线既有失败未修复（见上）。
6. 36kr 榜单/搜索的区域选择器基于 2026-09-29 真实 DOM；站点改版会使区域核验失败并显式报错（不降级为全页抓取），需按新 DOM 重新核验后再调整。

## 后续对齐路线（不声称全量已对齐）

机器可读映射：`docs/opencli_clis_alignment_map.json`。以固定 SHA `24136945847afbfad266c6c46a8cd335377f9112` 的 `clis/` 目录（排除 `_` 前缀辅助目录与 `test-utils.js`，共 **179** 个站点）与本仓库实际根 `adapters/` 目录双向重算，分类互斥、总数一致：

1. **已从 OpenCLI 迁入公开 v2 包（11 站，命令级对齐情况见各自清单）**：12306→12306.cn、zhihu→zhihu.com、youdao→note.youdao.com、51job→51job.com、boss→zhipin.com、dianping→dianping.com、douban→douban.com、douyin→douyin.com（14/16，draft/publish 未实现）、hackernews→news.ycombinator.com、36kr→36kr.com，及本轮 11 站合计。"有包"不等于"命令全对齐"；多数站点仍有登录态/写路径/自然语言验收缺口（见 `docs/opencli_batch_migration.md`）。
2. **已有 WeWorker 包、但包先于 OpenCLI 批次且未做命令级对齐盘点（4 站）**：bilibili→bilibili.com、jd→jd.com、juejin→juejin.cn、xiaohongshu→xiaohongshu.com。需逐命令盘点而不是重复建包。
3. **无 WeWorker 包（164 站）**：github、gmail、github-trending、reddit、wikipedia、arxiv、pubmed、google-scholar、bbc、reuters、bloomberg、eastmoney、xueqiu、weibo、v2ex、stackoverflow、npm、pypi、dockerhub、imdb、booking、brave、duckduckgo 等。其中部分名称疑似桌面/应用集成（chatgpt-app、claude、codex、cursor、gemini、grok、kimi、deepseek、qwen、doubao、yuanbao、mercury、minimax、manus、chatwise、qoder、trae-cn、trae-solo、discord-app、wechat-channels、xiaoyuzhou、weread、flomo、mubu 等）——**这些实现本轮未读，仅按名称标注待核查，不断言其形态**，纳入前必须逐站核验可行性。
4. **下一批建议（仅规划，不实施）**：优先纯公开 API、只读、低风险信息类（如 github-trending、arxiv、wikipedia、duckduckgo/brave、reuters/bbc）延续本批模式；随后处理第 2 类 4 站的命令对齐盘点；疑似桌面/应用类单独开可行性分类评审。

## 边界与安全

- 未修改内部仓库、通用框架、Extension manifest 权限或全局 CLI；未触碰旧迁移目录与 Archive；未重置/清理/删除文件；未改密钥/.env/CI/CD/数据库；未推送、合并、发版。
- 未执行业务写操作；两包无 write 命令、无确认门需求。真实调用均为只读。未公开真实用户数据/日志；本文 trace 为本地命令 trace id，不含账号数据；fixture 一律使用虚构占位账号。
- `docs/api_auto_exploration_technical_article.md` 为用户原未跟踪文章，未读取、未添加提交。
