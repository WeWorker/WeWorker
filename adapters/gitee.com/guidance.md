# Gitee 代码托管

search 先导航 gitee.com/search 再经固定 so.gitee.com 搜索接口读取（limit 最大 50）；接口明确返回空 hits 报告 EMPTY_RESULT，响应结构变化或 HTTP 失败报告 COMMAND_EXEC，不把解析失败当空结果。trending 读取 Gitee 探索页卡片，页面被拦截、结构变化或解析不出项目时报错而非空榜；不做网络捕获增强。
user 组合个人页与 /api/v5/users 固定接口读取昵称、关注、公开仓库与码云指数：用户不存在报告 EMPTY_RESULT，页面受限或接口失败报告 COMMAND_EXEC，字段缺失用 '-' 标记未知，不补造数值。whoami 经页面内 /api/v5/user 探测核验登录；login 仅打开登录页（写操作需确认，不轮询），人工完成登录后用 whoami 验证。
