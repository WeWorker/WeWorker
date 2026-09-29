# OpenCLI 新闻类 wave2 迁移与验收记录（Hacker News + 36氪）

日期：2026-09-29。本批迁移 Hacker News 全部 9 项与 36氪全部 4 项来源命令，共 13 项全部接入公开 v2 包；13 项均通过真实 WebCLI → Bridge → Extension 只读调用。客户端聊天入口的自然语言验收未执行，不称整体完成。

## 来源与许可

- 来源固定为 `jackwener/OpenCLI` 提交 `24136945847afbfad266c6c46a8cd335377f9112`（本地参考目录已核验 `git rev-parse HEAD` 一致）的 `clis/hackernews/`（ask/best/new/top/show/jobs/search/read/user 及其测试）与 `clis/36kr/`（hot/news/search/article 及其测试）。来源仓库 `LICENSE` 与 `package.json` 均为 Apache-2.0（Copyright 2025 jackwener），两目录无文件级额外许可或第三方资源。
- 许可证沿用既有 `docs/third_party/OpenCLI-LICENSE.txt`，桌面包继续经 `weworker/package.json` 的 `extraResources` 复制为 `licenses/OpenCLI-LICENSE.txt`，无新增文件。每个派生文件头保留来源 SHA 与修改说明。
- 来源仅声明式依赖 `@jackwener/opencli/registry`、`@jackwener/opencli/errors`（注册与错误类型），未复制 OpenCLI 运行时、pipeline 引擎或其他依赖；未新增 npm 依赖，未新建 Runner。

## 包与命令

根 v2 包 `adapters/news.ycombinator.com`（0.1.0，9 命令，全 read）与 `adapters/36kr.com`（0.1.0，4 命令，全 read）。两包均加入 `weworker/build-profile.json` 公开 Profile（现 18 个 host-managed 包）。机器可读 13 项清单：`docs/opencli_news_wave2_inventory.json`（含参数、默认值、数据源、fixture/真实 trace/自然语言状态）。

| 命令 | 参数与默认值（=来源） | 执行方式 | 关键语义与限额 |
| --- | --- | --- | --- |
| `news.ycombinator.com.top/best/new/ask/show` | `limit=20` | 后台 API（backend_fetch，禁重定向、trace 脱敏） | 预取 `min(limit+10,50)` 个 id 再过滤 deleted/dead/无标题，实际返回 ≤50；空/全失效报 EMPTY_RESULT |
| `news.ycombinator.com.jobs` | `limit=20` | 同上 | 按来源无 score/comments 列 |
| `news.ycombinator.com.search` | `query`（必填）、`limit=20`、`sort=relevance|date` | Algolia 公开接口 | tags=story、hitsPerPage=limit；query/tags 经 URLSearchParams 严格编码；id 来自 objectID |
| `news.ycombinator.com.read` | `id`（必填纯数字）、`limit=25`、`depth=2`、`replies=5`、`max-length=2000`（≥100） | 后台 API 树遍历 | POST 行 + L0/Ln 缩进评论；`[+N more replies]`/`[+N more top-level comments]` 截断标注；**单次调用条目请求预算 200**，耗尽输出明确标注行；deleted/dead/null 跳过；个别请求失败计数标注，不冒充完整 |
| `news.ycombinator.com.user` | `username`（必填） | 后台 API | 用户名 `^[A-Za-z0-9_-]{1,32}$` 校验后 encodeURIComponent；不存在报 EMPTY_RESULT；about 保留来源原始 HTML |
| `36kr.com.hot` | `limit=20`（≤50）、`type=catalog|renqi|zonghe|shoucang` | 页面 DOM + 宿主导航续执行 | catalog 走 `/hot-list/catalog`；renqi/zonghe/shoucang 走 `/hot-list/<type>/<UTC+8 当日>/1` 各自官方榜单页，不降级冒充；每行附 type/board/board_url 供核对 |
| `36kr.com.news` | `limit=20`（≤50） | 后台 API（RSS `https://www.36kr.com/feed`） | summary=描述前 120 字符；HTTP 失败明确报错（来源返回 `[]` 的行为未保留）；UA 标识改为 `WeWorker-WebCLI/1.0` |
| `36kr.com.search` | `query`（必填）、`limit=20`（≤50） | 页面 DOM + 导航续执行 | 关键词严格编码；渲染超时（≈5 秒有界轮询）与真正无结果分别报 COMMAND_EXEC / EMPTY_RESULT；date 缺失为空串 |
| `36kr.com.article` | `id`（数字或 36kr.com `/p/` URL） | 页面 DOM + 导航续执行 | 来源声明 INTERCEPT 但实际只读 DOM，未保留拦截器；正文按来源截断 **800 字符**，并以 body_length/body_truncated/content_status 明确截断与完整性，不把摘要或截断文本当全文 |

