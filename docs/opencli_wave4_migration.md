# OpenCLI wave4：今日头条、什么值得买、arXiv

## 最新修复与验收（2026-10-08，头条 0.1.1）

WeWorker Bridge 重连后，通过临时只读诊断确认当前头条页面使用服务器登录状态 `/mp/agw/media/user_login_status_api` 和身份 `/mp/agw/creator_center/user_info`，没有旧来源假设的全局账号对象。现改用这两个接口核验，优先保留 user_id_str，拒绝不安全整数身份。whoami 实测 logged_in=true（trace 6467086e1971）。

articles 改为登录验证后限定 `.all-content-list` 区域读取，并有界等待。只有列表区域唯一子节点为 `.byte-empty`、显示明确“暂无作品”文案且无加载标记时返回空数组；其他未识别结构报错。page=1 空态实际通过（trace c6898c261d1d），仅证明当前筛选页为空；有文章、多页及其他筛选尚未真实验收。

临时诊断已从命令包装中移除，没有保存账号值、Cookie 或文章内容到源码/fixture。专项 130 项、相关回归 148 项通过，公开23包prepare及WebCLI构建通过。头条0.1.1独立包校验通过：9文件、17226字节，SHA256 7df4a284b2a747e87432270e324e7964378bd277b1271a5e8d96d7727f520f72。下方旧失败、测试数与包哈希是历史快照。当前本批有 8 项真实数据/身份样例通过，另 articles 明确空列表路径通过；login 未执行，不能称全部功能真实验收。

## 头条登录后首次复验（历史，2026-10-08）

用户完成登录后再次只读调用：whoami 的后台身份字段未被来源探针识别（trace eadab7180e9e），articles page=1 未解析出文章行（trace 1c2b6072f600）。这不能证明会话过期，也不能证明账号没有文章。已将前者从 AUTH_REQUIRED/“stale session”改为 COMMAND_EXEC/身份结构未知，并增加实际生成探针回归；专项更新为 121 项通过。浏览器检查工具返回 `Codex auth token is unavailable`，未能进一步核验页面结构；两项仍不计验收通过。下面包哈希和回归138项属于该诊断修正前的验收快照。

日期：2026-10-08。PR #41 已 squash 合入 develop（202ec8ae），本批基于更新后的 origin/develop，在 codex/opencli-wave4 实现。原有无关文章保留；内部仓库无改动。来源 OpenCLI main 经 fetch 核验仍为 24136945847afbfad266c6c46a8cd335377f9112。

三站 10 项来源命令已接入，7 项公开读取真实样例通过。头条 whoami 导航超时、articles 提示需要登录；login 未执行。不能称三站全功能或完整客户端自然语言验收通过。

## 命令与差异

| 包 | 来源能力 | 边界 |
|---|---|---|
| toutiao.com | hot、recommend、articles、login、whoami | hot/recommend 后台公开 GET；articles 创作者页面 page=1..4；login 打开官方登录页后需人工完成，再 whoami 检查 |
| smzdm.com | search | search.smzdm.com 已渲染好价卡片，query 必填、limit=1..100；不翻页，不保证达到 limit |
| arxiv.org | search、paper、author、recent | 公开 Atom API；search 最多25，其余列表最多50；paper 是元数据/摘要及 PDF 链接，不下载 PDF 正文 |

全部使用已有 v2 Extension Runner。固定 API 端点、GET、4 MiB 响应预算、禁止重定向、关闭浏览器回退并隐藏响应 trace 正文；页面读取走既有主世界 helper 和导航续执行。没有新依赖、全局协议或通用框架变化。根目录 v2 包由 build-profile 注册，prepare 产生 23 个 host-managed 包；旧 extension/adapters/index.json 不用于这些 v2 包注册。

构建绑定源码位于 webcli/scripts/opencli-wave4，upstream 保留固定来源和来源测试，Apache-2.0 LICENSE 同时保留在源码与三个独立 .adapt 内。`node webcli/scripts/opencli-wave4/build.mjs` 可重建 manifest、bundle、命令包装及机器清单。全部新能力为读取，只有打开登录页是 write 并要求确认，不自动续执行业务操作。上游登录超时参数/轮询不移植；使用分步登录边界。

