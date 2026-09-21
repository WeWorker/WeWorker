# 百度贴吧 Adapter

该 Adapter 面向公开百度贴吧网页，提供贴吧常用浏览与轻量互动能力。

## 支持能力

- `tieba.baidu.com.check_login_status`：检查当前浏览器会话是否已登录。
- `tieba.baidu.com.search_content`：按关键词搜索贴吧或帖子。
- `tieba.baidu.com.open_thread_detail`：打开或读取帖子详情。
- `tieba.baidu.com.read_replies`：读取当前或指定帖子下的可见回复摘要。
- `tieba.baidu.com.follow_forum`：在明确确认后关注当前或指定贴吧。
- `tieba.baidu.com.sign_forum`：在明确确认后对当前或指定贴吧签到。

## 使用边界

- 搜索、详情读取和回复读取是只读能力。
- 关注贴吧和签到会修改当前账号状态，必须显式传入 `confirm=true`。
- 如果页面要求登录、验证码或人工确认，工具会返回 `login_required` 或 `needs_user_action`，不会声称成功。
- 已关注时不会执行取消关注；已签到时不会重复执行签到。
- Adapter 不读取、不保存、不返回 Cookie、Token、账号凭据或其他敏感信息。

## 示例

```bash
webcli call tieba.baidu.com.search_content --query="AI 工具" --type=thread --limit=5
webcli call tieba.baidu.com.open_thread_detail --url="https://tieba.baidu.com/p/1234567890"
webcli call tieba.baidu.com.read_replies --limit=5
```
