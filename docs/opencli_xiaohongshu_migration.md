# OpenCLI 小红书迁移，v2.0.1

## 登录后的真实验收更新（2026-09-30）

用户完成登录后，8 项命令通过真实数据样例验证，另有 drafts 的本地图文草稿空列表路径通过。**这不代表全部 25 项命令或全部参数组合已验收。** 原登录阻塞记录保留在下文作为历史。

| 命令 | trace | 真实范围 |
|---|---|---|
| whoami | 81b859f4914f | 创作者服务器身份验证成功 |
| creator-profile | ac2810c03d36 | 返回 7 个资料字段 |
| creator-stats | fb21e8aae7b7 | seven 周期，返回 9 个指标 |
| feed | 8f4531aed240 | 2 条带签名链接的推荐笔记 |
| search | 3be1db753ef0、237142e1b3f4 | 默认筛选 2 条；最新＋图文 3 条，执行筛选激活检查 |
| note | 66774387b2cc | 7 个详情字段，标题与搜索目标一致、正文非空 |
| comments | 6a91ac10ade1 | limit=3、with-replies=true，3 条顶层＋12 条回复 |
| user | 14231d737dbf | 使用搜索作者主页链接，返回 2 条笔记 |
| drafts | 81f1ff7cc23a | 图文类型，本地 IndexedDB 空列表；有草稿路径未验收 |

实测发现并修复两处兼容问题：筛选面板存在 aria-hidden／近透明重复控件，原边界矩形判断把它们算成可见选项；现在排除隐藏元素和隐藏祖先。带签名 search_result 详情 URL 会规范化成同 ID 的 explore 路径并更改跟踪参数；现在按受信同源、同笔记 ID 判断已到达，不再重复导航。

仍有两项失败：creator-notes 的真实签名响应 HTTP 200，仅包含 data.result 成功标记，缺少 note_infos；原实现静默转入未签名备用查询后报 406。现在明确报告缺字段，不能推断账号没有作品（最终 trace 668d7f22de48）。notifications mentions 调用站点 store 动作后捕获 0 个响应，最终 trace da2033a2bac7；不能当作没有通知。未取得作品 ID，因此创作者单篇／汇总未执行。下载、liked／saved、其他类型通知、30 天统计、真实写操作及完整自然语言验收仍未覆盖。

新增回归覆盖隐藏重复筛选项、同 ID 规范化导航、成功标记缺作品列表；最终专项 17 文件 214 项、宿主／包／旧接口回归 6 文件 105 项通过（两组有交集）。public prepare、WebCLI 构建与 2.0.1 独立 .adapt 校验通过。源码、构建资产与样例级机器证据一起更新。未执行任何真实发布、删除、点赞、关注或点点提问。本轮仅改公开站点代码与文档，无新增通用框架变更。

日期：2026-09-30。用户授权由 Codex 直接迁移，并替换旧实现；未使用 dsh/GLM。GitHub `jackwener/OpenCLI` 已执行 fetch 和 `ls-remote --symref origin HEAD`，默认分支 main 的最新 SHA 仍为 **24136945847afbfad266c6c46a8cd335377f9112**。比较范围仅 `clis/xiaohongshu`，不包含 `rednote`。

**25 项来源命令已接入，另保留 7 个旧名／本地命令。源码及模拟测试完成；真实验收最新状态见本文开头，不能称全功能真实验收通过。**

## 覆盖

| 分组 | 命令 |
|---|---|
| 会话 | login、whoami |
| 内容 | search、feed、note、comments、download、user |
| 列表／社交 | liked、saved、notifications、follow、unfollow |
| 创作者 | creator-profile、creator-stats、creator-notes、creator-note-detail、creator-notes-summary |
| 发布／草稿 | publish、delete-note、drafts、draft-open、draft-delete、draft-clear |
| 点点 | ask |

参数清单见 [inventory](opencli_xiaohongshu_inventory.json)。search 五类筛选、滚动采集及生效检查；comments 顶层 limit 和楼中楼／图片／用户链接；带签名详情链接；列表接口捕获；创作者签名请求／趋势／受众；图文上传、文字配图、话题、暂存；本地 IndexedDB 草稿及删除预演均接入。publish 是图文，不是视频上传发布。

旧 search-notes、open-note、read-comments、check-login-status 调用新实现，保留 underscore 别名，返回结构跟随新命令。旧中文筛选映射到上游枚举；旧 read-comments 也能使用 with-replies。详情读取要求带 xsec_token 的完整 URL，不能再依靠裸 ID。原 like-note、favorite-note 保留正向幂等动作及既有 requires_confirmation=false；追加目标域名／笔记路径校验，导航不自动执行写操作。navigate-to-homepage 只打开首页，feed 才返回推荐列表。

## 执行与边界

