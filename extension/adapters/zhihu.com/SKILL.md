# 知乎

知乎 Adapter 提供登录检查、搜索问题/文章、打开问题或文章详情、读取回答/评论，以及在明确确认后点赞/收藏的能力。

Matches: `zhihu.com`

## Tools

### `zhihu.com.check_login_status`

检查当前知乎浏览器会话是否已登录。不会返回 Cookie、Token、账号凭据或其他敏感信息。

### `zhihu.com.search_content`

按关键词搜索知乎问题和文章。首次调用可能会跳转搜索结果页；页面加载完成后，用相同参数再次调用可读取结果。

Parameters:

- `query`: string required — 搜索关键词
- `type`: string — 搜索类型，可选：`all`、`question`、`article`
- `limit`: number — 最多返回结果数量，1-10

### `zhihu.com.open_content`

打开或读取知乎问题/文章详情。问题页会返回问题标题、描述和可见回答摘要；文章页会返回标题、作者、正文摘要和统计信息。首次调用可能会跳转详情页；页面加载完成后再次调用可读取内容。

Parameters:

- `url`: string — 问题或文章 URL
- `id`: string — 问题或文章 ID；与 `type` 配合使用
- `type`: string — `question` 或 `article`

### `zhihu.com.read_comments`

读取当前或指定知乎问题、文章或回答下的可见回答/评论摘要。首次调用可能会跳转详情页；页面加载完成后再次调用可读取内容。

Parameters:

- `url`: string — 问题或文章 URL；为空时使用当前页
- `id`: string — 问题或文章 ID；为空时使用当前页
- `type`: string — `question` 或 `article`
- `limit`: number — 最多返回评论数量，1-20

### `zhihu.com.like_content`

对当前或指定知乎内容执行点赞/赞同。如果已经点赞或赞同则返回已完成，不执行取消。

Requires explicit user confirmation before calling this tool.

Parameters:

- `url`: string — 问题或文章 URL；为空时使用当前页
- `id`: string — 问题或文章 ID；为空时使用当前页
- `type`: string — `question` 或 `article`
- `confirm`: boolean — 必须显式为 `true` 才会修改当前账号状态

### `zhihu.com.favorite_content`

对当前或指定知乎内容执行收藏。如果已经收藏则返回已收藏，不执行取消。若站点弹出收藏夹选择或登录弹层，Adapter 会返回需要用户操作，不会静默选择未知收藏夹。

Requires explicit user confirmation before calling this tool.

Parameters:

- `url`: string — 问题或文章 URL；为空时使用当前页
- `id`: string — 问题或文章 ID；为空时使用当前页
- `type`: string — `question` 或 `article`
- `confirm`: boolean — 必须显式为 `true` 才会修改当前账号状态

## Safety

- 搜索、详情、回答和评论读取为只读能力。
- 点赞和收藏会修改当前知乎账号状态，必须显式传入 `confirm=true`。
- 已点赞或已收藏的内容不会执行取消操作。
- Adapter 不应保存或返回 Cookie、Token、账号凭据、真实会话或浏览器 profile 数据。
