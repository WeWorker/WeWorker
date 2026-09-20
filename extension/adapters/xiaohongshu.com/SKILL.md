# 小红书

小红书 Adapter 提供登录检查、搜索笔记、打开笔记详情、读取评论，以及在明确确认后点赞/收藏笔记的能力。

Matches: `xiaohongshu.com`

## Tools

### `xiaohongshu.com.check_login_status`

检查当前小红书浏览器会话是否已登录。不会返回 Cookie、Token、账号凭据或其他敏感信息。

### `xiaohongshu.com.navigate_to_homepage`

打开小红书首页。页面跳转后可能需要等待数秒再调用其他工具。

### `xiaohongshu.com.search_notes`

按关键词搜索小红书笔记。首次调用可能会跳转搜索结果页；页面加载完成后，用相同参数再次调用可读取结果。

Parameters:

- `keyword`: string required — 搜索关键词
- `sortBy`: string — 排序依据，可选：`综合`、`最新`、`最多点赞`、`最多评论`、`最多收藏`
- `noteType`: string — 笔记类型，可选：`不限`、`视频`、`图文`
- `publishTime`: string — 发布时间，可选：`不限`、`一天内`、`一周内`、`半年内`
- `searchScope`: string — 搜索范围，可选：`不限`、`已看过`、`未看过`、`已关注`
- `location`: string — 位置距离，可选：`不限`、`同城`、`附近`

### `xiaohongshu.com.open_note`

打开或读取小红书笔记详情，返回标题、正文、发布时间、图片/视频信息和可见评论摘要。首次调用可能会跳转笔记详情页；页面加载完成后再次调用可读取内容。

Parameters:

- `id`: string — 笔记 ID
- `url`: string — 笔记详情 URL

### `xiaohongshu.com.read_comments`

读取当前或指定小红书笔记的评论摘要。首次调用可能会跳转笔记详情页；页面加载完成后再次调用可读取评论。

Parameters:

- `id`: string — 笔记 ID；为空时使用当前页
- `url`: string — 笔记详情 URL；为空时使用当前页
- `limit`: number — 最多返回评论数量，1-20

### `xiaohongshu.com.like_note`

对当前或指定小红书笔记执行点赞。如果已经点赞则返回已点赞，不执行取消点赞。

Parameters:

- `id`: string — 笔记 ID；为空时使用当前页
- `url`: string — 笔记详情 URL；为空时使用当前页
- `confirm`: boolean — 必须显式为 `true` 才会修改当前账号状态

### `xiaohongshu.com.favorite_note`

对当前或指定小红书笔记执行收藏。如果已经收藏则返回已收藏，不执行取消收藏。

Parameters:

- `id`: string — 笔记 ID；为空时使用当前页
- `url`: string — 笔记详情 URL；为空时使用当前页
- `confirm`: boolean — 必须显式为 `true` 才会修改当前账号状态

## Safety

- 点赞和收藏会修改当前小红书账号状态，必须显式传入 `confirm=true`。
- Adapter 不应保存或返回 Cookie、Token、账号凭据、真实会话或浏览器 profile 数据。