- 使用根 adapters/ v2 包和现有 Extension 页面 Runner，未另建执行器，未引入运行时依赖。版本提升为 2.0.0，移除旧 verified_on，避免拿历史验证日期背书新功能。
- `webcli/scripts/opencli-xiaohongshu/` 保存 Apache-2.0 来源、构建入口和本地绑定。build.mjs 确定性生成 manifest、25 个命令 wrapper、包内 bundle／许可证注释文件和 inventory。完整许可证同时随独立 .adapt 分发。
- 主世界求值用于 Pinia、IndexedDB、站点签名请求与 DOM；异常显式返回。跨页面首次只读调用使用宿主导航续执行，创作者后续页面转换沿用站点 SPA 路由。一次风险提示冷却重载有跨续执行标记，不无限重试。登录／非预期重定向单独报告。
- 新增写命令保持确认要求。写命令首次跳转返回 ready_to_retry / executed=false，由调用者以相同已确认参数再次调用，不自动重放。execute 默认为 false 的删除命令仍保持预演语义。超时可能发生在副作用之后，不能盲目重试。
- 通用 `native_input` 只允许文本和固定按键，绑定 sender tab，不暴露任意 CDP。仅同步此 helper、测试、说明到内部仓库；站点包和站点构建／测试只在公开仓库。
- 本地文件预读每张最多 8 MiB、总计 32 MiB、最多 9 张；使用既有 set_file_input，失败时保留来源的有界 base64 回退。媒体下载每文件最多 50 MiB，允许 xhscdn.com 及其子域，验证 MIME，拒绝下载重定向，不向 CDN 发送账号 Cookie；短链接仅有界跟随到可信小红书详情 URL。

## 相对来源的明确调整

login 只打开创作者登录页面，再由 whoami 验证，不在单次工具调用中轮询等待人工登录。whoami 可在任意创作者同源页面调用身份接口，避免 /new/home 被重定向时循环导航；普通网页登录与创作者登录范围不同。

宿主总预算 105 秒，包内单次执行预算最多 95 秒；creator-notes-summary 上游 timeout=180 在此受该上限约束。较多作品、慢速生成／上传可能超时，应缩小读取范围或检查写入实际状态。通用正整数参数限制在 1..100，timeout 接受 1..180 但执行受 95 秒上限约束；来源更严格限制仍保留（如评论最多 50）。

搜索折叠窗口的“新建标签页并关闭旧页”恢复未移植，返回明确错误，避免关闭用户标签页。来源失败诊断截图不自动保存。download 的文件大小上限、publish 的文件预读上限是宿主有界 I/O 调整。草稿仅是当前浏览器本地 IndexedDB；draft-open 保留最多 500 字符预览。

额外收紧：缺少 comments.results 不作为合法空评论；非成功发布跳转（尤其登录页）不能冒充发布成功；字符串 false 不再被当成 true；来源签名 URL 再加 HTTPS／主机／凭据限制。

## 初次 2.0.0 验证（后续增量见本文开头）

- 小红书专项：17 个文件 **211 项通过**，其中来源逻辑 159 项、真实 v2 bootstrap／生成 bundle 集成 52 项。覆盖参数／中文兼容、导航与写入阻断、身份接口、评论楼中楼、捕获结构／截断、二进制下载、短链域名、上传缺文件、原生输入的发布／暂存模拟、删除预演与后置检查、风险重载限制。
- 宿主导航、公开 builtin、包校验、旧确认／迁移及小红书集成组合 **6 文件 102 项通过**（与专项测试有交集，不相加冒充独立测试数）。
- 原生输入及既有 runtime helper：公开与内部各 21 项，通过；自己的 debugger 连接在错误时释放，借用连接不释放，不启用额外 Network 捕获。
- public prepare 20 个 host-managed 包、WebCLI bundle、独立 .adapt pack/validate 通过。构建仍提示既有可选列名映射文件缺失。
- 未运行全仓测试；未进行客户端自然语言完整验收；未执行真实点赞、收藏、关注、提问、发布或删除。

## 真实调用记录

| trace | 调用与结果 |
|---|---|
| c823f06de8e8、364e218f878d | 初始 whoami 导航循环；随后修复同源身份接口导航 |
| 34294c3a38df、7921056251b7 | 构建 CLI 副本与宿主包摘要不一致，拒绝执行；改用同一 prepare 来源的 source CLI 核验 |
| 21cca66933b1 | whoami，服务器会话核验返回创作者中心需要登录；不是成功读到账号 |
| a5d034f918d8 | search 被已有创作者登录页干扰；随后将登录页检查限定在目标 origin |
| 40bfbc57e73d | 修复后 search 咖啡 / limit=2，返回小红书搜索登录墙；不是合法空结果 |

真实后续验证需要在连接扩展的浏览器登录 www.xiaohongshu.com 与 creator.xiaohongshu.com；不可把模拟数据或登录墙识别当作业务字段验收。新增 native_input 的真实使用需要浏览器加载本轮构建出的扩展版本。

```powershell
node weworker/scripts/prepare-build.cjs --profile public
node webcli/index.js call xiaohongshu.com.whoami
node webcli/index.js call xiaohongshu.com.search --query=咖啡 --limit=2
```

包与映射状态表示代码迁入，不表示所有真实流程已验收。原用户文章和内部两个 lockfile 改动保持；未推送、合并或发版。
