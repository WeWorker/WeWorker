# 小红书任务指导

搜索使用 `search --query=关键词 --limit=20`；筛选为 sort、note-type、publish-time、scope、location，枚举以 manifest 为准。`feed` 读取推荐列表，`user --id=用户ID` 读取用户笔记；`liked`、`saved` 读取列表，不执行点赞／收藏。

从搜索、推荐或用户笔记结果取得完整 URL（包含 xsec_token），再调用 `note --note-id=完整URL`、`comments --note-id=完整URL --with-replies=true` 或 `download --note-id=完整URL --output=目录`。不能猜测 ID 或省略签名参数。download 也接受 xhslink.com 短链接。评论 limit 是顶层数量（最多 50），楼中楼另计；只返回实际加载的内容，未保证全部评论。下载保持图片顺序，每个媒体文件最多 50 MiB；失败不可当作文件已保存。

只读命令首次需要跳转时由宿主导航并续执行。页面验证、登录墙、渲染错误、接口错误不能解释成没有数据。`whoami` 验证创作者中心服务器会话；与普通小红书网页登录范围不同。`login` 只打开登录页面，用户完成登录后调用 whoami，不假报已登录。

创作者分析：先 `creator-profile`／`creator-stats --period=seven` 或 thirty，再 `creator-notes`，取得准确作品 ID 后使用 `creator-note-detail`／`creator-notes-summary`。宿主总预算 105 秒，包内预算 95 秒；summary 的上游 timeout 默认 180 在这里受 95 秒上限约束，建议先取 1–3 篇。不足字段按来源返回，不推断不存在的数据。

写操作须先取得用户对具体内容、目标和动作的确认，再传 `__confirmed=true`。发布为图文（不是视频上传）：title 最多 20 字符，content 必填，images 最多 9 张，或 card-text 文字配图；多卡用 `|||` 分隔。图片每张最多 8 MiB、合计 32 MiB。draft=true 表示保存草稿；topics 支持站点话题选择，找不到不能用普通 #文本冒充。首次写调用若返回 ready_to_retry，表示只打开了目标页，尚未执行操作；使用相同已确认参数重新调用，写操作不会自动重放。写调用超时或中断时先检查页面，避免重复发布。

`delete-note`、`draft-delete`、`draft-clear` 默认 execute=false，只检查目标或统计；execute=true 才删除。草稿是当前浏览器、当前创作者 origin 的 IndexedDB 本地草稿，不代表云端草稿。draft-open 返回最多 500 字符预览，不是完整正文。

旧名 search-notes／open-note／read-comments／check-login-status 兼容转入新实现，结果结构跟随新命令；旧中文搜索筛选映射保留。like-note／favorite-note 保留原有幂等正向操作和免二次确认策略，仍须用户明确要求该动作。navigate-to-homepage 只打开首页，读取推荐列表请用 feed。

当前状态：8 项命令已有真实数据样例通过，本地图文草稿只验证过空列表。创作者作品接口可能返回成功标记但缺少 note_infos，必须按结构异常处理，不能推断没有作品；通知动作未捕获响应也不代表没有通知。发布、删除及所有页面版本未真实验收。搜索窗口折叠时不会自动关闭用户标签页；返回错误后应在可见正常窗口重试。调试截图不自动保存。
