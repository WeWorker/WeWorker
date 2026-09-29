# Hacker News 使用指导

top/best/new/ask/show/jobs 是六个不同的官方榜单；jobs 按来源语义没有 score/comments 字段。search 走 Algolia 公开索引（tags=story），sort=relevance/date。先用列表或搜索拿到真实数字 id，再用 read 读帖子；user 读取公开资料。所有命令都是只读公开 API，不需要登录，也不打开 news.ycombinator.com 页面。

列表命令保留来源的预取上限：先取 min(limit+10,50) 个条目再过滤已删除（deleted）、已dead 和无标题项，因此 limit 大于 50 时实际也不会超过 50 条；过滤后不足 limit 不补造。空榜单或全部条目不可用时返回明确空结果，不返回空数组冒充成功。

read 的输出首行是 POST（标题 + 自述正文 + 外链），其后是按 L0/L1… 层级缩进的评论；被 limit/depth/replies 截断的分支会输出 [+N more replies] / [+N more top-level comments] 标注。单次调用最多请求 200 个条目（含帖子本身），预算耗尽会输出明确标注行，不会无限展开。deleted/dead/null 的评论会被跳过；个别评论请求失败会计数并在末尾标注，不冒充完整。max-length 截断正文并加省略号标注。id 必须是纯数字，来自上一轮真实返回，不能猜测或拼接。POST 与评论的 author/score 缺失时保持 null（未知），真实 0 分保留 0；不把未知补成 0 或 [deleted]，只有 API 自身标记 deleted/dead 的条目才按已删除处理（此类条目直接跳过）。

## 调用与证据

普通参数使用 --key=value；复杂结构才使用 JSON。只调用本 Skill 当前 manifest 列出的命令。用户说“第二个”“刚才那条”时保留上一轮实际 id，不重新取列表位置代替实体。

接口 HTTP 错误、重定向、非法 JSON、空结果各自明确报错，不互相冒充；字段为 null 表示未知，不补 0 或空串。score/comments 缺失保持 null；user 的 karma 缺失也是 null。返回列表不等于全站完整结果，limit 是上限。失败保留 trace，不重复相同参数盲目重试。本轮证据优先于历史失败记忆；临时失败不能变成永久跳过工具的规则。

全部命令均为 read，无写操作、无确认门；也不存在登录或验证码流程。数据来自 hacker-news.firebaseio.com 与 hn.algolia.com 公开接口，查询与响应不写入公开日志。
