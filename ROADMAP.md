# WeWorker Roadmap

- 2026-10-15（API 探索优化 PR 整理）：从最新 develop（783e6dbc）建立 codex/api-exploration-optimization，仅迁入探索候选来源/结束条件、输出包装层与业务错误判定、补采回放保留、已有站点包增量生成及默认 auto 优化；未带入演示分支的模型、机器人、导航或版本变更。默认先生成并验证，具体草稿错误最多一次限时 60 秒模型修复；探索预装证据/指引、显式确认目标并结束分析，分析限时 180 秒。独立锁定依赖和 public 33 包准备后，WebCLI 33 文件/241 项、Backend 5 文件/46 项、Renderer 7 项、扩展 35 项共 329 项通过；Backend 类型检查、Renderer 与 Backend/Bridge/WebCLI 构建、34 个 JavaScript 文件语法及差异检查通过。新工作区首轮漏准备资源导致测试失败；构建与测试并行阶段还出现计划缺失和 Windows 临时目录清理失败，二文件独立复查与构建完成后完整聚焦重跑均通过。集成分支真实两轮约 71.439/85.731 秒及 7 次新工具查询只作为迁入前证据，本 PR 尚未重跑完整客户端、真实网站、macOS 或安装包；无 99.999% 结论。操作与边界见 docs/api_exploration_local_acceptance.md、docs/api_exploration_reliability_plan.md。

- 2026-10-14：侧栏告警改为扩展状态旁的固定感叹号入口，移除占用侧栏高度的版本/端口长提示；点击入口显示告警列表，点击条目打开详情弹窗，保留扩展指引、按系统区分的端口查询命令和通道错误详情。入口在无告警时隐藏但保留位置，列表及详情通过浮层展示。聚焦单测 7 项、Renderer 构建及差异检查通过；Chrome/Playwright 模拟状态验证告警出现/消失与开列表不改变侧栏几何位置、版本与通道详情、窄窗口防越界和 Escape 关闭，无运行时错误。

- 2026-10-14：网站探索模型的连接成功提示采用主题绿色，与按钮保持和上方表单一致的 14px 间隔；标题“已连接”增加绿色状态点，检测中或失败时不显示绿点。模型连接单测 2 项、Renderer 构建及差异检查通过；本地 Chrome/Playwright 模拟响应验证了颜色、间距、成功/失败状态、输入保留和手动折叠，无运行时错误。未调用真实模型接口。

- 2026-10-14：修复模型设置中“重新检测已保存配置”成功后自动收起的问题；重新检测仅更新连接结果，保留展开状态及未保存的表单输入。通过模型连接单测 2 项、Renderer 构建与差异检查；使用本地隔离组件及模拟响应完成 Chrome/Playwright 交互验证，覆盖成功、失败、重试、输入保留、按钮位置不变和手动收起，无运行时错误。未调用真实模型接口。

- 2026-10-12：发布流程改为正式版本 Tag `v<major>.<minor>.<patch>` 推送后自动构建 Windows x64、macOS arm64 与 macOS x64 安装包，并创建 Draft Release；普通代码 push 不再触发 CI，代码检查保留在 PR 与手动触发。新增 `docs/RELEASE.md` 固化发布步骤。桌面端、安装包、浏览器扩展与官网图标统一替换为项目 logo。已完成配置静态检查、Release workflow YAML 解析、图标资源尺寸校验；完整 GitHub Actions 构建需推送 PR/Tag 后在远端验证。

- 2026-10-08（wave4提交）：整理头条0.1.1、什么值得买/arXiv 0.1.0及协作交接文档提交至codex/opencli-wave4，目标develop。8项真实数据/身份样例及头条文章空态通过；专项130项、相关回归148项、构建与包校验通过。无关文章未纳入，未合并或发版。

- 2026-10-08（协作交接）：核对17个已迁入来源目录、4个有包未对齐、158个无根v2包；整理站点范围、验收缺口、wave4未提交状态、开放PR重叠及建议分工，见docs/opencli_migration_handoff_20261008.md。未向同事发消息或分派任务。

- 2026-10-08（头条0.1.1修复）：恢复WeWorker Bridge连接，用只读诊断核实当前服务器身份API和作品列表空态，whoami登录身份及articles第1页明确空列表实测通过；不代表有作品/多页路径通过。临时诊断已移除；专项130项通过，无真实写操作。详情及trace见docs/opencli_wave4_migration.md。

