# 今日头条

使用 `webcli call toutiao.com.<command> --参数=值`。
hot 是新闻话题热榜；recommend 是文章推荐流，可选 __all__、news_tech、news_finance、news_world、news_sports、news_entertainment、news_military。两者 limit=1..50，公开读取不需要登录。推荐流单次返回，不承诺分页或返回条数达到 limit。

articles 使用登录的头条号创作者后台，page=1..4；不是公共新闻正文。日期保留页面 MM-DD HH:MM，不猜年份；缺少指标保留 null。先验证服务器登录状态，再读取作品列表区域。只有该区域明确显示“暂无作品”且无加载状态或其他内容时才返回空数组，仅代表当前筛选页；其他解析不到文章的情况报错。有文章路径尚未真实验收。

login 经确认后打开登录页，不等待验证码或长期轮询；完成后调用 whoami 验证。whoami 使用头条号服务器登录状态及用户信息接口验证身份，优先使用字符串账号 ID 避免精度损失，不输出 Cookie。读取命令导航由宿主继续执行。网络、验证或结构错误需要查看 trace 和页面，不能用空结果掩盖。