输入比上游更严格：布尔、空串、非整数和越界 limit 拒绝，限制 query 长度；arXiv ID、分类与作者引号校验。Atom 验证单一完整 feed、大小/深度/节点预算，拒绝 HTML、错误 entry、非官方 PDF 链接和畸形结构；支持实体及 CDATA，去版本号 id/url 与带版本 PDF 明确区分。作者仍为来源姓名模糊匹配。缺失字段不补造。

头条缺失列表字段报结构错误；缺失热度/评论指标为 null；文章指标扫描止于下一时间戳。文章渲染解析仍沿用来源启发式，日期无年份、有登录墙关键词时拒绝，尚未真实账号验收。whoami 沿用 Cookie 加后台身份表面，不等于单独验证服务端身份 API。

值得买仅接受官方 HTTPS 商品/文章链接，拒绝带凭据链接，缺失互动指标为 null。页面验证墙或没有可识别卡片时报告错误，尚无已验证空状态，不将此判为无商品。价格和优惠条件保留原文，不等于当前可成交价格。

## 验证

- 从 webcli 执行 `npx vitest run --config vitest.wave4.config.js --reporter=dot`：3 文件 120 项通过（来源 Toutiao/arXiv 与实际生成包的 bootstrap 集成）。保留的上游 SMZDM 测试依赖 jsdom，本轮没有安装或运行；实际生成的 DOM 脚本由本地模拟页面集成测试覆盖。
- 相关回归覆盖当前批次、宿主、公开内置包、v2 包及 wave3：5 文件 138 项通过；与专项有交集，不累加。
- 三个独立 .adapt 已在仓库外打包并用 readAdapterPackage 校验（含 guidance 和许可证）：头条 9 文件/16068 字节，值得买 5 文件/10018 字节，arXiv 8 文件/13476 字节。SHA256 分别为 07242e1aff4c96b26b70319bbbcb30d26b2837aa5aae266637d15637d0f6dc4c、154ccf086a4284942818455f67ddedbe04f54e7013a5c5c13a0f3f76f1395d2b、b51c6a6e8813f547abdafc1522395cc11d0d0bb809ae5b0a7957efb2d157d23c。
- 公开 `node scripts/prepare-build.cjs --profile public` 输出 23 包；`npm run build:webcli` 通过。既有可选列名映射缺失警告未改变。
- 全仓测试、跨平台安装包、完整自然语言入口、真实写操作未执行。

## 真实只读样例

通过构建后的 WebCLI → 现有 Bridge → Extension 运行，日志位于仓库外；不保存真实账户响应、Cookie 或带签名资源链接。机器状态见 [inventory](opencli_wave4_inventory.json)，均为样例级证据。

| 命令 | trace | 样例结果 |
|---|---|---|
| toutiao.hot | f655079cbcfa | 最终构建复验，limit=2，2 条话题 |
| toutiao.recommend | 49ec00077d9d | news_tech、limit=2，2 条文章 |
| smzdm.search | 7bb62c120a1c | 耳机、limit=2，2 条好价卡片 |
| arxiv.search | d14b41e3fd0e | transformer、limit=2，2 条论文 |
| arxiv.paper | 631448e76f37 | 公开论文详情，1 条 |
| arxiv.author | 7e3f788993b7 | 公开作者查询、limit=2，2 条 |
| arxiv.recent | fe0d5f76a724 | cs.CL、limit=2，2 条 |
| toutiao.whoami | 4dd72c00e402 | 失败：宿主页导航超时，无身份验收 |
| toutiao.articles | efbf293c9fe8 | 失败：创作者后台要求登录，无文章验收 |

尚未覆盖：其余频道、所有页码/分类/输入形式、安全验证恢复、SMZDM 明确空结果、头条登录及创作者数据。不得仅凭单次超时推断为永久站点故障。
