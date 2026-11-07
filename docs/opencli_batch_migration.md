# OpenCLI 八站迁移与验收记录

日期：2026-09-28。**本批尚未完整完成：83 个来源命令，81 个已接入，2 个待实现；只有下列命令有真实成功证据。** 不能将 v0.1.0 包或 fixture 测试通过视作全部站点可用。

## 来源与工作区

- OpenCLI SHA：`24136945847afbfad266c6c46a8cd335377f9112`，Apache-2.0，Copyright 2025 jackwener；许可证与 `docs/third_party/OpenCLI-LICENSE.txt` 换行归一化后完全相同。派生源码保留归属和修改说明。
- 实际开发在公开 WeWorker，沿用 `codex/migrate-opencli-adapters`，HEAD `9542d4ffa1975927abe90e6f921af43b1f60d906`，跟踪 `fork/codex/migrate-opencli-adapters`。PR #39 仍 OPEN / MERGEABLE，base develop。没有提交、推送、合并或发版。
- 开始前已保存公开工作区/暂存区二进制 diff 与未跟踪文件副本，继续使用当前迁移基线。未新增工作树，未使用旧开发路径，未清理 Archive。
- 前轮仅公开包、Profile、文档和站点测试发生变化。本轮新增通用 Bridge 二进制响应，并同步更新源码、通用测试和架构文档；公开旧有 diff（除本轮需扩展的 ROADMAP/Profile）保持一致，未跟踪技术文章逐字节保留。

## 包与清单

| 来源 | v2 包 | 已接入/来源 | 专属记录 |
|---|---|---:|---|
| 12306 | 12306.cn | 9/9 | [记录](opencli_12306_migration.md) |
| zhihu | zhihu.com | 22/22 | [记录](opencli_zhihu_migration.md) |
| youdao | note.youdao.com | 1/1 | [记录](opencli_youdao_migration.md) |
| 51job | 51job.com | 4/4 | [记录](opencli_51job_migration.md) |
| boss | zhipin.com | 16/16 | [记录](opencli_boss_migration.md) |
| dianping | dianping.com | 4/4 | [记录](opencli_dianping_migration.md) |
| douban | douban.com | 11/11 | [记录](opencli_douban_migration.md) |
| douyin | douyin.com | 14/16 | [记录](opencli_douyin_migration.md) |

完整 [83 项清单](opencli_batch_inventory.json) 保留来源参数、默认值、说明、依赖、读写性质、数据源和迁移状态。八包均有人工 guidance；manifest + guidance 确定性生成 Skill。不引入 OpenCLI 运行时、旁路 Runner 或 Toolkit 探索逻辑。

## 尚待工程实现与验证

这些是开发缺口，不是要求用户登录后就能解决的验收事项：

1. 抖音 draft：官方上传页文件注入、封面/表单/暂存证据；跨页后的操作需要明确分阶段，不能自动重放上传。
2. 抖音 publish：TOS 分块/签名、封面、转码、安全检查、完整业务参数和发布回执；来源流程可等待五分钟，与当前宿主单调用预算不同，不能仅扩大超时或换成 draft。

其余已接入命令仍需更多正常结果/错误 fixture 与真实验证，尤其账号读、BOSS 角色和收件人 DOM 身份证据、Zhihu 全部写入、Douyin update/delete。BOSS 发送在不能确认激活会话 UID 时拒绝；这条保守拒绝不能当发送能力验收通过。

## 首轮验证记录

- WebCLI 聚焦测试：八站包加载/参数/确认门/解析/Skill，以及携程、宿主导航、v2 包、视图共 193 项通过（其中新八站 79 项，另外 114 项为既有回归）。不是 193 个真实网站用例，也不是全部已接入命令业务覆盖。
- Profile / 打包测试：6 项通过。
- public prepare：16 个 host-managed v2 包。
- WebCLI bundle 成功；有既存可选列名映射文件缺失警告，命令发现正常。
- 八包分别用打包 CLI 生成 `.adapt`、校验、读取 Skill，均通过；产物在仓库外临时目录，不发布。
- 打包 CLI 真实调用 12306 stations 成功，trace `6ac0b033813a`。
- 12306 真实 stations/trains/train/price 成功；豆瓣 top250 成功。路线、日期、内部车次 ID、实际车站、席别价格及条目 ID/评分已经核对，详见各站记录。
- 有道公开短链真实全文读取成功，trace `9cb6c694b27d`；已修正路由/_time 和 React 主世界读取，用户分享链接与正文不进入公开仓库。
- 知乎 hot 明确登录阻塞；51job search、大众点评 search、豆瓣 subject 遭宿主域名拦截，实际跳转原因尚未知；抖音 search 要求站点验证；BOSS search 修复后仍未捕获匹配查询响应，trace `342a65cd48a3`。这些均未通过。
- UI 控制入口返回认证令牌不可用，没有完成桌面客户端自然语言验收。
- 未执行业务写入，未验收完整登录流程；whoami 不算完整登录通过。携程仍为 0.3.6，既有 71 项聚焦基线通过，ferry 真实有船班字段提取仍未覆盖。