- 2026-10-08（头条登录后）：whoami 未识别后台身份字段、articles 未解析文章，均未通过；不能推断会话失效或账号无作品。修正身份结构未知被误报为过期会话的问题，生成包专项121项通过。浏览器检查工具因 Codex auth token unavailable 阻塞页面核验，保留失败 trace；未执行写操作。

- 2026-10-08（wave4）：按授权合并 PR #41，基于最新 develop 202ec8ae 迁移今日头条5项、什么值得买1项、arXiv4项，共10项；7项公开读取真实样例通过，头条whoami导航超时、articles需要登录，login未执行。专项120项、相关回归138项、公开23包prepare/WebCLI构建及三包.adapt校验通过。来源仍2413694，目录映射17+4+158=179；仅公开站点包/测试/Profile/文档变更，无通用框架或内部仓库变更。本批尚未提交PR，未执行真实写操作。详见docs/opencli_wave4_migration.md。

- 2026-10-08：重新 fetch 核验 OpenCLI main 仍为 2413694；迁移分支盘点 179 个来源目录：14 已有迁移记录、4 有包未对齐、161 无包。PR #41 尚未合并，目录覆盖不代表主线发布或完整验收。完整缺口、特殊目录及下一批建议见 docs/opencli_remaining_sites_20261008.md；本轮只盘点，未新增站点实现。

- 2026-09-30（小红书登录后验收）：2.0.1 修复隐藏重复筛选项、签名详情链接规范化跳转；whoami／creator-profile／七天统计／feed／search／note／comments／user 共 8 项真实数据样例通过，另 drafts 空列表路径通过。评论实测 3 条顶层＋12 条回复。专项 214 项、相关回归 105 项及构建／包校验通过。创作者作品响应缺 note_infos、通知捕获 0 响应仍未通过，均不误报为空；未执行真实写操作。样例 trace 和限制见 docs/opencli_xiaohongshu_migration.md。

- 2026-09-30：直接迁移 GitHub OpenCLI 最新 main（核验 SHA 2413694）小红书全部 25 个来源命令，包升级 2.0.0；保留 7 个旧名／本地能力，旧读取改接新实现。211 项来源／bundle 集成测试通过，新增有界原生文本／按键 helper 及测试同步内外仓；公开 prepare 20 包、WebCLI 构建及 .adapt 校验通过。真实 whoami、search 被登录拦截，未验收业务数据和真实写操作。详情见 docs/opencli_xiaohongshu_migration.md。

- 2026-09-30：Codex直接迁移Wikipedia五项与GitHub Trending一项（来源2413694），公开v2包/Profile共20包；新增36项及相关8文件238项测试、prepare/bundle、两包.adapt校验通过。语言/域名、摘要截断、全文段落、UTC榜单日期及周期语义已覆盖。真实六项调用未验收通过：Wikipedia连接失败，GitHub传输回退错误，保留trace不冒充成功；自然语言未执行。179目录映射更新13+5+161。无内部/通用框架变化、未推送。见docs/opencli_reference_wave3_migration.md。

- 2026-09-29（审查 round 2 修复）：Codex 增量审查后修复剩余 2 项并重新冻结：36kr hot 空榜误报（等待条件从“容器存在”改为“可信区域内出现可解析行”，新增延迟填充成功与持续空区域报错 fixture 各 dated/catalog 一例；页面无已验证空态标记，取消空榜判定，持续无条目一律按渲染/结构异常报错）；36kr news RSS 信封改为有界结构扫描（未闭合/错配 rss/channel/item、多根、根非 rss、channel 外 item、条目存在但均无可用标题均报解析错误；CDATA 内伪标记不算条目/字段/错误信封，HTML 检测按真实根元素/doctype 判定，description CDATA 含 <html> 不再误判）。聚焦测试 71 项、八站+携程+宿主 5 文件 185 项、打包/Skill/Profile 8 文件 66/67 项通过（1 项为基线既有 v2-loader 失败，冻结 HEAD 复核仍在）；prepare/bundle 重建后 hot(renqi/catalog)/news 三次真实链路复跑通过并更新 trace；36kr.com .adapt sha256 变更为 23c4804d…、HN 包未变。已知：hot 不支持空榜判定；自然语言验收未执行。见 docs/opencli_news_wave2_migration.md。

