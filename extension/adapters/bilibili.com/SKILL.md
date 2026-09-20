# Bilibili / B 站

Bilibili / B 站：登录检查、搜索视频、打开视频详情、读取评论、点赞/收藏视频

Matches: bilibili.com

## Tools (6)

### bilibili.com.check_login_status

检查当前 B 站浏览器会话是否已登录，并返回登录状态。不会返回 Cookie、Token、账号凭据或其他敏感信息。

### bilibili.com.search_videos

根据关键词搜索 B 站视频，并返回标题、链接、UP 主、播放信息和摘要。首次调用可能会跳转搜索页，页面加载后再次调用可读取结果。

Parameters:

- `query`: string — 搜索关键词
- `limit`: number — 返回数量，1-10

### bilibili.com.open_video_detail

打开或读取 B 站视频详情页，返回标题、UP 主、播放量、弹幕数、发布时间、简介和关键链接。首次调用可能会跳转视频页，页面加载后再次调用可读取详情。

Parameters:

- `video_url`: string — 视频 URL、BV 号或 av 号；为空时使用当前页

### bilibili.com.read_comments

读取当前 B 站视频页的评论摘要。页面评论未加载时，可先滚动到评论区后再次调用。

Parameters:

- `limit`: number — 最多返回评论数量，1-20

### bilibili.com.like_video

对当前或指定 B 站视频执行点赞。必须显式传入 `confirm=true` 才会修改当前账号状态。

Requires explicit user confirmation before calling this tool.

Parameters:

- `video_url`: string — 视频 URL、BV 号或 av 号；为空时使用当前页
- `confirm`: boolean — 必须显式为 true 才执行点赞

### bilibili.com.favorite_video

对当前或指定 B 站视频执行收藏。必须显式传入 `confirm=true` 才会修改当前账号状态。若页面要求选择收藏夹，建议传入 `folder_name`；未提供时不会静默选择未知收藏夹。

Requires explicit user confirmation before calling this tool.

Parameters:

- `video_url`: string — 视频 URL、BV 号或 av 号；为空时使用当前页
- `folder_name`: string — 收藏夹名称；当页面弹出收藏夹选择时用于选择目标收藏夹
- `confirm`: boolean — 必须显式为 true 才执行收藏

Safety:

- 不读取、不保存、不返回 Cookie、Token、账号凭据或其他敏感信息。
- 搜索、详情和评论读取为只读能力。
- 点赞和收藏默认不修改账号状态；只有用户确认并传入 `confirm=true` 时才执行。
- 已点赞或已收藏的视频不会执行取消操作。
- 收藏需要选择收藏夹时，未提供 `folder_name` 不会静默选择未知收藏夹。