域名声明：HN 包 `match=[news.ycombinator.com]`，API 域 `hacker-news.firebaseio.com`、`hn.algolia.com` 放在 `runtime_allowed_hosts`（仅限受限 backend_fetch，不作为导航目标）；36kr 包仅 `www.36kr.com`。数值/布尔/ID 均在包内校验（CLI 字符串数字接受，小数/越界/类型错误拒绝），未改全局 CLI。

### 与来源的有意偏差（均已记录在清单 data_source）

1. 36kr news：HTTP 失败从静默 `[]` 改为显式 `HTTP_ERROR`；UA 标识更名。
2. 36kr article：不再从任意字符串剥离数字猜 ID（来源 `replace(/\D/g,'')` 行为移除），只接受纯数字或 36kr.com `/p/` URL。
3. HN 列表 limit 接受 1–100（来源无上限），但保留来源预取上限 50 的实际约束并在 manifest/guidance 说明。
4. HN read/列表的空结果从来源的空数组改为显式 EMPTY_RESULT 错误，避免"返回空数组即成功"。

## 逐项验收状态

| 命令 | fixture（vm 内真实 v2 bootstrap） | 真实 CLI → Bridge → Extension trace | 自然语言验收 |
| --- | --- | --- | --- |
| hn top | 通过（预取上限、过滤、请求计数 31） | `517c7a99cdb3`（另有一次瞬时 FETCH_ERROR `6b81bfb45001` 后重试成功） | 未执行 |
| hn best | 通过 | `eebdf17eb4d0` | 未执行 |
| hn new | 通过 | `a306d46aa80b` | 未执行 |
| hn ask | 通过 | `76fe59dcee29` | 未执行 |
| hn show | 通过 | `d94458b9cb07` | 未执行 |
| hn jobs | 通过（无 score/comments 投影） | `d8aa8a384a7c` | 未执行 |
| hn search | 通过（URL/参数/枚举/空/错误） | `ecb052eae352`（query=rust，3 条真实结果） | 未执行 |
| hn read | 通过（树/缩进/截断标注/预算 200/部分失败/参数校验，含来源上游用例语义复刻） | `aabddf036f32`（POST+L0/L1+`[+N more replies]`+`[+38 more top-level comments]`） | 未执行 |
| hn user | 通过（资料映射/不存在/用户名校验） | `344606c9715d`（pg：karma/created/about） | 未执行 |
| 36kr hot | 通过（四类榜单各自路由/上海日期/去重/超时与不可解析区分/验证码） | catalog `ba407982df3b`；renqi `2011130725fc`（board_url 为当日 dated 路由）；首次调用遇宿主 tab 通道瞬时错误 `0d88b3dd8d02`，重试成功 | 未执行 |
| 36kr news | 通过（CDATA/日期/120 字符摘要/HTTP 与空 feed 区分） | `6719af0ceb96`（3 条真实资讯） | 未执行 |
| 36kr search | 通过（编码/标题卡/回退/超时与空结果区分） | `76e428975b42`（真实页卡片未暴露 date，返回空串而非补造） | 未执行 |
| 36kr article | 通过（ID 校验/800 截断/长度语义/缺标题与缺正文区分/超时） | `3b39af9d7b6d`（正文 800/8073 字符，body_truncated=true，content_status 明示 partial） | 未执行 |

真实调用命令形态（公开构建产物）：

```powershell
node weworker/build/webcli-dist/webcli.cjs call news.ycombinator.com.top --limit=3
node weworker/build/webcli-dist/webcli.cjs call news.ycombinator.com.read --id=<真实id> --limit=3 --depth=2 --replies=2
node weworker/build/webcli-dist/webcli.cjs call 36kr.com.hot --type=renqi --limit=3
node weworker/build/webcli-dist/webcli.cjs call 36kr.com.article --id=<真实文章id>
```

## 聚焦验证记录（2026-09-29）