- 2026-09-29（审查 round 1 修复）：Codex 审查 wave2 后修复 R1-R6 并重新冻结：36kr hot/search 改为经真实 DOM 核验的榜单/结果区域绑定（页面标题核验榜单、catalog 按真实分区归属、无全页回退、空态需页面证据），HN read 缺 author/score 输出 null 不补造，36kr 文章 ID/URL 锚定官方路径并防精度丢失，RSS 区分 HTML/畸形与合法空且 date 输出完整 ISO，fixture 全部改用占位账号，后续对齐分类改为可复算映射（docs/opencli_clis_alignment_map.json，11+4+164=179）。聚焦测试扩至 68 项、八站+携程回归 157 项、打包/Skill/Profile 8 文件 49/50 项通过（1 项为基线既有 v2-loader 失败）；重新 prepare/bundle 后 13 项全部重跑真实链路（四类榜单+真实空搜索各一次，trace 已更新）。已知：36kr 搜索卡片仍无日期元素；自然语言验收未执行。见 docs/opencli_news_wave2_migration.md。

- 2026-09-29：OpenCLI 新闻类 wave2：新增 Hacker News 9 项与 36氪 4 项公开 v2 包（news.ycombinator.com、36kr.com，全 read），13 项均通过真实 WebCLI→Bridge→Extension 只读调用并记录 trace；HN read 保留树/截断语义并加 200 条目请求预算，36kr article 明示 800 字符截断与完整性口径，hot 四类榜单各走官方路由不降级。新增聚焦测试 57 项、八站+携程回归 157 项、打包/Skill/Profile 122 项通过；公开 prepare 18 包、WebCLI 重建、两包 .adapt 校验通过。36kr 搜索真实页未暴露日期保持空串；客户端自然语言验收未执行；extension-v2-loader 有 1 项基线既有失败未处理。见 docs/opencli_news_wave2_migration.md 与 13 项机器可读清单、后续对齐路线。

- 2026-09-29：继续处理 BOSS 搜索与 12306 订单。BOSS 0.1.1 显式主世界只读请求及跨页/城市/学历经验筛选真实通过；12306 0.1.1 修复旧登录页误报，核验服务器会话与官方订单页后，成功响应无 data 的真实空状态已通过；不等于未出行/历史订单为空，有订单提取仍待验证。两站及导航聚焦116项通过；未修改内部仓库或执行业务写操作。

- 2026-09-29：整理公开迁移 PR：携程 0.3.6 与八站 81/83 命令、通用导航/Skill/记忆/二进制响应一起提交；网络捕获通用测试改用 example.com。提交前 WebCLI 198、Backend 40、扩展 30、Profile/打包 6 项通过，公开 16 包 prepare 与八包 .adapt/Skill 校验通过。抖音 draft/publish 未实现，BOSS 搜索、12306 订单及完整自然语言验收仍未通过；真实证据见迁移文档。未合并或发版。

- 2026-09-28：源码客户端重启后，豆瓣单张WebP及知乎回答Markdown+7张JPEG真实落盘通过，文件格式和相对引用核验通过。豆瓣默认Rb页面标题实际为剧照，不宣称海报分类通过；增加requested_type/page_title和业务指导。12306订单响应仍缺列表，保持未知，并增加明确空状态与未知响应区别测试。本轮聚焦3组159项与公开WebCLI构建通过，仅公开站点包/测试/文档改动，未推送。

- 2026-09-28：登录后继续OpenCLI八站迁移：知乎/点评/豆瓣/抖音/51job及12306账号只读多项真实通过；修复51job与BOSS页面主世界请求，新增知乎和豆瓣download，累计81/83项接入。知乎Markdown真实落盘5117字节，图片下载待重启源码客户端加载新Bridge。通用有界base64响应同步内外，公开224项、内部通用23项通过；BOSS搜索和12306订单仍未通过，抖音draft/publish仍待实现。详见docs/opencli_batch_migration.md。

- 2026-09-28：公开迁移 OpenCLI 八站 v0.1.0（SHA 2413694），83 项来源命令中 79 项接入 v2，4 项文件导出/抖音上传发布待实现；八包 guidance、完整清单与人工验收步骤已补齐。聚焦 193 项、Profile/打包 6 项及八包 .adapt/Skill 校验通过，公开 WebCLI 已构建。真实 12306 四项查询、豆瓣 Top250、有道公开笔记成功，其余站点仍有登录、验证、导航边界或捕获阻塞，不能称八站完整验收。仅公开包/Profile/站点测试与文档改动，内部原工作区保留。见 docs/opencli_batch_migration.md。

