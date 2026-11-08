# 微信读书

shelf/notes/notebooks/highlights/book/ai-outline 为浏览器读取（书架、笔记、划线、书籍详情与 AI 大纲），登录后可读个人数据；book-search/ranking/search 为后台 API（weread.qq.com/web 与 i.weread.qq.com 固定路径，仅 GET、禁重定向），搜索与排行无需页面上下文。whoami 校验登录并读取身份；login 仅打开登录页（写操作需确认，打开后人工完成登录再用 whoami 验证，不轮询登录状态）。接口返回登录墙或结构变化时报错而非空结果；缺字段保留 null/空串，不补造 0 或空列表。

多轮会话：search/shelf/ranking/notebooks通过返回的bookId绑定书籍、笔记、划线、大纲和书内搜索；book详情也保留bookId。书内搜索只补query，不重选书。数字和字符串bookId按源数据绑定，业务Adapter自己的既有规范化保持原样。notes/highlights/ai-outline/book-search没有单条内容或章节正文的后续命令，已在results.reason注明能力边界。
