# 小红书任务指导

搜索使用 `search --query=关键词 --limit=20`；筛选为 sort、note-type、publish-time、scope、location，枚举以 manifest 为准。`feed` 读取推荐列表，`user --id=用户ID` 读取用户笔记；`liked`、`saved` 读取列表，不执行点赞／收藏。

从搜索、推荐或用户笔记结果取得完整 URL（包含 xsec_token），再调用 `note --note-id=完整URL`、`comments --note-id=完整URL --with-replies=true` 或 `download --note-id=完整URL --output=目录`。不能猜测 ID 或省略签名参数。download 也接受 xhslink.com 短链接。评论 limit 是顶层数量（最多 50），楼中楼另计；只返回实际加载的内容，未保证全部评论。下载保持图片顺序，每个媒体文件最多 50 MiB；失败不可当作文件已保存。

只读命令首次需要跳转时由宿主导航并续执行。页面验证、登录墙、渲染错误、接口错误不能解释成没有数据。`whoami` 验证创作者中心服务器会话；与普通小红书网页登录范围不同。`login` 只打开登录页面，用户完成登录后调用 whoami，不假报已登录。

创作者分析：先 `creator-profile`／`creator-stats --period=seven` 或 thirty，再 `creator-notes`，取得准确作品 ID 后使用 `creator-note-detail`／`creator-notes-summary`。宿主总预算 105 秒，包内预算 95 秒；summary 的上游 timeout 默认 180 在这里受 95 秒上限约束，建议先取 1–3 篇。不足字段按来源返回，不推断不存在的数据。

仅执行用户明确要求的写操作；目标和内容不明确时先澄清。按各命令说明使用业务参数。发布为图文（不是视频上传）：title 最多 20 字符，content 必填，images 最多 9 张，或 card-text 文字配图；多卡用 `|||` 分隔。图片每张最多 8 MiB、合计 32 MiB。draft=true 表示保存草稿；topics 支持站点话题选择，找不到不能用普通 #文本冒充。首次写调用若返回 ready_to_retry，表示只打开了目标页，尚未执行操作；核对目标页后使用相同业务参数重新调用，写操作不会自动重放。写调用超时或中断时先检查页面，避免重复发布。

`delete-note`、`draft-delete`、`draft-clear` 默认 execute=false，只检查目标或统计；execute=true 才删除。草稿是当前浏览器、当前创作者 origin 的 IndexedDB 本地草稿，不代表云端草稿。draft-open 返回最多 500 字符预览，不是完整正文。

旧名 search-notes／open-note／read-comments／check-login-status 兼容转入新实现，结果结构跟随新命令；旧中文搜索筛选映射保留。like-note／favorite-note 保留原有幂等正向操作和免二次确认策略，仍须用户明确要求该动作。navigate-to-homepage 只打开首页，读取推荐列表请用 feed。

初次迁移验证：8 项命令已有真实数据样例通过；后续发布验证见下文。创作者作品接口可能返回成功标记但缺少 note_infos，必须按结构异常处理，不能推断没有作品；通知动作未捕获响应也不代表没有通知。删除及所有页面版本未完整真实验收。搜索窗口折叠时不会自动关闭用户标签页；返回错误后应在可见正常窗口重试。调试截图不自动保存。

多轮引用：列表按真实展示顺序选择笔记，绑定完整签名 URL；签名缺失、URL 与 ID 不一致或来源域名错误时不生成可执行动作。搜索、推荐、收藏、点赞列表和用户笔记可继续阅读、看评论、下载、点赞或收藏，不提供创作者删除动作。评论及通知仅使用实际用户 ID 跳转资料或关注，不能使用显示名猜 ID；没有身份的系统通知保留原始内容，但动作不可执行。

`note` 保留 field/value 输出和完整正文，只在 title 行绑定笔记动作，其余指标行不重复代表同一笔记。创作者作品列表及汇总绑定作品数据与删除；作品指标详情只在 note_id 行提供删除，不能把观看数当作作品。草稿按编码 ID 和类型绑定查看、删除。creator-profile、creator-stats 是资料/指标终点；navigate-to-homepage 是导航回执，这些输出不伪造候选对象。

download 会写文件，按 write 分类。仅准备导航使用 phase=prepare，由宿主完成导航后生成独立回执；会话中的同一步可再次调用，实际下载后不允许重放。当前新增场景执行真实包处理器并 mock 页面、网络和文件接口，不证明真实互动、下载落盘、删除或账号切换已验收。

## 收藏专辑与视频下载

新增只读命令（Extension / 页面运行时，需要登录）：

- `webcli call xiaohongshu.com.albums --limit=200`：当前账号的专辑列表；可传 `--id=<用户ID>`。返回 `albums`、`loaded`、`total`、`complete`。专辑按 ID 去重，不能按名称去重；同名专辑可同时存在。`note_count` 是笔记总数，不是视频数。
- `webcli call xiaohongshu.com.album-notes --album-id=<专辑ID> --limit=200`：专辑笔记，含 `type`、笔记 URL、`has_more`、`complete`。只下载 `type=video`；`complete=false` 不得报告整张专辑已处理。
- `webcli call xiaohongshu.com.video-media --url=<笔记完整URL>`：返回含音轨的 MP4 流，用于 yt-dlp。本命令只解析媒体，不写文件。媒体 URL 有时效，下载前即时读取，勿写入日志或示例。

命令遵循宿主只读导航续执行协议；不会执行专辑创建、编辑或删除。滚动读取最多 30 轮；超出预算或加载停滞返回不完整标记。此能力依赖当前网页 Pinia 数据结构，并非后台 API；页面结构改变后需重新验证。

专辑分页接口实测为 `/api/sns/web/v1/board/user`（page/num 参数），网页入口为“我 → 收藏 → 专辑”，专辑页为 `/board/<id>`。不自行构造签名或读取 Cookie，复用网站正常加载逻辑。

## 图文发布与结果核验（v2.0.4）

`publish` 支持 `title`、`content`、`images`（本地图片绝对路径）、`draft`、`topics`、`content-declaration`。AI 合成内容使用 `content-declaration=ai`，默认 `none`；不得用普通正文替代平台声明。多行正文按段落写入并核对，图片使用原生 FileList 赋值并核对，不重复连接浏览器 debugger。复杂内容建议使用 `--args-file=<JSON文件绝对路径>`。

保存草稿用 `draft=true`。返回 `draft_saved` 时已通过本地草稿数据库核对新增 ID、标题及图片数量；草稿仅存在当前浏览器。公开发布返回 `note_id`、`image_count`、`status`、`platform_status` 和核验来源；`reviewing` 为审核中，`published` 为已发布，`submitted` 保留其他平台状态，不代表审核通过。

`webcli call xiaohongshu.com.publish-status --note-id=<24位作品ID>` 是只读状态检查，复用作品管理页正常签名请求，不重造签名或读取 Cookie。仅检查最近第一页；`not_in_recent_page` 不表示作品已删除。公开发布核验须找到基线中不存在、标题和图片数匹配的唯一作品。返回 `OUTCOME_UNKNOWN`、超时或中断后先检查管理页／草稿箱，禁止自动再次提交。

真实验证范围：修复后的 publish 完成 3 图草稿保存、正文分段与 AI 声明选择；publish-status 已读取此前通过基础浏览器操作公开发布的作品及审核通过状态。修复后的公开提交分支经过自动化模拟验证，未再次公开发帖。现有编辑器含内容时应先检查，避免覆盖未完成笔记。