- 2026-09-28：公开携程 0.3.6 区分船票页面无信息状态与渲染超时，避免同参数盲目重试或推断无船班。71 项聚焦测试通过；船票有数据链路仍待真实验收。仅携程包修改，无通用架构变化。

- 2026-09-28：公开携程 0.3.5 根据卡片产品类型筛选自由行，排除 package 页面混排的私家团，增加产品类型和出发地原文。一次实测返回三条自由行，68 项聚焦通过；通用框架无改动。

- 2026-09-28：公开携程 0.3.4 修复 tour/package 被站点追加 startcity 后的导航循环，tour 实测一次返回 3 条。内外同步记忆归因规则，禁止仅凭超限/超时判定暂态环境故障。相关回归通过，package 真实验收仍待完成。

- 2026-09-28：长期记忆召回标注为历史经验，明确当前用户要求、版本化 Skill 与本轮证据优先；记忆生成禁止把临时超时写成永久跳过工具的流程。内外同步，相关 48 项测试分别通过。公开携程 0.3.3 区分出发/到达航站楼，50 项携程测试通过。

- 2026-09-28：携程 0.3.2 往返航班改读真实 batchSearch 双程与组合报价，修复旧 DOM 卡片等待超时；增加去返日期/路线校验、经停信息，65 项聚焦测试通过，实际一次调用返回三组往返报价。仅公开携程包变化，通用框架未改。

- 2026-09-28：统一派生 Skill 与旧版 Skill 生成器的参数指引，普通参数优先 `--key=value`，JSON 仅用于复杂字段或兼容兜底，移除逐工具整包 `--args` 示例，避免 PowerShell 引号丢失导致首轮失败。内外同步并更新生成回归测试。

- 2026-09-28：页面导航续执行框架同步内外仓库：自动开页、等待、重注入，同一调用返回最终结果；写操作禁止导航后重放、声明域名与包摘要校验。派生 Skill 修正开页说明，后台请求补齐禁止重定向及日志脱敏开关。设计与边界见 `docs/adapter_navigation.md`。公开携程 0.3.0 增加人工 guidance 和景点目的地解析，贵阳景点/酒店单次调用实测通过；完整产品与自然语言验收仍待完成。

- 2026-09-28：修复携程 whoami 已登录误判：保留旧 login_uid 兼容，同时接受 cticket、DUID 与 IsNonUser=F 完整组合；游客标记和不完整组合拒绝，个人资料 Cookie 不能单独证明登录。继续使用受限 chrome.cookies 后台读取，无需标签页或 debugger，不返回会话凭据。包升级 0.2.2，携程聚焦 47 项、包校验和公开 prepare 通过；已连接扩展实际 whoami 返回 logged_in=true。该结果表示本地浏览器登录标记识别成功，不等于服务器会话有效性验证。

- 2026-09-28：修复携程数字参数拒绝 CLI 字符串的问题，包升级为 0.2.1。包内共用整数解析接受十进制数字字符串，拒绝小数、空值、布尔值、数组和不安全整数；联想 limit 与页面 limit/数字 ID 共用此逻辑，WebCLI 不新增类型转换。携程聚焦 39 项、包校验和公开 Profile prepare 通过。通过本地 CLI 与已连接扩展实际执行 search、hotel-suggest（limit=5），均成功返回 5 条；这不代表客户端聊天入口和其余页面命令已全部验收。

- 2026-09-24：架构 PR #40 合入 develop 后，OpenCLI 迁移分支同步最新主线；解决重叠改动，保留原有未提交的携程迁移工作。集成聚焦 WebCLI 82 项、扩展路由 19 项通过，公开 Profile 8 包 prepare 通过；真实站点验收仍待继续。

- 2026-09-24：修正携程联想查询被错误路由到网页标签页的问题：`search` 和 `hotel-suggest` 改走既有 Extension 后台 API Runner，不再要求预先打开携程；`whoami` 改走后台 Cookie 检查，也不要求携程标签页。后台请求禁跨站重定向和浏览器回退，并隐藏 trace 中的查询及响应体。`open_browser` 白名单补充有效 v2 包域名，供其他页面命令使用。WebCLI 聚焦 69 项、扩展路由 17 项、携程包校验通过；两种联想查询经同一 Node 请求路径匿名只读实测各返回 HTTP 200/15 条。运行中的客户端/扩展尚未更新到此源码，完整客户端调用与其余真实站点命令仍待验收。