- 新增 `webcli/__tests__/opencli-news-wave2-adapters.test.js`：57 项通过（契约/清单一致性/bootstrap 注册/确定性 Skill/只读声明/域名声明；HN 列表、搜索、read 树与预算、user；36kr 榜单路由、RSS、搜索、文章）。
- 回归：`opencli-batch-adapters` + `ctrip-adapter` 共 157 项通过；打包/Skill/Profile 相关 9 文件 122 项通过。
- `extension-v2-loader.test.js` 有 1 项**基线既有失败**（`requires_confirmation:false` 字段与旧断言不一致），与本批无关（本轮未改 v2-loader，基线 82b1df1 即失败），按边界未修改通用框架，留待 Codex 安排。
- 公开 `prepare-build.cjs`：18 个 host-managed 包；WebCLI bundle 重建成功（既有可选列名映射缺失警告不变）。
- 打包 CLI `adapter validate`：两包通过；`adapterhub pack` 生成 `.adapt` 并 `validate` 通过：news.ycombinator.com 12 文件 sha256 `6e42d8f7…93d648`、36kr.com 7 文件 sha256 `247d8800…e1e1260`（产物在仓库外临时目录，不发布）。
- 确定性 Skill 生成由测试覆盖（guidance 原文包含、两次生成逐字节一致）。

### 已知限制（不算通过的事项）

1. 36kr search 真实页面卡片未暴露日期给当前选择器，date 返回空串；不补造、不猜。若需要日期需后续按真实 DOM 调整选择器并复验。
2. 36kr hot 首次真实调用遇宿主 tab 通道瞬时错误（扩展消息通道关闭），重试成功；属环境瞬态，不掩盖、不写成包缺陷。
3. HN top 一次真实调用遇上游瞬时 FETCH_ERROR，重试成功；guidance 已规定失败保留 trace、不盲目重试。
4. 客户端聊天入口的自然语言验收（参数追问、ID 保留、截断口径说明）未执行。
5. `extension-v2-loader` 基线既有失败未修复（见上）。

## 后续对齐路线（分类，不声称全量已对齐）

以固定 SHA `24136945847afbfad266c6c46a8cd335377f9112` 的 `clis/` 目录为基准（排除 `_shared`、`_atlassian`、`test-utils.js`）：共 **179** 个站点目录。

1. **已迁入公开 v2 包（11 站）**：ctrip、12306、zhihu、youdao、51job、boss、dianping、douban、douyin、hackernews、36kr。其中**命令级仍未全对齐**：douyin 14/16（draft/publish 未实现）；多数站点仍有登录态/写路径/自然语言验收缺口（见 `docs/opencli_batch_migration.md`）。"有包"不等于"命令对齐"。
2. **已有 WeWorker 包、但未与 OpenCLI 命令对齐（6 站）**：bilibili、github、jd、juejin、xiaohongshu、gmail(mail.google.com)。这些站点的既有包命令集与 OpenCLI 定义不同，属"有包、命令未对齐"，需逐命令盘点而不是重复建包。
3. **未迁移的网页类站点（约 142 个，名称层面分类）**：如 github-trending、reddit、wikipedia、arxiv、pubmed、google-scholar、bbc、reuters、bloomberg、eastmoney、xueqiu、weibo、v2ex、stackoverflow、npm、pypi、dockerhub、imdb、booking、brave、duckduckgo 等。其中部分为公开 API（适合先迁后台 API 命令），部分为强登录 DOM 站（需会话与更重验收）。
4. **桌面/应用或非网页集成（约 26 个，名称启发式，需逐站确认）**：chatgpt(-app)、claude、codex、cursor、gemini、grok、kimi、deepseek、qwen、doubao(-app)、yuanbao、mercury、minimax、manus、chatwise、qoder、trae-cn、trae-solo、discord-app、wechat-channels、xiaoyuzhou、weread、flomo、mubu。这类可能需要宿主/Toolkit 侧能力而非 Extension 页面 Runner，纳入前必须先做可行性分类。
5. **下一批建议（仅规划）**：优先纯公开 API、只读、低风险新闻/信息类（如 github-trending、arxiv、wikipedia、duckduckgo/brave、reuters/bbc）延续本批模式；随后处理"已有包"6 站的命令对齐盘点；桌面/应用类单独开分类评审。不在本批实施。

## 边界与安全

- 未修改内部仓库、通用框架、Extension manifest 权限或全局 CLI；未触碰旧迁移目录与 Archive；未重置/清理/删除文件；未改密钥/.env/CI/CD/数据库；未推送、合并、发版。
- 未执行业务写操作；两包无 write 命令、无确认门需求。真实调用均为只读。未公开真实用户数据/日志；本文 trace 为本地命令 trace id，不含账号数据。
- `docs/api_auto_exploration_technical_article.md` 为用户原未跟踪文章，未读取、未添加提交。
