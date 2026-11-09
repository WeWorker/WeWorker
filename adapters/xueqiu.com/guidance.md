# 雪球

hot/hot-stock/feed/stock/kline/search/groups/watchlist/comments/earnings-date 为浏览器读取（行情、个股、K 线、讨论、自选、财报日历），访问 xueqiu.com；fund-holdings/fund-snapshot 读取 danjuanfunds.com 基金持仓与快照。whoami 校验登录并读取身份；login 仅打开登录页（写操作需确认，打开后人工完成登录再用 whoami 验证，不轮询登录状态）。行情接口有访问频率限制，触发限流时明确报错；缺字段保留 null/空串，不补造 0 或空列表。

多轮会话：search/hot-stock/watchlist通过symbol绑定行情、讨论、K线和财报日期；groups通过原pid进入watchlist，保留字符串0与负分组ID。whoami通过已验证user_id进入分组。K线与财报日期的叶子结果声明当前包缺少的后续能力，不补造日期对象操作。

## 多轮结果与后续动作

comments/feed/hot 是帖子结果，当前包缺少帖子详情、作者资料和回复/点赞命令，不能映射到股票行情。fund-holdings 返回持仓明细，但没有基金详情或申赎工具；基金代码不等于股票 symbol。fund-snapshot 已包括返回的子账户和持仓字段，当前没有子账户详情/管理动作；fund-holdings 可作为单独过滤查询。空白和 null 金额保持未知，不补成零余额。
