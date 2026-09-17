# GitHub

GitHub：检查登录状态、搜索仓库、查看仓库详情、查看 Issue/PR、Star 仓库

Matches: github.com

## Tools (5)

### github.com.check_login_status

检查当前 GitHub 浏览器会话是否已登录，并返回登录状态。不会返回 Cookie、Token、邮箱等敏感信息。

### github.com.search_repositories

根据关键词搜索 GitHub 仓库，并返回仓库名称、描述、语言、星标数和链接。首次调用可能会跳转搜索页，页面加载后再次调用可读取结果。

Parameters:

- `query`: string — 搜索关键词
- `limit`: number — 返回数量，1-10

### github.com.get_repository_detail

打开或读取 GitHub 仓库详情页，返回仓库名称、简介、README 摘要、语言、star/fork/watch 信息和关键链接。首次调用可能会跳转仓库页，页面加载后再次调用可读取详情。

Parameters:

- `repository_url`: string — 仓库 URL 或 owner/repo；为空时使用当前页

### github.com.get_issue_or_pr_detail

打开或读取 GitHub Issue/Pull Request 详情页，返回标题、状态、作者、正文摘要、标签、评论摘要和链接。传列表页时会进入第一条详情，页面加载后再次调用可读取详情。

Parameters:

- `issue_url`: string — Issue/PR URL；为空时使用当前页
- `max_comments`: number — 最多返回评论摘要数量，0-10

### github.com.star_current_repository

对当前 GitHub 仓库执行 Star；如果已经 Star 则返回已 Star，不执行取消。必须显式传入 `confirm=true` 才会修改当前账号状态。

Requires explicit user confirmation before calling this tool.

Parameters:

- `repository_url`: string — 仓库 URL 或 owner/repo；为空时使用当前页
- `confirm`: boolean — 必须显式为 true 才执行 Star

Safety:

- 不读取、不保存、不返回 Cookie、Token、邮箱或其他敏感凭据。
- 默认不修改账号状态；只有用户确认并传入 `confirm=true` 时才执行 Star。
- 已 Star 的仓库不会执行 Unstar。