## 用户参与的登录与验证码步骤（用户已完成）

1. 使用已连接 WeWorker 扩展的同一浏览器配置。在客户端确认 Bridge 已连接，并加载本轮公开构建包。不要换到另一浏览器登录后假定会话互通。
2. 分别打开官网：12306 `https://kyfw.12306.cn/otn/resources/login.html`、知乎 `https://www.zhihu.com/signin`、前程无忧 `https://we.51job.com/`、BOSS `https://www.zhipin.com/`、点评 `https://www.dianping.com/`、豆瓣 `https://www.douban.com/`、抖音创作者 `https://creator.douyin.com/`。按网站实际提示人工完成扫码/短信/验证码；不提供密码或 Cookie 给 Agent。
3. 51job、点评、豆瓣若跳到验证/登录页，请保留该页并记录地址栏的域名与路径（分享时去掉敏感查询参数）。当前域名拦截不能证明实际是验证码，不要直接扩宽白名单。
4. 登录后先在浏览器确认能正常看到对应列表，再逐条执行下面只读检查。BOSS 同时确认当前是求职端还是招聘端；抖音主页登录不等于拥有创作者中心权限。
5. 有道提供已授权公开的单篇分享链接，支持官方 `/s/` 短链及带 id 的单篇分享页。工作区 `/web/#/file/…` 私有笔记链接不是公开分享链接。不要为了验收公开敏感笔记。

## 可执行的只读人工复验

从公开仓库根目录运行（可将 node 路径入口替换为已安装 webcli）：

```powershell
node weworker/build/webcli-dist/webcli.cjs call zhihu.com.hot --limit=3
node weworker/build/webcli-dist/webcli.cjs call 51job.com.search --keyword=Python --area=上海 --limit=3
node weworker/build/webcli-dist/webcli.cjs call zhipin.com.search --query=Python --city=上海 --limit=3
node weworker/build/webcli-dist/webcli.cjs call dianping.com.search --keyword=火锅 --city=北京 --limit=3
node weworker/build/webcli-dist/webcli.cjs call douban.com.top250 --limit=3
node weworker/build/webcli-dist/webcli.cjs call douyin.com.search --query=风景 --limit=3
```

有道用 `call note.youdao.com.note "--url=<已授权分享链接>"`。铁路用 stations 解析车站，trains 使用当前有效日期，然后将返回的 train_no 传给 train/price。不要照抄过去的测试日期或固定内部车次 ID。每次记录命令、实际结果、trace；失败使用 `node webcli/index.js trace <traceID>` 查本地日志。日志可能含账号数据，不直接提交公开仓库。

## 客户端自然语言验收（未执行）

| 输入 | 应有行为 |
|---|---|
| “查明天去上海的高铁” | 追问出发地/车站范围，按当前时区换算日期，不默认北京 |
| “从北京南到上海虹桥，列三个；看看第二趟票价” | 保留前轮内部 train_no、日期和实际站点，不能用展示 G 车次替代 |
| “找上海 Python 职位；看看第二家公司” | 明确使用的招聘站点，保存真实 jobId/encCoId，不能混用 BOSS ID |
| “北京三家火锅，人均多少” | 明确本次页面范围、人均参考口径，不宣称团购报价 |
| “读这篇有道笔记全文再总结” | content 与 AI summary 分开，不能仅返回摘要当全文 |
| “查知乎这个问题，再读第二篇回答” | 问题摘要与回答全文区分，沿用真实 answer ID |
| “这部电影评分多少，保存海报” | 缺评分不补 0；调用 download 并核对文件，逐图失败或预算未处理不能称全部已保存 |
| “下周五发布抖音视频” | 明确 publish 尚未接入，不误调用 update/drafts，不做实际发布 |
| “给这些候选人发消息” | 先明确身份、对象、文案和确认；当前任务不授权真实发送 |

人工验收只补足登录、验证码与客户端交互证据；不能用它替代尚未实现的两项开发工作。

## 登录后第二轮证据（2026-09-28）

用户人工完成登录后，经相同 CLI/Bridge/扩展重新验证：