- 2026-09-23：OpenCLI 携程迁移第二批完成本地实现：固定来源 SHA `8271afc67e8504bda94c147f446ee29775d08274`，将剩余 13 项接入根 v2 包，累计 15 个命令（14 read、1 write）。分类为业务数据 DOM 8、API 2、Cookie/导航 2、SSR 2、网络响应 1；单程航班在既有 Extension Runner 内增加受限响应捕获，没有旁路 Runner 或 Toolkit 改动。登录按页面导航边界改为确认后打开官方页、人工完成后以 `whoami` 验证。Ctrip/mock 与包聚焦 61 项、WebCLI 全量 83 文件/597 项、扩展加载器/运行时 16 项、Profile/打包 6 项全部通过；公开预处理成功，内建包和 CLI 均发现 15 命令。真实携程页面、测试账号登录/验证码、live 只读查询、完整安装包及 macOS 仍未验收，详见 `docs/opencli_ctrip_migration.md`。

- 2026-09-23：OpenCLI 携程迁移第一批（来源 SHA 8271afc）：核查 Apache-2.0 与 15 个来源命令，根 v2 包及公开 Profile 加入两个只读联想命令；其余 13 项页面、登录及网络捕获命令逐项记录在 `docs/opencli_ctrip_migration.md`，不算完成。WebCLI 83 文件 566/566、扩展加载/运行时 14/14、构建 Profile/打包聚焦 6/6 通过；公开 Profile 预处理与 CLI 帮助确认 2 命令可发现。真实携程与登录验收未执行。

- 2026-09-24：按已审阅策略更新 7 个公共 Adapter 的写操作确认配置，并同步 v2 bootstrap 的调用级旧确认兼容处理；read 命令不自动获得兼容标志，调用参数与共享运行时不被修改。聚焦 6 文件 76 项通过，公开 Profile 7 包 prepare 通过。 未执行真实业务写操作；客户端需重启、扩展需重载后验收。

- 2026-09-24：命令确认策略与写操作分类分离：v2 manifest 支持布尔 `requires_confirmation`，未配置的写命令仍默认需确认；CLI、Bridge、Extension、bootstrap、帮助与派生 Skill 同步采用包内策略。关闭安装包写确认视为额外权限变更。两仓聚焦策略/路由/Skill 测试、Backend TypeScript 和 Profile prepare 通过；未执行真实写操作。配置说明见 `docs/adapter_confirmation_policy.md`。

- 2026-09-24：修复后台调用被 Adapter 刷新中断的生命周期竞争：心跳握手仅确认连接，不重复发送初始目录快照；刷新关闭 offscreen 文档前等待公共执行队列。聚焦回归 31/31 通过。内部开发扩展重建、重载后真实只读查询成功返回，未执行写操作；运行中的 Bridge 心跳优化待客户端重启加载。

- 2026-09-24：修复托管后台 Adapter 查询已完成却被 Chrome `No current offscreen document` 清理错误覆盖的问题；已消失文档的清理不会覆盖原始结果，下一次调用仍创建独立文档。`open_browser` 白名单同时纳入有效 v2 包网站，停用包不会获得许可。聚焦测试 25/25 通过。真实客户端与浏览器扩展仍需更新后复验。

- 2026-09-24：v2 Adapter 增加包内可选 `guidance.md` 与 `manifest.discovery_terms`，把人工维护的工具选择、调用顺序和结果解释纳入当前包摘要与运行时派生 Skill；`.adapt` 读取和内置 Profile 打包同步支持。B 站包迁入导航重试、收藏夹选择等旧 Skill 经验并升级到 1.0.1。公开 Profile prepare、实际 `.adapt` 打包、npm dry-run、架构相关 WebCLI 8 文件 83 项通过；先前并发全量时超时的 3 文件 29 项顺序重跑通过。与内部仓库 13 个公共文件逐字节一致。完整 WebCLI 全量未顺序重跑，真实站点未验收。设计见 `docs/adapter_guidance.md`。

## 当前阶段

WeWorker 正在完成开源发布前的仓库清理与验证。当前保留 Electron 桌面端、React Renderer、TypeScript Backend、WebCLI、浏览器扩展、公开网站 Adapter，以及内嵌的网站探索agent源码。

## 已完成

