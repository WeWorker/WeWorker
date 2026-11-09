# Twitter/X

profile/timeline/tweets/thread/search/trending/notifications/followers/following/lists/list-tweets/likes/bookmarks/bookmark-folders/article/download 为读取（访问 x.com）；download 返回媒体 URL 清单不落盘（本运行时无文件系统），bookmarks/likes 的 --all 为纯内存分页不支持断点文件。
post/quote/reply/reply-dm 为写操作：仅支持纯文本（无本地图片附件），通过页面 UI 自动化完成；like/unlike/retweet/unretweet/bookmark/unbookmark/follow/unfollow/block/unblock/accept/hide-reply 为关系与互动写操作；mute-word 与 list-add/list-remove/list-create/list-delete（含批量）为列表与设置写操作，list-delete 需额外 confirm 参数。所有写操作不自动重放；提交结果未确认时报告超时并提示先核查是否已生效，避免重复发帖。
whoami 校验登录并读取身份；login 仅打开登录页（打开后人工完成登录再用 whoami 验证，不轮询登录状态）。followers/notifications 通过网络捕获读取 GraphQL 响应，捕获超时报错；未登录、账号受限或页面结构变化时报错而非空结果；缺字段保留 null/空串，不补造 0 或空列表。

多轮映射：帖子列表（含 device-follow、collection.posts）、通知中的真实目标帖子可继续查看回复、作者、媒体链接，或按明确意图执行互动；回复/引用需补正文。粉丝/关注列表与用户资料使用真实 screen_name，不能用显示名替代。收藏夹 ID 只进入 bookmark-folder，列表 ID 只进入 list-tweets/成员管理，不当作帖子 ID。没有目标帖的通知不提供可执行帖子动作。list-delete 保留业务 confirm=true；没有新增统一确认协议。

每条结果保留完整内容，新增简短选择标题和绑定字段。单帖媒体通过 TweetDetail 的实际 ID 提取，返回 URL 清单而不写文件。UI 互动用主时间链接确认帖子，不能因另一条帖子引用了目标链接而操作其父帖。测试使用 mock API/DOM/捕获响应，尚未证明真实发帖、列表管理或站点送达。
