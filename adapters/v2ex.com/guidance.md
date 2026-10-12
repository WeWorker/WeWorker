# V2EX 社区

hot/latest/topic/member/node/nodes/replies/user 走 www.v2ex.com 固定公开 API（后台请求，禁重定向），无需登录；limit 最大 100 且不超过接口实际上限，topic/replies 只接受数字主题 ID，username/node 名只接受字母数字与 -_. 。接口明确无该主题/成员时报告 EMPTY_RESULT；对象缺 id/username 字段、非 JSON 或结构变化报告 COMMAND_EXEC，缺字段保留 null/空串，不补造 0 或空列表。
whoami 校验 A2 登录 Cookie 并读取顶栏昵称；login 仅打开登录页（写操作需确认，打开后人工完成登录再用 whoami 验证，不轮询登录状态）。me 读取余额与未读提醒，未登录、Cloudflare 挑战或身份无法识别时报错，缺失字段留空不补 0。notifications 仅在 /notifications 页面且容器存在时返回条目，被重定向或结构缺失时报错而非空列表。
daily 为写操作需确认：先导航到 /mission/daily，重试调用后读取 once 令牌并在本次确认调用内完成领取与核验；已领取直接返回已签到，挑战页或 HTTP 失败明确报错，不重复领取、不自动重放写操作。