- 移除仅面向内部系统的 Adapter、测试、快捷查询路由、发布脚本、部署说明和演示材料。
- 扩展 Adapter 注册表与构建配置已收敛到仓库中实际保留的公开网站 Adapter。
- 移除源码中的固定指标服务地址和固定访问令牌；指标上报改为显式环境配置并默认关闭。
- 内部域名、私网 IP 和组织名称已从保留的代码与文档中匿名化或移除。
- 首次开源版本已统一为 `1.0.0`，公开仓库身份统一为 `WeWorker/WeWorker`。
- 根更新日志与应用内更新日志已重置为仅记录首次公开版本 `1.0.0`。
- 浏览器扩展的公开名称统一为 `WeWorker Browser Adapter`，公开链接不再指向旧项目地址。
- 根 README 已按当前真实架构、启动命令、安全边界和发布状态重写。
- 20 个目标网站清单已保留并增加“已实现／开发中／规划中”状态；Gmail 和诺诺网发票作为补充集成单独记录。
- 贡献指南已改为基于 `main` 的 GitHub Flow，并补充真实检查命令、Adapter 贡献要求和本地敏感信息自检规则。
- 已新增 Git 工作流文档，明确 PR、受保护分支、受控敏感信息检查、Squash Merge、Tag 和紧急修复流程。
- Issue 与 PR 模板已完善，覆盖 Bug、功能、文档和 Adapter 提议，并区分贡献者自检与维护者受控敏感信息检查。
- 已新增公开 PR CI，覆盖配置一致性、WebCLI、Backend、Renderer、官网、Electron 集成和 Extension 检查；敏感信息扫描和真实账号 E2E 不进入公开自动化。
- 已补齐行为准则、支持指引、第三方声明、`.gitattributes`，并完善新仓库文件边界。
- 发布工作流已改为仅手动触发，并只创建指定版本的草稿 Release，不再强制移动 Tag 或删除既有 Release。
- 构建配置支持通过外部 Profile Overlay 叠加 Adapter、Provider 与扩展权限；安装包只读取生成的 `build/extension-dist/`，构建不再回写公共源配置。
- 官网（`officialWeb/`）已切换为开源单页站点；`src/lib/sites.json` 与 `extension/adapters` 公开 Adapter 对齐。
- Backend 提供可注册的 Profile 查询路由入口；默认公开构建保持空实现，定制能力可由独立入口参与开发和打包。
- Extension 页面运行时跨域访问改由内置 Adapter manifest 的 `runtime_allowed_hosts` 显式声明，公共 Service Worker 不再包含产品域名映射。
- WebCLI 包清单使用公共超集，定制仓库可按需提供命令目录资产而无需修改公共依赖或 package 配置。
- Windows 解密工具改由 `uv` 创建隔离、固定版本的构建环境，不再依赖系统 Python 预装 PyInstaller/pywin32。

## 验证结果

- 敏感信息复扫未发现新的硬编码密钥、Token、内部域名或私网 IP；命中项均为变量名、脱敏测试样例或公开占位地址。
- WebCLI 聚焦测试通过（31 项），Backend 用户场景测试通过（5 项）。
- Backend TypeScript 类型检查通过，Renderer 与官网生产构建通过。
- Extension 公开范围测试通过（19 项），内部功能清理前遗留的运行时测试不作为公开门禁。
- Electron 集成测试通过（22 项），公开配置校验及校验器测试通过。
- Windows 本地全量测试基线：WebCLI 234/243、Backend 283/288 通过；剩余失败为 Windows 文件系统/符号链接差异、已变更的 PowerShell 平台文案和过期测试 mock，需在后续开发中修复或在 Ubuntu CI 复核。
- Git 差异格式检查通过。
- 官网生产构建通过（公开 Adapter 对应 4 个分组、7 个站点）。
- Backend Profile 聚焦测试、Adapter scaffold/用户场景测试、类型检查与公开 bundle 验证通过；公开 bundle 标记为 `public`。
- Extension manifest 跨域授权聚焦测试通过；公开 Profile 成功生成 4 个实际打包 Adapter。
- Windows 解密工具在隔离环境中成功生成 `sd_decrypt.exe`。

## 进行中

- 执行初始化前的最终受控敏感信息复扫和文件清单复核。

## 待办

- 在干净目录复制最终文件并重新初始化 Git 仓库。
- 为公开发布配置新的下载地址、指标服务和发布流程。
- 在目标平台完成 Windows x64、macOS arm64 与 macOS x64 安装包验收。

## 约束

- 仓库不得包含真实密钥、Token、密码、账号、内部域名、私网 IP 或内部系统资料。
- 示例网络地址使用 `example.com`、`example.org`、`localhost` 或 `127.0.0.1`。
- 对外界面只使用“网站探索agent”，不暴露内部组件名称。