| 命令 | 结果 | trace |
|---|---|---|
| zhihu.hot | 返回3条真实热榜 | b92cabea1b94 |
| zhihu.question | 返回问题下1条回答与真实长ID | dfe0da3d01e2 |
| zhihu.download | 回答全文保存5117字节Markdown，文件实际存在且含原文链接/图片链接；未下载图片 | fa775c703eaf |
| dianping.search | 返回北京3家商户 | 8de005bc6c19 |
| douban.subject | 返回电影详情 | 7b1a20c913e1 |
| douban.photos | 返回1张实际海报链接 | 16627c6b36a4 |
| douban.download | 检出运行中Bridge未加载二进制更新，拒绝写损坏文件；尚未通过 | f63e57be020d |
| douyin.profile | 返回当前账号字段，账号数据不入库 | ea499c272a3f |
| douyin.videos | 返回3条作品，未执行更改 | 857c7dca2d0e |
| douyin.search | 返回3条公开内容 | 339344c93377 |
| 51job.search | 修复页面主世界请求后返回上海3条职位 | 1310d6d88f6f |
| 51job.detail | 使用搜索返回jobId读取详情 | ffafe069d3f0 |
| 51job.company | 使用搜索返回encCoId读取公司与2条职位 | 6c595bcd0536 |
| 12306.me | 返回本人账号资料，默认掩码；真实数据不入库 | f9ecea13402c |
| 12306.passengers | 返回3条乘车人，默认掩码；真实数据不入库 | 362dc6b061a8 |
| 12306.orders | 响应缺订单数组，原因未知，不认定无订单 | 2ee90c954909 |
| boss.search | 捕获URL仅有下划线参数，尚不能核验查询参数，继续拒绝误匹配 | 102dff6f8c50 |
| boss.chatlist | 主世界请求识别求职端并返回无会话状态，非有数据提取成功 | 44c877c23e07 |

新增知乎download及豆瓣download保留来源参数和本地output目录语义。图片用受限backend_fetch的base64模式及backend_file_write保存，禁止未知域、跳转、非图片内容和旧Bridge文本响应。图像请求有大小/时间预算，失败返回逐图failed或not_attempted；知乎仍保留远程图片并标partial。Markdown转换沿用OpenCLI规则，内置Turndown 7.2.2与GFM 1.0.2，MIT许可证保留在包内注释及docs/third_party/zhihu-markdown-LICENSES.txt。

通用二进制能力详见 [架构记录](runtime_binary_response.md)，公开通用测试 23 项通过，WebCLI 已重新构建。该轮运行中客户端尚需重启加载 Bridge；后续已完成，结果见下方重启后验收。

第二轮最终验证：公开 8 组 224 项通过，通用 3 组 23 项通过；Profile/打包 6 项及八包 `.adapt`/Skill 复核通过。除明确修改的 ROADMAP、Profile 和 Bridge 外，原有公开工作区差异与未跟踪技术文章保留。未提交、推送、合并或发版。

## 源码客户端重启后下载验收（2026-09-28）

- 豆瓣 download：真实保存一张 158416 字节 WebP，trace `6bd96b41defc`；RIFF/WEBP格式标记正确，实际打开图像成功。请求默认type=Rb，但页面标题为“剧照”；仅记图片下载成功，不能记海报筛选通过。结果补充requested_type/page_title以保留请求和页面上下文。
- 知乎 download --download-images=true：真实保存7张JPEG（34780、35847、25161、65127、52583、229623、50981字节），trace `610c948c0109`。所有文件JPEG起止标记正确，4683字节Markdown中的7个相对图片引用全部指向已存在文件；这是完整单篇回答离线导出样本，不代表专栏或全部图片域已验收。
- 12306 orders：重试仍缺订单数组，trace `6fc2f09b94aa`；不能认定无订单。增加了只在服务端明确给出“没有未完成订单”文案时识别空状态的边界测试，当前实际响应未满足该条件。
- 本轮没有新增通用框架修改；抖音draft/publish、BOSS搜索和客户端自然语言验收仍未完成。

本轮包、携程及导航聚焦3组159项通过，公开WebCLI重新构建通过。

## BOSS 搜索与 12306 订单继续排查（2026-09-29）

BOSS 0.1.1 改用页面主世界的显式只读请求，已完成上海跨页18条、北京第2页以及学历/经验筛选的真实验证；见 BOSS 迁移文档。12306 当前会话已失效，已修复登录页识别与个人中心导航，待重新登录继续核对旧订单缺列表问题。两站修复仅在公开包与站点测试中，无通用框架修改。

重新登录后续验：12306 0.1.1 不再依赖旧登录标签页判断登录；先核验官方服务器会话。官方成功响应省略 data 且页面明确显示无未完成订单时，严格组合响应与可见页面证据返回 EMPTY_RESULT，真实 trace `3225174f6409`。这只验证空状态，不等于有订单提取通过，也不表示未出行或历史订单为空。两站及宿主导航 116 项通过；未修改通用框架，未执行业务写操作。
